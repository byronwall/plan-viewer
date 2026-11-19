import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { codexTasks, createChatThreads, openAgentFiles } from "./chat-threads.ts";

const id = (num: number) => `00000000-0000-4000-8000-${String(num).padStart(12, "0")}`;
const stamp = "2026-01-01T13:00:00.000Z";
const rollout = (home: string, num: number) => join(home, "sessions/2026/01/01", `rollout-2026-01-01T08-00-00-${id(num)}.jsonl`);
const line = (type: string, payload: object) => JSON.stringify({ timestamp: stamp, ordinal: 3, type, payload }) + "\n";
const edge = (type: string, details = {}) => line("event_msg", { type, ...details });

async function write(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

const fileRecords = (home: string) => ["p200", "ccodex", "f4", "au", `n${rollout(home, 1)}`, "f5", "ar", `n${rollout(home, 2)}`,
  "f6", "aw", `n${rollout(home, 3)}`, "f7", "aw", `n${rollout(home, 4)}`, "p300", "cclaude", "p400", "cClaude Helper"].join("\n");

test("open files distinguish Codex writers, readers, and Claude Code processes", () => {
  const files = openAgentFiles(fileRecords("/agent home"));
  assert.deepEqual([...files.rollouts.keys()], [id(1), id(3), id(4)]);
  assert.deepEqual([...files.claudePids], [300]);
});

test("lists running Codex CLI and Claude Desktop threads, and keeps inactive sessions in Completed", { skip: process.platform !== "darwin" }, async t => {
  const home = await mkdtemp(join(tmpdir(), "plan-viewer-threads-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = join(home, ".codex");
  const claudeConfig = join(home, ".claude");
  const desktop = join(home, "Library/Application Support/Claude/claude-code-sessions/account/group");
  const event = line("response_item", { type: "function_call_output", output: "a".repeat(200_000) });
  const meta = (num: number, source: unknown = "exec") => line("session_meta", { id: id(num), cwd: "/repo/alpha", source, originator: "codex_exec" });
  await write(rollout(codexHome, 1), meta(1) + edge("task_started") + event);
  await write(rollout(codexHome, 2), meta(2) + edge("task_started") + event);
  await write(rollout(codexHome, 3), meta(3) + edge("task_started") + edge("task_complete", { last_agent_message: "b".repeat(80_000) }) + event);
  await write(rollout(codexHome, 4), meta(4, { subagent: { other: "guardian" } }) + edge("task_started"));
  await write(rollout(codexHome, 10), meta(10) + edge("task_started") + edge("task_complete"));
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  execFileSync("/usr/bin/sqlite3", [join(codexHome, "state_5.sqlite"), `
    CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, name TEXT, updated_at INTEGER, source TEXT, originator TEXT, archived INTEGER);
    ${[1, 2, 3].map(num => `INSERT INTO threads VALUES (${quote(id(num))}, ${quote(rollout(codexHome, num))}, '/repo/alpha', 'First prompt', 'Working title ${num}', 1767272400, 'exec', 'codex_exec', 0);`).join("\n")}
    ALTER TABLE threads ADD COLUMN tokens_used INTEGER;
    ALTER TABLE threads ADD COLUMN model TEXT;
    UPDATE threads SET tokens_used = 18342, model = 'test-model' WHERE id = ${quote(id(1))};
    ALTER TABLE threads ADD COLUMN reasoning_effort TEXT;
    ALTER TABLE threads ADD COLUMN agent_nickname TEXT;
    INSERT INTO threads VALUES (${quote(id(10))}, ${quote(rollout(codexHome, 10))}, '/repo/alpha', '', '', 1767272400, ${quote(JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: id(3), agent_path: "/root/browser_check" } } }))}, 'Codex Desktop', 0, 50, 'worker-model', 'high', 'Kepler');
  `]);
  await write(join(claudeConfig, "sessions/300.json"), JSON.stringify({ pid: 300, sessionId: id(5), status: "waiting", cwd: "/repo/beta", updatedAt: Date.parse(stamp) }));
  await write(join(claudeConfig, "sessions/400.json"), JSON.stringify({ pid: 400, sessionId: id(6), status: "busy", cwd: "/repo/beta" }));
  await write(join(desktop, `local_${id(7)}.json`), JSON.stringify({ sessionId: `local_${id(7)}`, cliSessionId: id(5), title: "Desktop work", completedTurns: 1 }));
  await write(join(desktop, `local_${id(8)}.json`), JSON.stringify({ sessionId: `local_${id(8)}`, cliSessionId: id(6), title: "Stopped Desktop work", completedTurns: 1, lastActivityAt: Date.parse(stamp), effort: "max", spawnedFrom: { sessionId: `local_${id(7)}` } }));
  await write(join(claudeConfig, `projects/beta/${id(6)}.jsonl`), JSON.stringify({ type: "user", cwd: "/repo/beta", message: { content: "Duplicate CLI copy" } }));
  // A reply's usage repeats on each of its content blocks; it counts once.
  const reply = (msg: string) => JSON.stringify({ type: "assistant", message: { id: msg, usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 5 } } }) + "\n";
  await write(join(claudeConfig, `projects/beta/${id(5)}.jsonl`), reply("m1") + reply("m1") + reply("m2"));
  await write(join(claudeConfig, `projects/beta/${id(9)}.jsonl`), JSON.stringify({ type: "user", cwd: "/repo/beta", message: { content: "Completed CLI work" } }));
  // An idle live session with background tasks: one notified, one stopped, one failed to start, one still running.
  await write(join(claudeConfig, "sessions/500.json"), JSON.stringify({ pid: 500, sessionId: id(11), status: "idle", cwd: "/repo/gamma", name: "Watching CI" }));
  const launch = (use: string, name: string, description: string) => JSON.stringify({ type: "assistant", message: { id: `m-${use}`, usage: { output_tokens: 1 }, content: [{ type: "tool_use", id: use, name, input: { description, run_in_background: true } }] } }) + "\n";
  const result = (use: string, content: string, is_error = false) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: use, content, is_error }] } }) + "\n";
  await write(join(claudeConfig, `projects/-repo-gamma/${id(11)}.jsonl`), [
    launch("toolu_a", "Bash", "Run tests"), result("toolu_a", "Command running in background with ID: aaa1."),
    launch("toolu_b", "Agent", "Audit icons"), result("toolu_b", "Async agent launched. agentId: bbb2"),
    launch("toolu_c", "Bash", "Serve sample"), result("toolu_c", "Command running in background with ID: ccc3."),
    launch("toolu_d", "Bash", "Bad command"), result("toolu_d", "Error", true),
    JSON.stringify({ type: "queue-operation", content: "<task-notification>\n<task-id>aaa1</task-id>\n<status>completed</status>" }) + "\n",
    JSON.stringify({ type: "assistant", message: { id: "m-stop", content: [{ type: "tool_use", id: "toolu_e", name: "TaskStop", input: { task_id: "ccc3" } }], usage: { output_tokens: 1 } } }) + "\n",
  ].join(""));
  const read = createChatThreads({ home, codexHome, claudeConfig, readLiveFiles: async () => openAgentFiles(fileRecords(codexHome) + "\np500\ncclaude") });
  const { active, completed, issues } = await read();
  assert.deepEqual(issues, []);
  assert.deepEqual(active.map(({ id: key, state }) => [key, state]), [[id(1), "active"], [`local_${id(7)}`, "waiting"], [id(11), "background"]]);
  assert.deepEqual(active[2].tasks, [{ kind: "agent", label: "Audit icons" }]);
  assert.equal(active[0].tokens, 18342);
  assert.equal(active[0].model, "test-model");
  assert.equal(completed.find(thread => thread.id === id(2))?.tokens, null);
  assert.equal(active[0].title, "Working title 1");
  assert.equal(active[0].url, `codex://threads/${id(1)}`);
  assert.equal(active[1].url, `claude://claude.ai/epitaxy/local_${id(7)}`);
  assert.deepEqual(active[1].usage, { tokens: 210, input: 200, cached: 180, output: 10 });
  assert.equal(completed.find(thread => thread.id === id(9))?.url, `claude://resume?session=${id(9)}`);
  assert.deepEqual(new Map(completed.map(({ id: key, state }) => [key, state])), new Map([
    [id(2), "interrupted"], [id(3), "completed"], [id(10), "completed"], [`local_${id(8)}`, "completed"], [id(9), "completed"],
  ]));
  // Spawned threads name their parent, so the page can nest them; a subagent with no title takes its path's name.
  const worker = completed.find(thread => thread.id === id(10));
  assert.deepEqual([worker?.parent, worker?.kind, worker?.nickname, worker?.effort, worker?.title], [id(3), "subagent", "Kepler", "high", "browser check"]);
  const side = completed.find(thread => thread.id === `local_${id(8)}`);
  assert.deepEqual([side?.parent, side?.effort], [`local_${id(7)}`, "max"]);
});

