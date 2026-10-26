// One identity per person across GitHub, Jira, Linear and Slack, so every avatar shows the same picture.
// Identifiers (`e:` email, `n:` normalized name, `l:` GitHub login) are joined whenever one source names two of them
// together: a commit's author email, name and login; a Linear user's email and names; a Slack profile's email and
// names; and `people` in viewer.config.json. Each group's picture is its Slack photo, else its GitHub avatar, else its
// Linear avatar. Cached in the workspace's tmp/people-cache.json and rebuilt in the background once a day.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./public/config.js";
import { linearClient } from "./linear.ts";

const exec = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const COMMIT_PAGES = 3; // ponytail: the last 300 commits per repo; people who haven't committed lately fall back to Linear or Slack

export type Person = { keys: string[]; login: string; avatar: string; name: string };
type Source = { ids: string[]; login?: string; avatar?: string; slack?: string; name?: string };

export const normalName = (name = "") => name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
const ids = ({ emails = [], names = [], logins = [] }: { emails?: string[]; names?: string[]; logins?: string[] }) => [
  ...emails.filter(Boolean).map((email) => `e:${email.toLowerCase()}`),
  ...emails.filter(Boolean).map((email) => email.match(/^(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$/i)).filter(Boolean).map((match) => `l:${match![1].toLowerCase()}`),
  ...names.map(normalName).filter((name) => name.includes(" ")).map((name) => `n:${name}`), // one-word names are too ambiguous to join on
  ...logins.filter(Boolean).map((login) => `l:${login.toLowerCase()}`),
];

// Union-find over identifiers; each group keeps the best login, picture and display name any source gave it.
export function reconcile(sources: Source[]): Person[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => { if (!parent.has(id)) parent.set(id, id); const up = parent.get(id)!; return up === id ? id : (parent.set(id, find(up)), parent.get(id)!); };
  for (const source of sources) for (const id of source.ids.slice(1)) parent.set(find(id), find(source.ids[0]));
  const groups = new Map<string, Person & { slack: string; linear: string }>();
  for (const source of sources) {
    if (!source.ids.length) continue;
    const root = find(source.ids[0]);
    const group = groups.get(root) || { keys: [], login: "", avatar: "", name: "", slack: "", linear: "" };
    group.keys.push(...source.ids);
    group.login ||= source.login || "";
    if (source.slack) group.slack ||= source.slack;
    else if (source.avatar) group.linear ||= source.avatar;
    group.name ||= source.name || "";
    groups.set(root, group);
  }
  return [...groups.values()].map(({ keys, login, slack, linear, name }) => ({
    keys: [...new Set(keys)], login, name,
    avatar: slack || (login ? `https://github.com/${encodeURIComponent(login)}.png?size=64` : linear),
  })).filter((person) => person.avatar);
}

async function githubSources(repos: () => Promise<string[]>, slug: (repo: string) => Promise<string>) {
  const out: Source[] = [];
  for (const repo of await repos()) {
    const name = await slug(repo).catch(() => "");
    if (!name) continue;
    for (let page = 1; page <= COMMIT_PAGES; page++) {
      const { stdout } = await exec("gh", ["api", `repos/${name}/commits?per_page=100&page=${page}`, "--jq", "[.[] | {login: .author.login, email: .commit.author.email, name: .commit.author.name}]"], { maxBuffer: 16 << 20 }).catch(() => ({ stdout: "[]" }));
      const commits = JSON.parse(stdout || "[]");
      for (const commit of commits) if (commit.login && !/\[bot\]$/.test(commit.login)) out.push({ ids: ids({ logins: [commit.login], emails: [commit.email], names: [commit.name] }), login: commit.login, name: commit.name });
      if (commits.length < 100) break;
    }
  }
  return out;
}

async function linearSources(root: string) {
  const data = await linearClient(root)("query { users(first: 250, includeDisabled: true) { nodes { name displayName email avatarUrl } } }", {}).catch(() => null);
  return (data?.users.nodes || []).map((user: any) => ({ ids: ids({ emails: [user.email], names: [user.name, user.displayName] }), avatar: user.avatarUrl || "", name: user.name }));
}

async function slackSources(root: string) {
  const token = process.env.SLACK_TOKEN || await readFile(process.env.LINEAR_CONFIG_PATH || join(root, "config.toml"), "utf8").then((text) => (text.split(/^\s*\[/m).find((part) => part.startsWith("slack]")) || "").match(/^\s*TOKEN\s*=\s*"([^"]+)"/m)?.[1] || "", () => "");
  if (!token) return [];
  const out: Source[] = [];
  let cursor = "";
  do {
    const response = await fetch(`https://slack.com/api/users.list?${new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) })}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const body = await response?.json().catch(() => null);
    if (!body?.ok) break;
    for (const user of body.members) if (!user.is_bot && !user.deleted && user.profile?.email) out.push({ ids: ids({ emails: [user.profile.email], names: [user.real_name, user.profile.display_name] }), slack: user.profile.image_72 || "", name: user.real_name });
    cursor = body.response_metadata?.next_cursor || "";
  } while (cursor);
  return out;
}

// `people` in viewer.config.json: [{ names, emails, github, avatar }] for anyone the sources can't join on their own.
const configSources = (): Source[] => (config().people || []).map((entry: any) => ({ ids: ids({ emails: entry.emails, names: entry.names, logins: entry.github ? [entry.github] : [] }), login: entry.github || "", slack: entry.avatar || "", name: entry.names?.[0] || "" }));

export function createPeople(root: string, { repos, slug }: { repos: () => Promise<string[]>; slug: (repo: string) => Promise<string> }) {
  const file = join(root, "tmp", "people-cache.json");
  let cache: { at: number; people: Person[] } | null = null;
  let building: Promise<void> | null = null;
  const build = () => building ||= (async () => {
    const sources = [...configSources(), ...await slackSources(root), ...await githubSources(repos, slug), ...await linearSources(root)];
    cache = { at: Date.now(), people: reconcile(sources) };
    await mkdir(join(root, "tmp"), { recursive: true });
    await writeFile(file, JSON.stringify(cache));
  })().catch(() => {}).finally(() => { building = null; });
  // Answers from the cache at once; a missing cache waits for the first build, a stale one rebuilds behind the response.
  return async function people() {
    cache ||= await readFile(file, "utf8").then(JSON.parse, () => null);
    if (!cache) await build();
    else if (Date.now() - cache.at > DAY_MS) build();
    return { people: cache?.people || [] };
  };
}
