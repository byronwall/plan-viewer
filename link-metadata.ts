import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

// Titles and states for GitHub, Linear and Jira references, cached in the ignored tmp/ folder. Uncached keys are
// fetched before responding (one batched call per provider); stale keys answer from cache and refresh behind it.
// Credentials stay with the tools that own them: `gh`, `acli`, and the Linear key in the ignored config.toml.

const run = promisify(execFile);
const BATCH = 50;
const FRESH_MS = 30 * 60 * 1000;
const SETTLED_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_MS = 5 * 60 * 1000;
// Bump when entries gain fields; older entries still answer but refresh behind the response.
const VERSION = 2;

export type Tone = "open" | "progress" | "draft" | "done" | "closed";
// `when` dates the state (merged, closed, opened, or last updated); `pr` carries what decides whether a pull request can land.
export type PrFacts = { review: string; checks: string; mergeable: string; base: string; head: string; additions: number; deletions: number; files: number };
export type LinkMetadata = { title: string; state: string; tone: Tone; person?: string; when?: string; priority?: string; pr?: PrFacts; v?: number; fetchedAt: number };

type Cache = Record<string, LinkMetadata>;

export function createLinkMetadataStore(root: string) {
  const file = join(root, "tmp", "link-metadata.json");
  let cache: Promise<Cache> | null = null;
  const inFlight = new Map<string, Promise<void>>();
  const failedAt = new Map<string, number>();
  const load = () => (cache ??= readFile(file, "utf8").then(JSON.parse).catch(() => ({})));

  async function save() {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(await load(), null, 1));
  }

  async function refresh(keys: string[]) {
    const pending = keys.filter((key) => !inFlight.has(key) && Date.now() - (failedAt.get(key) || 0) > FAILED_MS);
    if (!pending.length) return Promise.all(keys.map((key) => inFlight.get(key))).then(() => {});
    const work = (async () => {
      const store = await load();
      const results = await Promise.allSettled([
        fetchGithub(pending.filter((key) => key.startsWith("github:"))),
        fetchLinear(pending.filter((key) => key.startsWith("linear:")), root),
        fetchJira(pending.filter((key) => key.startsWith("jira:"))),
        fetchSlack(pending.filter((key) => key.startsWith("slack:")), root),
      ]);
      for (const result of results) {
        if (result.status === "fulfilled") for (const [key, meta] of Object.entries(result.value)) store[key] = { ...meta, v: VERSION };
        else console.warn(`Link metadata lookup failed: ${result.reason instanceof Error ? result.reason.message.split("\n")[0] : result.reason}`);
      }
      for (const key of pending) if (!store[key]) failedAt.set(key, Date.now());
      await save();
    })().finally(() => pending.forEach((key) => inFlight.delete(key)));
    pending.forEach((key) => inFlight.set(key, work));
    return work;
  }

  return async function lookup(keys: string[]) {
    const wanted = [...new Set(keys.filter((key) => /^(github:[\w.-]+\/[\w.-]+(#\d+|@[0-9a-f]{7})|linear:[A-Z]+-\d+|jira:[A-Z]+-\d+|slack:[A-Z0-9]+\/\d+\.\d+(\/\d+\.\d+)?)$/.test(key)))];
    const store = await load();
    const isStale = (meta: LinkMetadata) => meta.v !== VERSION || Date.now() - meta.fetchedAt > (meta.tone === "done" || meta.tone === "closed" ? SETTLED_MS : FRESH_MS);
    const missing = wanted.filter((key) => !store[key]);
    const stale = wanted.filter((key) => store[key] && isStale(store[key]));
    if (stale.length) refresh(stale).catch(() => {});
    if (missing.length) await refresh(missing).catch(() => {});
    const channels = wanted.some((key) => key.startsWith("slack:") && !store[key]) ? await slackChannelNames(root) : new Map<string, string>();
    return Object.fromEntries(wanted.flatMap((key) => {
      if (store[key]) return [[key, store[key]]];
      // Without a token, Slack rows still get their channel from reference/slack-channels.md (and DMs from their ID).
      const channel = key.startsWith("slack:") ? key.slice("slack:".length).split("/")[0] : "";
      const name = channels.get(channel) || (channel.startsWith("D") ? "Direct message" : "");
      return name ? [[key, { title: "", state: name, tone: "open" as Tone, fetchedAt: Date.now() }]] : [];
    }));
  };
}

const chunks = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / BATCH) }, (_, i) => items.slice(i * BATCH, (i + 1) * BATCH));
const literal = (value: string) => JSON.stringify(value);

async function fetchGithub(keys: string[]) {
  const out: Cache = {};
  for (const batch of chunks(keys)) {
    const fields = "title state createdAt closedAt author { login }";
    const pull = "isDraft mergedAt reviewDecision mergeable baseRefName headRefName additions deletions changedFiles commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";
    const query = `query { ${batch.map((key, i) => {
      const [, owner, name, kind, ref] = key.match(/^github:([^/]+)\/([^#@]+)([#@])(\w+)$/)!;
      const repo = `k${i}: repository(owner: ${literal(owner)}, name: ${literal(name)})`;
      return kind === "@" ? `${repo} { object(expression: ${literal(ref)}) { ... on Commit { messageHeadline committedDate author { user { login } name } } } }`
        : `${repo} { issueOrPullRequest(number: ${ref}) { __typename ... on PullRequest { ${fields} ${pull} } ... on Issue { ${fields} } } }`;
    }).join(" ")} }`;
    // GraphQL reports unknown numbers as errors alongside partial data, so read stdout even when gh exits non-zero.
    const { stdout } = await run("gh", ["api", "graphql", "-f", `query=${query}`], { maxBuffer: 8 << 20 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout || "{}" }));
    const data = JSON.parse(stdout).data || {};
    batch.forEach((key, i) => {
      // A commit never changes, so it settles as "done"; its state is the commit date.
      const commit = data[`k${i}`]?.object;
      if (commit?.messageHeadline) {
        const date = new Date(commit.committedDate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
        out[key] = { title: commit.messageHeadline, state: date, tone: "done", person: commit.author?.user?.login || commit.author?.name, when: commit.committedDate, fetchedAt: Date.now() };
        return;
      }
      const item = data[`k${i}`]?.issueOrPullRequest;
      if (!item) return;
      const isPull = item.__typename === "PullRequest";
      const [state, tone]: [string, Tone] = item.state === "MERGED" ? ["Merged", "done"]
        : item.state === "CLOSED" ? (isPull ? ["Closed", "closed"] : ["Closed", "done"])
        : item.isDraft ? ["Draft", "draft"] : ["Open", "open"];
      const pr = isPull ? {
        review: item.reviewDecision || "", checks: item.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || "", mergeable: item.mergeable || "",
        base: item.baseRefName, head: item.headRefName, additions: item.additions, deletions: item.deletions, files: item.changedFiles,
      } : undefined;
      out[key] = { title: item.title, state, tone, person: item.author?.login, when: item.mergedAt || item.closedAt || item.createdAt, pr, fetchedAt: Date.now() };
    });
  }
  return out;
}

// Reads `KEY = "value"` from one [section] of the ignored config.toml.
async function configValue(root: string, section: string, key: string) {
  const config = await readFile(process.env.LINEAR_CONFIG_PATH || join(root, "config.toml"), "utf8").catch(() => "");
  const body = config.split(/^\s*\[/m).find((part) => part.startsWith(`${section}]`)) || "";
  return body.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1] || "";
}

export async function linearKey(root: string) {
  return process.env.LINEAR_API_KEY || configValue(root, "linear", "API_KEY");
}

async function fetchLinear(keys: string[], root: string) {
  const out: Cache = {};
  if (!keys.length) return out;
  const key = await linearKey(root);
  if (!key) throw new Error("No Linear API key in LINEAR_API_KEY or config.toml");
  const tones: Record<string, Tone> = { completed: "done", canceled: "closed", started: "progress", unstarted: "open", backlog: "open", triage: "open" };
  for (const batch of chunks(keys)) {
    const query = `query { ${batch.map((k, i) => `k${i}: issue(id: ${literal(k.slice("linear:".length))}) { title priorityLabel updatedAt state { name type } assignee { name } }`).join(" ")} }`;
    const response = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: key }, body: JSON.stringify({ query }) });
    const data = (await response.json()).data || {};
    batch.forEach((k, i) => {
      const item = data[`k${i}`];
      if (item) out[k] = { title: item.title, state: item.state?.name || "", tone: tones[item.state?.type] || "open", person: item.assignee?.name, when: item.updatedAt, priority: item.priorityLabel === "No priority" ? "" : item.priorityLabel, fetchedAt: Date.now() };
    });
  }
  return out;
}

