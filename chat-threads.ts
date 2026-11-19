import { execFile } from "node:child_process";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const idPattern = new RegExp(`^${uuid}$`, "i");
const claudeDesktopId = new RegExp(`^local_${uuid}$`, "i");
const rolloutName = new RegExp(`/sessions/\\d{4}/\\d{2}/\\d{2}/rollout-[^/]+-(${uuid})\\.jsonl$`, "i");
const claudeTranscript = new RegExp(`^(${uuid})\\.jsonl$`, "i");
const historyLimit = 50;

type Provider = "Codex" | "Claude";
// parent: the thread that spawned this one (a Codex subagent or a Claude side session). kind says how it started.
type Usage = { tokens: number; input: number; cached: number; output: number };
type Task = { kind: "command" | "agent"; label: string };
type AgentDetails = { model?: string; usage?: Usage; cliId?: string; live?: boolean; tasks?: Task[]; effort?: string; role?: string; nickname?: string; parent?: string; kind?: "subagent" | "automation" | "agent";
  tokens?: number | null; branch?: string; startedAt?: number };
type Thread = AgentDetails & {
  id: string;
  provider: Provider;
  source: string;
  title: string;
  cwd: string;
  updatedAt: number;
  // background: the turn ended but tasks it started in the background still run.
  state: "active" | "waiting" | "background" | "completed" | "interrupted";
  url: string | null;
};
type Inventory = { active: Thread[]; completed: Thread[]; issues: string[] };
type JSONObject = Record<string, any>;

type CodexIndexRow = AgentDetails & {
  id: string;
  path: string;
  cwd: string;
  title: string;
  updatedAt: number;
  source: string;
  originator: string;
  origin?: string;
};

type Turn = { state: Thread["state"]; updatedAt: number };

const object = (line: string): JSONObject => JSON.parse(line);
const string = (value: unknown) => typeof value === "string" ? value : "";
const displayTitle = (value: string, fallback: string) => {
  const title = value.trim().split(/\r?\n/, 1)[0];
  return title.length > 160 ? `${title.slice(0, 159).trimEnd()}…` : title || fallback;
};

async function readObject(file: string) {
  try { return object(await readFile(file, "utf8")); }
  catch (error: any) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function entries(path: string) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function children(path: string, directories: boolean, name: RegExp) {
  return (await entries(path)).filter(entry => (directories ? entry.isDirectory() : entry.isFile()) && name.test(entry.name))
    .map(entry => join(path, entry.name));
}

export function openAgentFiles(output: string) {
  const rollouts = new Map<string, string>();
  const claudePids = new Set<number>();
  let pid = 0;
  let codex = false;
  let writable = false;
  let descriptor = false;
  // lsof -F emits records per process and file. A read-only descriptor can belong to history lookup.
  for (const line of output.split("\n")) {
    const value = line.slice(1);
    switch (line[0]) {
      case "p": pid = Number(value); codex = false; break;
      case "c":
        codex = /^codex/i.test(value);
        if (/^claude(?:-code)?$/i.test(value)) claudePids.add(pid);
        break;
      case "f": descriptor = /^\d+$/.test(value); writable = false; break;
      case "a": writable = value === "w" || value === "u"; break;
      case "n": {
        const id = codex && descriptor && writable && rolloutName.exec(value)?.[1];
        if (id) rollouts.set(id, value);
        break;
      }
    }
  }
  return { rollouts, claudePids };
}

async function liveFiles() {
  try {
    const { stdout } = await run("/usr/sbin/lsof", ["-a", "-u", String(process.getuid?.()), "-c", "/^(codex|claude)/i", "-Fpcfan"], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
    return openAgentFiles(stdout);
  } catch (error: any) {
    if (error.code === 1 && !error.stderr) return openAgentFiles(error.stdout || "");
    throw error;
  }
}

const turnStates: Record<string, Turn["state"]> = {
  task_started: "active", task_complete: "completed", turn_aborted: "interrupted",
};

async function lastCodexTurn(path: string, size: number): Promise<Turn | null> {
  const file = await open(path, "r");
  try {
    // Walk backwards to the most recent turn edge. Keep long tool results as bytes and only decode candidate events.
    const chunkSize = 64 * 1024;
    let partial = Buffer.alloc(0);
    for (let end = size; end > 0;) {
      const start = Math.max(0, end - chunkSize);
      const chunk = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, start);
      const block = Buffer.concat([chunk.subarray(0, bytesRead), partial]);
      let lineEnd = block.length;
      while (lineEnd > 0) {
        const newline = lineEnd > 1 ? block.lastIndexOf(10, lineEnd - 2) : -1;
        if (newline === -1 && start > 0) break;
        const line = block.subarray(newline + 1, lineEnd);
        const prefix = line.subarray(0, 256);
        if (prefix.includes('"type":"event_msg"')) {
          const header = prefix.toString();
          const edge = /"type":"event_msg","payload":\{"type":"(task_started|task_complete|turn_aborted)"/.exec(header)?.[1];
          const updatedAt = Date.parse(/"timestamp":"([^"]+)"/.exec(header)?.[1] || "");
          if (edge && Number.isFinite(updatedAt)) return { state: turnStates[edge], updatedAt };
        }
        lineEnd = newline + 1;
      }
      // If a record spans a chunk, retain its beginning next time. Only event records of interest need decoding.
      partial = block.subarray(0, Math.min(lineEnd, 300));
      end = start;
    }
    return null;
  } finally { await file.close(); }
}

async function fileInfo(path: string) {
  try { return await stat(path); }
  catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}

async function firstRecord(path: string) {
  const file = await open(path, "r");
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(128 * 1024), 0, 128 * 1024, 0);
    return buffer.subarray(0, bytesRead).toString().split("\n");
  } finally { await file.close(); }
}

