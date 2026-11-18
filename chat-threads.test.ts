import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createChatThreads, openAgentFiles } from "./chat-threads.ts";

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
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  execFileSync("/usr/bin/sqlite3", [join(codexHome, "state_5.sqlite"), `
    CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, name TEXT, updated_at INTEGER, source TEXT, originator TEXT, archived INTEGER);
    ${[1, 2, 3].map(num => `INSERT INTO threads VALUES (${quote(id(num))}, ${quote(rollout(codexHome, num))}, '/repo/alpha', 'First prompt', 'Working title ${num}', 1767272400, 'exec', 'codex_exec', 0);`).join("\n")}
    ALTER TABLE threads ADD COLUMN tokens_used INTEGER;
    ALTER TABLE threads ADD COLUMN model TEXT;
    UPDATE threads SET tokens_used = 18342, model = 'test-model' WHERE id = ${quote(id(1))};
  `]);
  await write(join(claudeConfig, "sessions/300.json"), JSON.stringify({ pid: 300, sessionId: id(5), status: "waiting", cwd: "/repo/beta", updatedAt: Date.parse(stamp) }));
  await write(join(claudeConfig, "sessions/400.json"), JSON.stringify({ pid: 400, sessionId: id(6), status: "busy", cwd: "/repo/beta" }));
  await write(join(desktop, `local_${id(7)}.json`), JSON.stringify({ sessionId: `local_${id(7)}`, cliSessionId: id(5), title: "Desktop work", completedTurns: 1 }));
  await write(join(desktop, `local_${id(8)}.json`), JSON.stringify({ sessionId: `local_${id(8)}`, cliSessionId: id(6), title: "Stopped Desktop work", completedTurns: 1, lastActivityAt: Date.parse(stamp) }));
  await write(join(claudeConfig, `projects/beta/${id(6)}.jsonl`), JSON.stringify({ type: "user", cwd: "/repo/beta", message: { content: "Duplicate CLI copy" } }));
  await write(join(claudeConfig, `projects/beta/${id(9)}.jsonl`), JSON.stringify({ type: "user", cwd: "/repo/beta", message: { content: "Completed CLI work" } }));
  const read = createChatThreads({ home, codexHome, claudeConfig, readLiveFiles: async () => openAgentFiles(fileRecords(codexHome)) });
  const { active, completed, issues } = await read();
  assert.deepEqual(issues, []);
  assert.deepEqual(active.map(({ id: key, state }) => [key, state]), [[id(1), "active"], [`local_${id(7)}`, "waiting"]]);
  assert.equal(active[0].tokens, 18342);
  assert.equal(active[0].model, "test-model");
  assert.equal(completed.find(thread => thread.id === id(2))?.tokens, null);
  assert.equal(active[0].title, "Working title 1");
  assert.equal(active[0].url, `codex://threads/${id(1)}`);
  assert.equal(active[1].url, `claude://claude.ai/epitaxy/local_${id(7)}`);
  assert.equal(completed.find(thread => thread.id === id(9))?.url, `claude://resume?session=${id(9)}`);
  assert.deepEqual(new Map(completed.map(({ id: key, state }) => [key, state])), new Map([
    [id(2), "interrupted"], [id(3), "completed"], [`local_${id(8)}`, "completed"], [id(9), "completed"],
  ]));
});
