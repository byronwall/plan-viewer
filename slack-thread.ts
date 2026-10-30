import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { claudeNewSessionUrl, codexNewTaskUrl } from "./codex-desktop.ts";

export type SlackMessage = { author: string; email: string; user: string; ts: string; text: string; reactions: string };
export type SlackThread = { channelName: string; messages: SlackMessage[]; fetchedAt: string };

// A permalink's channel and the thread it belongs to: `thread_ts` for a reply, else the message itself.
export function slackThreadRef(permalink: string) {
  const url = new URL(permalink);
  const [, channel, seconds, micros] = url.pathname.match(/^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/) || [];
  if (!/^[a-z0-9-]+\.slack\.com$/.test(url.hostname) || !channel) throw new Error("Not a Slack message permalink.");
  const message = `${seconds}.${micros}`;
  const thread = url.searchParams.get("thread_ts") || message;
  if (!/^\d{10}\.\d{6}$/.test(thread)) throw new Error("Bad thread_ts.");
  return { channel, thread, message, key: `${channel}/${thread}` };
}

// The connector's read_thread answer is text: a parent block and one block per reply, each headed by
// `From: Name <email> (U…)`, `Time: …` and `Message TS: …`, with an optional trailing `Reactions: …` line.
export function parseSlackThread(text: string): SlackMessage[] {
  return text.split(/^(?:=== THREAD PARENT MESSAGE ===|--- Reply \d+ of \d+ ---)$/m).slice(1).map((block) => {
    const lines = block.replace(/\n+=== THREAD REPLIES.*===\s*$/, "").trim().split("\n");
    const [, author = "", email = "", user = ""] = lines[0]?.match(/^From: (.*?)(?: <([^>]*)>)?(?: \((\w+)\))?$/) || [];
    const ts = lines.find((line) => line.startsWith("Message TS: "))?.slice(12) || "";
    const body = lines.slice(lines.findIndex((line) => line.startsWith("Message TS: ")) + 1);
    const reactions = body.at(-1)?.startsWith("Reactions: ") ? body.pop()!.slice(11) : "";
    return { author, email, user, ts, text: body.join("\n").trim(), reactions };
  }).filter((message) => message.ts);
}

// The thread as Markdown for an agent to read: one heading per message, with its time and permalink.
export function slackTranscript(thread: SlackThread, permalink: string) {
  const base = permalink.replace(/\/p\d{16}.*$/, "");
  const parent = thread.messages[0]?.ts || "";
  const lines = [`# Slack thread in ${thread.channelName || "Slack"}`, "", `Read ${thread.fetchedAt} from ${permalink}`, ""];
  for (const message of thread.messages) {
    const link = `${base}/p${message.ts.replace(".", "")}${message.ts === parent ? "" : `?thread_ts=${parent}`}`;
    lines.push(`## ${message.author} · ${new Date(Number(message.ts) * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`, "", `[permalink](${link})${message.reactions ? ` · reactions: ${message.reactions}` : ""}`, "", message.text, "");
  }
  return lines.join("\n");
}