async function codexIndex(home: string) {
  const databases = await children(home, false, /^state_\d+\.sqlite$/);
  const database = databases.sort((a, b) => Number(basename(b).match(/\d+/)?.[0]) - Number(basename(a).match(/\d+/)?.[0]))[0];
  if (!database) return [] as CodexIndexRow[];
  const open = (file: string, sql: string) => run("/usr/bin/sqlite3", ["-readonly", "-json", "-cmd", ".timeout 1000", file, sql], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
  // A read-only open fails (SQLITE_CANTOPEN) when the database is in WAL mode and has no -shm file to share, as after Codex
  // quits. With no -wal file there are no pending writes, so reading the file as immutable is safe then.
  const query = (sql: string) => open(database, sql).catch(async (error) => {
    if (error.code !== 14 || await fileInfo(`${database}-wal`)) throw error;
    return open(`file:${encodeURI(database)}?immutable=1`, sql);
  });
  // Columns arrive independently across Codex releases. Select only fields this index supports.
  const schema = await query("PRAGMA table_info(threads)");
  const columns = new Set(JSON.parse(schema.stdout || "[]").map((column: JSONObject) => column.name));
  const field = (name: string) => columns.has(name) ? name : "NULL";
  const result = await query(`
    SELECT id, rollout_path AS path, cwd, substr(coalesce(nullif(${field("name")}, ''), title), 1, 400) AS title,
      updated_at * 1000 AS updatedAt, source, ${field("originator")} AS originator, ${field("tokens_used")} AS tokens,
      ${field("model")} AS model, ${field("agent_role")} AS role, ${field("git_branch")} AS branch,
      ${field("reasoning_effort")} AS effort, ${field("agent_nickname")} AS nickname, ${field("thread_source")} AS origin,
      ${columns.has("created_at") ? "created_at * 1000" : "NULL"} AS startedAt
    FROM threads WHERE archived = 0 AND source NOT LIKE '%"guardian"%'
    ORDER BY updated_at DESC`);
  return JSON.parse(result.stdout || "[]") as CodexIndexRow[];
}

// A subagent's source is JSON naming its parent thread and the path its orchestrator gave it.
function spawn(source: string) {
  if (!source.includes('"thread_spawn"')) return null;
  try { return JSON.parse(source).subagent?.thread_spawn as JSONObject; } catch { return null; }
}

async function codexThreads(home: string, rollouts: Map<string, string> | undefined, turns: Map<string, { key: string; turn: Turn | null }>) {
  const index = await codexIndex(home).then(rows => ({ rows, issue: "" }), () => ({ rows: [], issue: "Codex history is unavailable." }));
  const rows = new Map(index.rows.filter(row => idPattern.test(row.id)).map(row => [row.id, row]));
  const active: Thread[] = [];
  const completed: Thread[] = [];
  async function load(id: string) {
    const live = rollouts?.get(id);
    let row = rows.get(id);
    const path = live || row?.path;
    if (!path) return null;
    const info = await fileInfo(path);
    if (!info?.isFile()) return null;
    if (!row) {
      const meta = await firstRecord(path).then(lines => object(lines[0]).payload).catch(() => null);
      if (meta?.id !== id) return null;
      row = { id, path, cwd: string(meta.cwd), title: "", branch: string(meta.git?.branch), source: JSON.stringify(meta.source) || "", originator: string(meta.originator), updatedAt: info.mtimeMs };
    }
    if (row.source.includes('"guardian"')) return null;
    const key = `${info.size}:${info.mtimeMs}`;
    const cached = turns.get(path);
    const turn = cached?.key === key ? cached.turn : await lastCodexTurn(path, info.size).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    turns.set(path, { key, turn });
    if (!turn || (turn.state === "active" && !rollouts)) return null;
    const state = turn.state === "active" && !live ? "interrupted" : turn.state;
    const source = row.source === "exec" || ["codex_exec", "codex-tui"].includes(row.originator) || row.source === "cli" ? "CLI"
      : row.originator === "Codex Desktop" ? "Desktop" : "Local";
    const spawned = spawn(row.source);
    const role = row.role || string(spawned?.agent_role) || string(spawned?.agent_path).split("/").filter(Boolean).at(-1) || "";
    const kind = spawned || row.source.includes('"subagent"') ? "subagent" : row.origin === "automation" ? "automation" : row.origin === "agent_created_thread" ? "agent" : undefined;
    const thread: Thread = { id, provider: "Codex", source, model: row.model || undefined, effort: row.effort || undefined, role, nickname: row.nickname || string(spawned?.agent_nickname) || undefined,
      parent: string(spawned?.parent_thread_id) || undefined, kind, tokens: row.tokens, branch: row.branch, startedAt: Number(row.startedAt) || undefined,
      title: displayTitle(row.title || role.replaceAll("_", " "), basename(row.cwd) || "Codex thread"), cwd: row.cwd,
      updatedAt: state === "active" ? info.mtimeMs : turn.updatedAt, state, url: `codex://threads/${id}` };
    (state === "active" ? active : completed).push(thread);
    return thread;
  }
  // Live threads first, then the latest finished top-level threads, then the subagents of everything listed.
  // Subagents never count toward the history limit, so an orchestrator's workers cannot push its siblings out.
  const listed = new Set<string>();
  for (const id of rollouts?.keys() || []) if (await load(id)) listed.add(id);
  let roots = 0;
  for (const [id, row] of rows) {
    if (roots >= historyLimit) break;
    if (listed.has(id) || spawn(row.source) || row.source.includes('"subagent"')) continue;
    const thread = await load(id);
    if (!thread) continue;
    listed.add(id);
    if (thread.state !== "active") roots++;
  }
  for (let depth = 0, added = true; added && depth < 4; depth++) {
    added = false;
    for (const [id, row] of rows) {
      const parent = spawn(row.source)?.parent_thread_id;
      if (listed.has(id) || !parent || !listed.has(parent)) continue;
      if (await load(id)) { listed.add(id); added = true; }
    }
  }
  return { threads: [...active, ...completed], issue: index.issue };
}

async function claudeDesktopThreads(root: string) {
  const accounts = await children(root, true, /./);
  const groups = (await Promise.all(accounts.map(path => children(path, true, /./)))).flat();
  const paths = (await Promise.all(groups.map(path => children(path, false, /^local_[\w-]+\.json$/)))).flat();
  // Bound file concurrency when a Desktop history has thousands of entries.
  const sessions = new Map<string, JSONObject>();
  for (let i = 0; i < paths.length; i += 32) {
    for (const session of await Promise.all(paths.slice(i, i + 32).map(readObject))) {
      if (session && claudeDesktopId.test(string(session.sessionId))) sessions.set(session.sessionId, session);
    }
  }
  return sessions;
}

async function claudeCliHistory(config: string, known: Set<string>) {
  const projects = await children(join(config, "projects"), true, /./);
  const transcripts = (await Promise.all(projects.map(path => children(path, false, claudeTranscript)))).flat()
    .map(path => ({ id: basename(path, ".jsonl"), path })).filter(({ id }) => !known.has(id));
  const candidates = [];
  for (let i = 0; i < transcripts.length; i += 32) {
    const batch = transcripts.slice(i, i + 32);
    const info = await Promise.all(batch.map(({ path }) => fileInfo(path)));
    for (const [index, file] of info.entries()) {
      if (file?.size) candidates.push({ ...batch[index], time: file.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.time - a.time);
  const history: Thread[] = [];
  for (const { id, path, time } of candidates) {
    if (history.length >= historyLimit) break;
    const lines = await firstRecord(path).catch(() => []);
    let cwd = "";
    let title = "";
    for (const line of lines) {
      try {
        const event = object(line);
        if (event.type === "custom-title" || event.type === "ai-title") title ||= string(event.customTitle || event.aiTitle);
        if (event.type !== "user" || event.isSidechain || event.isMeta) continue;
        cwd ||= string(event.cwd);
        const content = event.message?.content;
        const prompt = typeof content === "string" ? content : Array.isArray(content) ? string(content.find(item => item?.type === "text")?.text) : "";
        if (!title && prompt && !prompt.startsWith("<")) title = prompt;
      } catch { /* The last line of the bounded read can be incomplete. */ }
    }
    if (!cwd) continue;
    history.push({ id, cliId: id, provider: "Claude", source: "CLI", title: displayTitle(title, basename(cwd) || "Claude Code session"), cwd,
      updatedAt: time, state: "completed", url: `claude://resume?session=${id}` });
  }
  return history;
}

function claudeState(row: JSONObject): Thread["state"] {
  if (row.status === "idle") return "completed";
  return /^waiting/.test(string(row.status)) ? "waiting" : "active";
}

async function claudeThreads(config: string, desktopRoot: string, pids: Set<number>) {
  const [sessions, records] = await Promise.all([
    claudeDesktopThreads(desktopRoot),
    children(join(config, "sessions"), false, /^\d+\.json$/).then(paths => Promise.all(paths.map(readObject))),
  ]);
  const live = new Map<string, JSONObject>();
  for (const row of records) {
    if (row && idPattern.test(string(row.sessionId)) && pids.has(row.pid) && (!row.pidDomain || row.pidDomain === process.platform)) live.set(row.sessionId, row);
  }
  const threads: Thread[] = [];
  const known = new Set(live.keys());
  for (const session of sessions.values()) {
    const cliId = string(session.cliSessionId);
    known.add(cliId);
    const row = live.get(cliId);
    if (session.isArchived && !row) continue;
    const state = row ? claudeState(row) : "completed";
    if (state === "completed" && !session.completedTurns && !session.lastTurnEdgeAt) continue;
    const cwd = string(session.cwd || row?.cwd);
    const parent = string(session.spawnedFrom?.sessionId);
    threads.push({ id: session.sessionId, cliId, live: !!row, provider: "Claude", source: "Desktop", cwd, state, model: string(session.model), effort: string(session.effort) || undefined,
      parent: parent || undefined, kind: parent ? "agent" : undefined, startedAt: Number(session.createdAt) || undefined,
      title: displayTitle(string(session.title || row?.name), basename(cwd) || "Claude Code session"),
      updatedAt: Number(row?.updatedAt || session.lastActivityAt || session.createdAt) || 0,
      url: `claude://claude.ai/epitaxy/${session.sessionId}` });
    live.delete(cliId);
  }
  for (const row of live.values()) {
    const state = claudeState(row);
    const desktopId = claudeDesktopId.test(string(row.hostSessionId)) ? row.hostSessionId : "";
    const cwd = string(row.cwd);
    threads.push({ id: desktopId || row.sessionId, cliId: row.sessionId, live: true, provider: "Claude", source: desktopId ? "Desktop" : "CLI", cwd, state,
      title: displayTitle(string(row.name), basename(cwd) || "Claude Code session"), updatedAt: Number(row.updatedAt || row.startedAt) || 0, startedAt: Number(row.startedAt) || undefined,
      url: desktopId ? `claude://claude.ai/epitaxy/${desktopId}` : null });
  }
  return [...threads, ...await claudeCliHistory(config, known)];
}

// Claude Code records each reply's usage in its transcript. Every content block of a reply repeats the same usage, so
// count each message ID once. Transcripts only grow, so each read resumes where the last one stopped.
// The same pass tracks background tasks: a tool call with run_in_background starts one, and the <task-notification>
// naming its tool call ID (or an error result for it) ends it.
// TaskStop (or KillShell) ends one by the short ID its launch result gave, and writes no notification.
type UsageCache = Map<string, Usage & { offset: number; ids: Set<string>; tasks: Map<string, Task>; aliases: Map<string, string> }>;
async function transcriptUsage(path: string, cache: UsageCache) {
  const info = await fileInfo(path);
  if (!info?.isFile()) return null;
  let entry = cache.get(path);
  if (!entry || info.size < entry.offset) entry = { tokens: 0, input: 0, cached: 0, output: 0, offset: 0, ids: new Set(), tasks: new Map(), aliases: new Map() };
  cache.set(path, entry);
  if (info.size === entry.offset) return entry;
  const file = await open(path, "r");
  try {
    let partial = "";
    for (let position = entry.offset; position < info.size;) {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(Math.min(1 << 20, info.size - position)), 0, Math.min(1 << 20, info.size - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      const lines = (partial + buffer.subarray(0, bytesRead).toString()).split("\n");
      partial = lines.pop() || "";
      for (const line of lines) {
        if (line.includes("<task-notification>")) {
          for (const match of line.matchAll(/<tool-use-id>(toolu_\w+)<\/tool-use-id>/g)) entry.tasks.delete(match[1]);
          for (const match of line.matchAll(/<task-id>([\w-]+)<\/task-id>/g)) entry.tasks.delete(entry.aliases.get(match[1]) || "");
          continue;
        }
        if (line.includes('"tool_result"') && line.includes('"type":"user"')) {
          try {
            for (const part of object(line).message?.content || []) {
              if (part?.type !== "tool_result" || !entry.tasks.has(part.tool_use_id)) continue;
              if (part.is_error) { entry.tasks.delete(part.tool_use_id); continue; }
              const text = typeof part.content === "string" ? part.content : JSON.stringify(part.content);
              const alias = /running in background with ID: ([\w-]+)/.exec(text)?.[1] || /agentId: ([\w-]+)/.exec(text)?.[1];
              if (alias) entry.aliases.set(alias, part.tool_use_id);
            }
          } catch { /* retried next time */ }
          continue;
        }
        if (!line.includes('"usage"') || !line.includes('"type":"assistant"')) continue;
        try {
          const message = object(line).message;
          if (line.includes('"TaskStop"') || line.includes('"KillShell"')) {
            for (const part of message?.content || []) {
              if (part?.type === "tool_use" && ["TaskStop", "KillShell"].includes(part.name)) entry.tasks.delete(entry.aliases.get(string(part.input?.task_id || part.input?.shell_id)) || "");
            }
          }
          if (line.includes('"run_in_background":true')) {
            for (const part of message?.content || []) {
              if (part?.type !== "tool_use" || part.input?.run_in_background !== true) continue;
              const kind = part.name === "Bash" ? "command" : "agent";
              entry.tasks.set(part.id, { kind, label: displayTitle(string(part.input.description || part.input.command || part.name), part.name) });
            }
          }
          const usage = message?.usage;
          if (!usage || !message.id || entry.ids.has(message.id)) continue;
          entry.ids.add(message.id);
          const cached = (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
          const input = (Number(usage.input_tokens) || 0) + cached;
          const output = Number(usage.output_tokens) || 0;
          entry.input += input; entry.cached += cached; entry.output += output; entry.tokens += input + output;
        } catch { /* a line written mid-read is retried next time */ }
      }
    }
    // Stop before a line still being written, so the next read starts at its beginning.
    entry.offset = info.size - Buffer.byteLength(partial);
  } finally { await file.close(); }
  return entry;
}

async function claudeUsage(threads: Thread[], config: string, cache: UsageCache) {
  const projects = join(config, "projects");
  let index: Map<string, string> | null = null;
  for (const thread of threads) {
    const { cliId: id, live } = thread;
    delete thread.cliId;
    delete thread.live;
    if (!id) continue;
    let path = join(projects, thread.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
    if (!await fileInfo(path)) {
      // A session that changed folder keeps its transcript under the folder it started in.
      index ||= new Map((await Promise.all((await children(projects, true, /./)).map(dir => children(dir, false, claudeTranscript)))).flat()
        .map(file => [basename(file, ".jsonl"), file]));
      path = index.get(id) || "";
      if (!path) continue;
    }
    const usage = await transcriptUsage(path, cache).catch(() => null);
    // Background tasks die with their session, so only a running session can be waiting on them.
    if (live && usage?.tasks.size && thread.state === "completed") {
      thread.state = "background";
      thread.tasks = [...usage.tasks.values()];
    }
    if (usage?.tokens) {
      thread.tokens = usage.tokens;
      thread.usage = { tokens: usage.tokens, input: usage.input, cached: usage.cached, output: usage.output };
    }
  }
}

export function createChatThreads({
  home = homedir(), codexHome = process.env.CODEX_HOME || join(home, ".codex"),
  claudeConfig = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), readLiveFiles = liveFiles,
} = {}) {
  const desktop = join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
  const turns = new Map<string, { key: string; turn: Turn | null }>();
  const usage: UsageCache = new Map();
  let pending: Promise<Inventory> | null = null;
  let cached: Inventory | null = null;
  let refreshed = 0;
  async function scan(): Promise<Inventory> {
    if (process.platform !== "darwin") return { active: [], completed: [], issues: ["Chat Threads is available on macOS."] };
    const issues: string[] = [];
    const files = await readLiveFiles().catch(() => {
      issues.push("Live activity is unavailable.");
      return null;
    });
    const [codex, claude] = await Promise.allSettled([
      codexThreads(codexHome, files?.rollouts, turns), claudeThreads(claudeConfig, desktop, files?.claudePids || new Set()),
    ]);
    const threads: Thread[] = [];
    if (codex.status === "fulfilled") {
      threads.push(...codex.value.threads);
      if (codex.value.issue) issues.push(codex.value.issue);
    } else issues.push("Codex threads are unavailable.");
    if (claude.status === "fulfilled") threads.push(...claude.value);
    else issues.push("Claude threads are unavailable.");
    threads.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const finished = (thread: Thread) => thread.state === "completed" || thread.state === "interrupted";
    // History keeps the latest top-level threads per app, plus every thread spawned from one that is listed.
    const kept = new Set(threads.filter(thread => !finished(thread)).map(thread => thread.id));
    for (const provider of ["Codex", "Claude"]) {
      for (const thread of threads.filter(thread => thread.provider === provider && finished(thread) && !thread.parent).slice(0, historyLimit)) kept.add(thread.id);
    }
    for (let depth = 0, size = -1; size !== kept.size && depth < 4; depth++) {
      size = kept.size;
      for (const thread of threads) if (thread.parent && kept.has(thread.parent)) kept.add(thread.id);
    }
    // A spawned thread whose parent is not listed (an older orchestrator) stays only while it is live.
    const shown = threads.filter(thread => kept.has(thread.id));
    for (const thread of threads) if (!kept.has(thread.id)) { delete thread.cliId; delete thread.live; }
    await claudeUsage(shown.filter(thread => thread.provider === "Claude"), claudeConfig, usage);
    return { active: shown.filter(thread => !finished(thread)), completed: shown.filter(finished), issues };
  }
  return () => {
    if (cached && Date.now() - refreshed < 4000) return Promise.resolve(cached);
    return pending ||= scan().then(result => {
      cached = result;
      refreshed = Date.now();
      return result;
    }).finally(() => { pending = null; });
  };
}