test("Codex terminal sessions count as background tasks until a poll gets no session back", async t => {
  const home = await mkdtemp(join(tmpdir(), "plan-viewer-codex-tasks-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "rollout.jsonl");
  const at = (minute: number) => `2026-01-01T13:0${minute}:00.000Z`;
  const call = (id: string, input: string, minute: number) => JSON.stringify({ timestamp: at(minute), type: "response_item", payload: { type: "custom_tool_call", call_id: id, name: "exec", input } }) + "\n";
  const output = (id: string, text: string, minute: number) => JSON.stringify({ timestamp: at(minute), type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text }] } }) + "\n";
  await write(path, [
    call("a", 'text(await tools.exec_command({cmd:"pnpm dev",yield_time_ms:1000}))', 1), output("a", '{"chunk_id":"1","session_id":101,"output":"ready"}', 1),
    call("b", 'text(await tools.exec_command({cmd:"pnpm test"}))', 2), output("b", '{"chunk_id":"2","session_id":202,"output":""}', 2),
    call("c", "text(await tools.write_stdin({session_id:202,chars:\"\"}))", 3), output("c", '{"chunk_id":"3","exit_code":0,"output":"ok"}', 3),
  ].join(""));
  const size = (await import("node:fs/promises")).stat(path).then(info => info.size);
  assert.deepEqual(await codexTasks(path, await size, new Map(), 0), [{ kind: "command", label: "pnpm dev" }]);
  // Started before this Codex process did: it died with the earlier one.
  assert.deepEqual(await codexTasks(path, await size, new Map(), Date.parse(at(5))), []);
});