// No Slack token here: Codex's app server (`slack.codex`, e.g. ["codex", "app-server"]) calls its Slack connector's
// tools directly. No model turn runs, so a read costs no tokens and takes a couple of seconds. Threads are cached in
// tmp/ until refreshed.
export function createSlackThreads(root: string, command: () => string[]) {
  const cachePath = join(root, "tmp", "slack-threads.json");
  const inFlight = new Map<string, Promise<SlackThread>>();
  const readCache = async () => JSON.parse(await readFile(cachePath, "utf8").catch(() => "{}")) as Record<string, SlackThread>;

  async function read(permalink: string, refresh = false) {
    const ref = slackThreadRef(permalink);
    const cached = (await readCache())[ref.key];
    if (cached && !refresh) return { ...cached, ...ref };
    if (!inFlight.has(ref.key)) inFlight.set(ref.key, fetchThread(ref).finally(() => inFlight.delete(ref.key)));
    return { ...await inFlight.get(ref.key)!, ...ref };
  }

  async function fetchThread(ref: ReturnType<typeof slackThreadRef>) {
    const [threadResult, channelResult] = await withConnector(command(), (call) => Promise.all([
      // ponytail: one page of up to 1000 messages; follow the connector's cursor if longer threads turn up.
      call("slack.slack_read_thread", { channel_id: ref.channel, message_ts: ref.thread, limit: 1000, response_format: "detailed" }),
      // The newest message is just the header carrier: `Channel: #name (C…)`, or `Channel: DM (D…)`.
      call("slack.slack_read_channel", { channel_id: ref.channel, limit: 1, response_format: "concise" }).catch(() => null),
    ]));
    const body = toolJson(threadResult);
    const messages = parseSlackThread(body.messages || "");
    if (!messages.length) throw new Error(`Slack: ${body.error || "no messages in that thread"}`);
    const channelName = (() => { try { return toolJson(channelResult).messages?.match(/^Channel: (#[\w.-]+)/)?.[1] || ""; } catch { return ""; } })();
    const thread: SlackThread = { channelName, messages, fetchedAt: new Date().toISOString() };
    const cache = await readCache();
    cache[ref.key] = thread;
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(cache));
    return thread;
  }

  // A prefilled Codex or Claude draft about the thread, opened in the planning workspace. The agent gets the thread
  // as a file (no Slack access needed) and the planning documents that cite it.
  async function discuss(app: string, permalink: string, request: string, documents: string[]) {
    if (app !== "codex" && app !== "claude") throw new Error("Unknown agent app.");
    const ref = slackThreadRef(permalink);
    const thread = (await readCache())[ref.key];
    if (!thread) throw new Error("Open the thread first so there is something to discuss.");
    const file = join(root, "tmp", "slack-threads", `${ref.channel}-${ref.thread}.md`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, slackTranscript(thread, permalink));
    const where = thread.channelName ? ` in ${thread.channelName}` : "";
    const cited = documents.length ? `\n\nPlanning documents that link it: ${documents.map((path) => `\`${path}\``).join(", ")}.` : "";
    const draft = `Let's talk through this Slack thread${where}: ${permalink}\n\nThe whole thread (${thread.messages.length} messages, read ${thread.fetchedAt}) is in \`${file}\`; read it first. Use the Slack connector only if you need something newer or outside the thread.${cited}\n\n${request.trim()}`;
    if (process.env.PLAN_VIEWER_DRY_RUN === "1") return console.log(`[dry run] ${app} draft in ${root}:\n${draft}`);
    await promisify(execFile)("/usr/bin/open", [app === "claude" ? claudeNewSessionUrl(root, draft) : codexNewTaskUrl(draft, root)]);
  }

  return { read, discuss };
}

// The connector's user search, detailed: `### Result n of m` blocks with `Name:`, `User ID:`, `Email:` and
// `Profile Pic: [Photo](url)` lines. The photo is the original upload; `_72` is Slack's small rendition.
export function parseSlackUsers(text: string) {
  return text.split(/^### Result \d+ of \d+$/m).slice(1).map((block) => {
    const field = (name: string) => block.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1].trim() || "";
    return { name: field("Name"), user: field("User ID"), email: field("Email"), avatar: (block.match(/^Profile Pic: \[[^\]]*\]\((https:[^)]+)\)/m)?.[1] || "").replace(/_original\.(\w+)$/, "_72.$1") };
  }).filter((person) => person.email);
}

// Everyone the user search finds for `query` (an email domain finds the whole company), 20 a page, one session.
export async function searchSlackPeople(command: string[], query: string) {
  return withConnector(command, async (call) => {
    const people: ReturnType<typeof parseSlackUsers> = [];
    let cursor = "";
    // ponytail: 100 pages (2,000 people) at most; raise it for a bigger workspace.
    for (let page = 0; page < 100; page++) {
      const body = JSON.parse((await call("slack.slack_search_users", { keywords: [query], limit: 20, response_format: "detailed", ...(cursor ? { cursor } : {}) })).content?.find((item: { type: string }) => item.type === "text")?.text || "{}");
      people.push(...parseSlackUsers(body.results || ""));
      cursor = String(body.pagination_info || "").match(/cursor `([^`]+)`/)?.[1] || "";
      if (!cursor) break;
    }
    return people;
  }, 600_000);
}

// A connector tool's text answer is JSON with a `messages` string (or an error).
function toolJson(result: { content?: { type: string; text?: string }[]; isError?: boolean } | null) {
  const text = result?.content?.find((item) => item.type === "text")?.text || "";
  if (!result || result.isError) throw new Error(`Slack: ${text || "read failed"}`);
  try { return JSON.parse(text) as { messages?: string; error?: string }; } catch { throw new Error(`Slack: ${text.slice(0, 200)}`); }
}

// One JSON-RPC session with `codex app-server`: initialize, an ephemeral thread (tool calls need one; no turn runs),
// then tool calls on the `codex_apps` connector server.
type ToolCall = (tool: string, args: Record<string, unknown>) => Promise<any>;
async function withConnector<T>([program, ...args]: string[], use: (call: ToolCall) => Promise<T>, timeout = 60_000) {
  if (!program) throw new Error("No Slack reader configured (slack.codex in viewer.config.json).");
  const child = spawn(program, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, (message: { result?: any; error?: { message: string } }) => void>();
  let failed: (error: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => { failed = reject; });
  child.on("error", (error) => failed(new Error(`${program}: ${error.message}`)));
  child.on("exit", (code) => failed(new Error(`${program} exited (${code}) before answering.`)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    try { const message = JSON.parse(line); pending.get(message.id)?.(message); } catch {}
  });
  let id = 0;
  const call = (method: string, params: unknown) => Promise.race([failure, new Promise<any>((resolve, reject) => {
    pending.set(++id, (message) => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  })]);
  const timer = setTimeout(() => failed(new Error("The Slack read timed out.")), timeout);
  try {
    await call("initialize", { clientInfo: { name: "plan-viewer", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    const { thread } = await call("thread/start", { ephemeral: true, cwd: tmpdir(), sandbox: "read-only", approvalPolicy: "never" });
    return await use((tool, toolArgs) => call("mcpServer/tool/call", { threadId: thread.id, server: "codex_apps", tool, arguments: toolArgs }));
  } finally {
    clearTimeout(timer);
    failure.catch(() => {});
    child.kill();
  }
}
