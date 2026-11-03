import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

test("plan-viewer init sets up a workspace once and then changes nothing", async t => {
  const root = await mkdtemp(join(tmpdir(), "planning-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, PLANNING_ROOT: root };
  const init = () => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", "cli.ts", "init"], { env });
  const files = ["AGENTS.md", "CLAUDE.md", "package.json"];
  const read = () => Promise.all(files.map(file => readFile(join(root, file), "utf8")));

  await init();
  const [agents, , pkg] = await read();
  assert.ok(agents.includes("tasks/TASK-NNNN.md") && !agents.includes("Copy this file"));
  assert.equal(JSON.parse(pkg).scripts.viewer, "plan-viewer serve");
  for (const dir of ["daily", "tasks", "plans", "reference"]) assert.ok((await stat(join(root, dir))).isDirectory());

  const first = await read();
  const { stdout } = await init();
  assert.deepEqual(await read(), first);
  assert.ok(!stdout.includes("✓"));
});