// One unknown key fails a whole `key in (...)` query, so failing batches split until the bad key stands alone.
async function fetchJira(keys: string[]): Promise<Cache> {
  if (!keys.length) return {};
  if (keys.length > BATCH) return Object.assign({}, ...await Promise.all(chunks(keys).map(fetchJira)));
  const tones: Record<string, Tone> = { done: "done", indeterminate: "progress", new: "open" };
  const ids = keys.map((key) => key.slice("jira:".length));
  try {
    const { stdout } = await run("acli", ["jira", "workitem", "search", "--jql", `key in (${ids.join(",")})`, "--fields", "summary,status,assignee,priority,updated", "--paginate", "--json"], { maxBuffer: 16 << 20 });
    return Object.fromEntries(JSON.parse(stdout).map((item: any) => {
      const status = item.fields?.status;
      return [`jira:${item.key}`, { title: item.fields?.summary || "", state: status?.name || "", tone: tones[status?.statusCategory?.key] || "open", person: item.fields?.assignee?.displayName, when: item.fields?.updated, priority: item.fields?.priority?.name || "", fetchedAt: Date.now() }];
    }));
  } catch (error) {
    if (keys.length === 1) return {};
    const middle = Math.ceil(keys.length / 2);
    return Object.assign({}, await fetchJira(keys.slice(0, middle)), await fetchJira(keys.slice(middle)));
  }
}

