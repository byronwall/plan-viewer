import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

// A git workspace in the older layout: the demo as it was before the layout change, rebuilt from its pieces.
async function oldWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), "planning-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries({ ...process.env, PLANNING_ROOT: root }).filter(([name]) => !name.startsWith("GIT_")));
  const files = {
    "viewer.config.json": JSON.stringify({ code: { reposFile: "reference/code-repos.json", prNotesDir: "plans/pr-notes" } }, null, 2),
    "reference/code-repos.json": "[]",
    "reference/team.md": "# Team\n\nSee [TASK-0101](../tasks/TASK-0101.md).\n",
    "plans/README.md": "# Topics\n\n- [Invites](invites/README.md)\n",
    "plans/invites/README.md": "# Invites\n\nFor [TASK-0101](../../tasks/TASK-0101.md).\n",
    "tasks/TASK-0101.md": "# Invites\n\n![Flow](TASK-0101-assets/flow.draft)\n\nSee `tasks/TASK-0101-assets/runbook.md` and [today](../daily/2026/10/22/plan.md#focus).\n",
    "tasks/TASK-0101-assets/flow.draft": "diagram \"Flow\"\n",
    "tasks/TASK-0101-assets/runbook.md": "# Runbook\n\nBack to [the task](../TASK-0101.md).\n",
    "daily/2026/10/22/plan.md": "# Daily plan\n\n- [TASK-0101](../../../../tasks/TASK-0101.md)\n",
    "AGENTS.md": "Tasks live in tasks/TASK-NNNN.md.\n",
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const git = (...args) => exec("git", args, { cwd: root, env });
  await git("init", "-q");
  await git("add", "-A");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "old layout");
  const migrate = (...args) => exec(process.execPath, ["--experimental-strip-types", "--no-warnings", "cli.ts", "migrate", ...args], { env });
  return { root, migrate, read: (path) => readFile(join(root, path), "utf8") };
}

test("migrate moves an old-layout workspace and keeps every link working", async t => {
  const { root, migrate, read } = await oldWorkspace(t);
  const dry = await migrate();
  assert.match(dry.stdout, /tasks\/TASK-0101\.md → tasks\/TASK-0101\/TASK-0101\.md/);
  assert.match(dry.stdout, /Dry run; nothing changed/);
  await stat(join(root, "tasks/TASK-0101.md"));

  const { stdout } = await migrate("--write");
  assert.match(stdout, /AGENTS\.md:1: Tasks live in tasks\/TASK-NNNN\.md/);
  assert.equal(await read("tasks/TASK-0101/TASK-0101.md"), "# Invites\n\n![Flow](flow.draft)\n\nSee `tasks/TASK-0101/runbook.md` and [today](../../daily/2026-10-22.md#focus).\n");
  assert.equal(await read("tasks/TASK-0101/runbook.md"), "# Runbook\n\nBack to [the task](TASK-0101.md).\n");
  assert.equal(await read("daily/2026-10-22.md"), "# Daily plan\n\n- [TASK-0101](../tasks/TASK-0101/TASK-0101.md)\n");
  assert.equal(await read("reference/invites/README.md"), "# Invites\n\nFor [TASK-0101](../../tasks/TASK-0101/TASK-0101.md).\n");
  assert.equal(await read("reference/topics.md"), "# Topics\n\n- [Invites](invites/README.md)\n");
  assert.deepEqual(JSON.parse(await read("config/viewer.json")).code, { reposFile: "config/code-repos.json", prNotesDir: "reference/pr-notes" });
  await assert.rejects(stat(join(root, "daily/2026")));
  await assert.rejects(stat(join(root, "plans")));

  // A second run on the committed result has nothing to do.
  assert.match((await migrate()).stdout, /Nothing to move/);
});

test("migrate lists what to fix first and changes nothing until it is fixed", async t => {
  const { root, migrate } = await oldWorkspace(t);
  await mkdir(join(root, "tasks/TASK-0200-assets"));
  await writeFile(join(root, "tasks/TASK-0200-assets/orphan.md"), "# Orphan\n");
  await writeFile(join(root, "daily/2026/10/22/notes.md"), "# Notes\n");
  for (const args of [[], ["--write"]]) {
    const error = await migrate(...args).then(() => assert.fail("migrate should exit 1"), (error) => error);
    assert.equal(error.code, 1);
    assert.match(error.stdout, /tasks\/TASK-0200-assets\/orphan\.md: its task file tasks\/TASK-0200\.md does not exist/);
    assert.match(error.stdout, /daily\/2026\/10\/22\/notes\.md: only plan\.md belongs in a day folder/);
  }
  await stat(join(root, "tasks/TASK-0101.md"));
});

test("migrate carries absolute paths, tracked symlinks and stragglers, and points at scripts and skills to update", async t => {
  const { root, migrate, read } = await oldWorkspace(t);
  const git = (...args) => exec("git", args, { cwd: root, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))) });
  const { symlink } = await import("node:fs/promises");
  await writeFile(join(root, "tasks/TASK-0101-assets/run.md"), `# Run\n\nRan \`node ${root}/tasks/TASK-0101-assets/runbook.md\`. See ${root}/daily/2026/10/22/plan.md.\n`);
  await symlink("/nowhere/node_modules", join(root, "tasks/TASK-0101-assets/node_modules"));
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/today.py"), 'plan = ROOT / "daily" / date.today().strftime("%Y/%m/%d") / "plan.md"\n');
  await mkdir(join(root, ".agents/skills/plan"), { recursive: true });
  await writeFile(join(root, ".agents/skills/plan/SKILL.md"), "Put drafts in tasks/TASK-NNNN-assets/.\n");
  await git("add", "-A");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "more");
  // Written after the commit and ignored: what a still-running session leaves behind.
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await mkdir(join(root, "tasks/TASK-0101-assets/head/node_modules/.vite"), { recursive: true });
  await writeFile(join(root, "tasks/TASK-0101-assets/head/node_modules/.vite/results.json"), "{}");
  await git("add", ".gitignore");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "ignore");

  const { stdout } = await migrate("--write");
  assert.equal(await read("tasks/TASK-0101/run.md"), `# Run\n\nRan \`node ${root}/tasks/TASK-0101/runbook.md\`. See ${root}/daily/2026-10-22.md.\n`);
  assert.match((await git("ls-files", "tasks")).stdout, /^tasks\/TASK-0101\/node_modules$/m);
  assert.match(stdout, /scripts\/today\.py:1:/);
  assert.match(stdout, /\.agents\/skills\/plan\/SKILL\.md:1:/);
  assert.match(stdout, /still hold files the migration did not move[\s\S]*tasks\/TASK-0101-assets\//);
});
