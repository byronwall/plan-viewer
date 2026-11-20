import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

test("planboard init sets up a workspace once and then changes nothing", async t => {
  const root = await mkdtemp(join(tmpdir(), "planning-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A commit hook sets GIT_DIR; without this, init would see the viewer's own repository.
  const env = Object.fromEntries(Object.entries({ ...process.env, PLANNING_ROOT: root }).filter(([name]) => !name.startsWith("GIT_")));
  const init = () => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", "cli.ts", "init"], { env });
  const files = ["AGENTS.md", "CLAUDE.md", ".gitignore"];
  const read = () => Promise.all(files.map(file => readFile(join(root, file), "utf8")));

  await init();
  const [agents, , ignore] = await read();
  // The hooks path and the guide's commands name this checkout, relative or absolute depending on how far away it is.
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: root, env }).then(r => r.stdout.trim());
  const base = (await git("config", "core.hooksPath")).replace(/\/hooks$/, "");
  assert.equal(await realpath(resolve(root, base)), await realpath(process.cwd()));
  assert.ok(agents.includes(`${base}/cli.ts lint`) && !agents.includes("Copy this file"));
  assert.equal(ignore, "tmp/\nconfig.toml\n");
  await assert.rejects(stat(join(root, "package.json")));
  for (const dir of [".git", "config", "daily", "tasks", "reference"]) assert.ok((await stat(join(root, dir))).isDirectory());
  await assert.rejects(stat(join(root, "plans")), "init no longer creates plans/");

  const first = await read();
  const { stdout } = await init();
  assert.deepEqual(await read(), first);
  assert.ok(!stdout.includes("✓"));

  // Run from the viewer checkout by mistake, init must refuse instead of writing into the viewer.
  await assert.rejects(promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", "cli.ts", "init"], { env: { ...env, PLANNING_ROOT: "." } }), error => error.stderr.includes("planboard checkout"));
});