// Slack needs a user token (SLACK_TOKEN or [slack] TOKEN in config.toml) with channels/groups/im/mpim history
// and read scopes plus users:read. Each message costs one call; channel and user names are memoised.
const slackNames = new Map<string, Promise<string>>();

// Hand-kept `- C0ACME0001: #channel-name` and `- D0ACME0001: @Person` lines; re-read on every lookup so edits show
// up on the next page load.
async function slackChannelNames(root: string) {
  const text = await readFile(join(root, "reference", "slack-channels.md"), "utf8").catch(() => "");
  return new Map([...text.matchAll(/^[-*][ \t]*`?([CDG][A-Z0-9]{8,})`?[ \t]*:[ \t]*(#[\w.-]+|@[^\n]*[^\s])/gm)].map(([, id, name]) => [id, name] as [string, string]));
}

// Resolve every name before returning replacement Markdown; failed refreshes leave the file intact.
export async function refreshSlackChannels(root: string, text: string, linkedIds: string[]) {
  const token = process.env.SLACK_TOKEN || await configValue(root, "slack", "TOKEN");
  if (!token) throw new Error("No Slack token in SLACK_TOKEN or config.toml [slack] TOKEN");
  const line = /^([-*][ \t]*`?([CG][A-Z0-9]{8,})`?[ \t]*:)[^\n]*$/gm;
  const listedIds = [...text.matchAll(line)].map((match) => match[2]);
  const names = new Map<string, string>();
  for (const id of new Set([...listedIds, ...linkedIds])) {
    const response = await fetch(`https://slack.com/api/conversations.info?${new URLSearchParams({ channel: id })}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Slack channel ${id}: HTTP ${response.status}`);
    const body = await response.json();
    if (!body.ok) throw new Error(`Slack channel ${id}: ${body.error || "lookup failed"}`);
    if (body.channel?.id !== id || !/^[\w.-]+$/.test(body.channel?.name || "")) throw new Error(`Slack channel ${id}: invalid channel response`);
    names.set(id, `#${body.channel.name}`);
  }
  const updated = text.replace(line, (_, prefix, id) => `${prefix} ${names.get(id)}`);
  const added = [...names.keys()].filter((id) => !listedIds.includes(id));
  return added.length ? `${updated.trimEnd()}\n${added.map((id) => `- ${id}: ${names.get(id)}`).join("\n")}\n` : updated;
}

async function fetchSlack(keys: string[], root: string) {
  const out: Cache = {};
  if (!keys.length) return out;
  const token = process.env.SLACK_TOKEN || await configValue(root, "slack", "TOKEN");
  if (!token) throw new Error("No Slack token in SLACK_TOKEN or config.toml [slack] TOKEN");
  const call = async (method: string, params: Record<string, string>) => {
    const response = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    if (!body.ok) throw new Error(`Slack ${method}: ${body.error}`);
    return body;
  };
  const name = (kind: "channel" | "user", id: string) => {
    if (!slackNames.has(id)) slackNames.set(id, (kind === "channel"
      ? call("conversations.info", { channel: id }).then(async ({ channel: info }) => info.is_im ? await name("user", info.user).then((person) => person ? `@${person}` : "Direct message")
        // Group DMs are named `mpdm-ana--ben--cy-1` after their members.
        : info.is_mpim ? info.name.replace(/^mpdm-|-\d+$/g, "").split("--").map((member: string) => `@${member}`).join(", ")
        : info.name ? `#${info.name}` : "Group message")
      : call("users.info", { user: id }).then((body) => body.user.real_name || body.user.name)).catch(() => ""));
    return slackNames.get(id)!;
  };
  await Promise.all(keys.map(async (key) => {
    const [channel, ts, threadTs] = key.slice("slack:".length).split("/");
    try {
      const body = threadTs
        ? await call("conversations.replies", { channel, ts: threadTs, oldest: ts, inclusive: "true", limit: "2" })
        : await call("conversations.history", { channel, latest: ts, inclusive: "true", limit: "1" });
      const message = body.messages?.find((candidate: { ts: string }) => candidate.ts === ts);
      if (!message) return;
      const text = String(message.text || "").replace(/<@(\w+)>/g, "@someone").replace(/<([^|>]+)\|([^>]+)>/g, "$2").replace(/<([^>]+)>/g, "$1").split("\n").find((line: string) => line.trim()) || "";
      out[key] = { title: text.length > 160 ? `${text.slice(0, 157)}…` : text, state: await name("channel", channel) || (threadTs ? "Thread" : "Message"), tone: "open", person: message.user ? await name("user", message.user) : message.username, fetchedAt: Date.now() };
    } catch {
      // Missing scopes or deleted messages leave the permalink's date-and-text fallback in place.
    }
  }));
  return out;
}
