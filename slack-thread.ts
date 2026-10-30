import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export type SlackMessage = { author: string; email: string; user: string; ts: string; text: string; reactions: string };
export type SlackThread = { messages: SlackMessage[]; fetchedAt: string };

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

// No Slack token here: Codex's app server (`slack.codex`, e.g. ["codex", "app-server"]) calls its Slack connector's
// read_thread tool directly. No model turn runs, so a read costs no tokens and takes a couple of seconds. Threads are
// cached in tmp/ until refreshed.
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
    // ponytail: one page of up to 1000 messages; follow the connector's cursor if longer threads turn up.
    const result = await callTool(command(), "slack.slack_read_thread", { channel_id: ref.channel, message_ts: ref.thread, limit: 1000, response_format: "detailed" });
    const text = result.content?.find((item: { type: string }) => item.type === "text")?.text || "";
    if (result.isError) throw new Error(`Slack: ${text || "read failed"}`);
    let body: { messages?: string; error?: string };
    try { body = JSON.parse(text); } catch { throw new Error(`Slack: ${text.slice(0, 200)}`); }
    const messages = parseSlackThread(body.messages || "");
    if (!messages.length) throw new Error(`Slack: ${body.error || "no messages in that thread"}`);
    const thread: SlackThread = { messages, fetchedAt: new Date().toISOString() };
    const cache = await readCache();
    cache[ref.key] = thread;
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(cache));
    return thread;
  }

  return { read };
}

// One JSON-RPC session with `codex app-server`: initialize, an ephemeral thread (tool calls need one; no turn runs),
// then the tool call on the `codex_apps` connector server.
async function callTool([program, ...args]: string[], tool: string, toolArgs: Record<string, unknown>) {
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
  const timer = setTimeout(() => failed(new Error("The Slack read timed out.")), 60_000);
  try {
    await call("initialize", { clientInfo: { name: "plan-viewer", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    const { thread } = await call("thread/start", { ephemeral: true, cwd: tmpdir(), sandbox: "read-only", approvalPolicy: "never" });
    return await call("mcpServer/tool/call", { threadId: thread.id, server: "codex_apps", tool, arguments: toolArgs });
  } finally {
    clearTimeout(timer);
    failure.catch(() => {});
    child.kill();
  }
}
