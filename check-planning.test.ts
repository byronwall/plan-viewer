import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { checkPlanning, planningErrors } from "./check-planning.ts";
import { fileURLToPath } from "node:url";

const taskPath = "tasks/TASK-0042.md";
const source = `---
id: TASK-0042
title: Prove the loop
summary: Preserve dependencies.
status: open
project: Daily planning
tags: []
created: 2026-10-14
updated: 2026-10-14
---

# Prove the loop

## Next actions

### Verify

Work item: W1.2

\`\`\`prompt
Verify the result.
\`\`\`

## Work breakdown

- W1: Deliver [open]
  - W1.1: Reproduce [open]
  - W1.2: Verify [open] (after: W1.1)
`;

test("planning lint rejects viewer diagnostics and broken action references without rejecting blocked work", () => {
  assert.deepEqual(planningErrors(taskPath, source), []);
  const invalid = planningErrors(taskPath, source.replace("Reproduce [open]", "Reproduce [done]"));
  assert.ok(invalid.some(error => error.includes("Replace [done] with [completed]")));
  assert.ok(invalid.some(error => error.includes("depends on W1.1, which could not be parsed")));
  assert.ok(planningErrors(taskPath, source.replace("status: open", "status: done")).some(error => error.includes("unsupported task status")));
  assert.ok(planningErrors(taskPath, source.replace("Work item: W1.2", "Work item: W9")).some(error => error.includes("Action “Verify” references missing or invalid work item W9")));
  assert.ok(planningErrors(taskPath, source.replace("(after: W1.1)", "(after: W9)")).some(error => error.includes("depends on missing work item W9")));
  assert.ok(planningErrors(taskPath, source.replace("Reproduce [open]", "Reproduce [open] (after: W1.2)")).some(error => error.includes("Dependency cycle")));
  assert.ok(planningErrors(taskPath, source + "  - W1.2: Duplicate [open]\n").some(error => error.includes("Duplicate work item W1.2")));
});

test("planning lint flags an active task whose only next actions are blocked", () => {
  const active = source.replace("status: open", "status: active");
  assert.ok(planningErrors(taskPath, active).some(error => error.includes("no ready next action: “Verify” (W1.2 is open, after W1.1)")));
  assert.deepEqual(planningErrors(taskPath, active.replace("Reproduce [open]", "Reproduce [completed]")), []);
  assert.deepEqual(planningErrors(taskPath, active.replace("Work item: W1.2", "Work item: W1.1")), []);
  assert.ok(planningErrors(taskPath, active.replace(/## Next actions[\s\S]*?## Work/, "## Work")).some(error => error.includes("no next actions")));
});

test("planning lint and the commit hook check the index rather than the corrected working copy", async t => {
  const root = await mkdtemp(join(tmpdir(), "planning-lint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = promisify(execFile);
  const git = (args: string[]) => run("git", args, { cwd: root });
  await git(["init", "--quiet"]);
  await mkdir(join(root, "tasks"));
  await mkdir(join(root, "reference", "linear"), { recursive: true });
  await writeFile(join(root, "reference", "linear", "generated.md"), "## Work breakdown\n\n- W1: Generated [done]\n");
  await writeFile(join(root, taskPath), source.replace("Reproduce [open]", "Reproduce [done]"));
  assert.equal((await checkPlanning([], root)).files, 1);
  assert.ok((await checkPlanning([], root)).errors.length > 0);
  await git(["add", taskPath]);
  await writeFile(join(root, taskPath), source);
  assert.deepEqual((await checkPlanning([taskPath], root)).errors, []);
  assert.ok((await checkPlanning(["--staged"], root)).errors.length > 0);

  // The workspace hook runs from the planning repository, which is the CLI's default root.
  const hook = fileURLToPath(new URL("hooks/pre-commit", import.meta.url));
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "PLANNING_ROOT"]) delete env[name];
  await assert.rejects(run(hook, [], { cwd: root, env }), error => error.code === 1 && error.stderr.includes("Replace [done] with [completed]"));
  await git(["add", taskPath]);
  assert.deepEqual(await checkPlanning(["--staged"], root), { files: 1, errors: [] });
  assert.match((await run(hook, [], { cwd: root, env })).stdout, /ok\s+1 planning Markdown files/);
  // Links are checked in the index too: another session's unstaged assets folder must not block the commit.
  await mkdir(join(root, "tasks", "TASK-0099-assets"));
  await writeFile(join(root, "tasks", "TASK-0099-assets", "draft.sql"), "select 1;\n");
  await run(hook, [], { cwd: root, env });
  await git(["add", "tasks/TASK-0099-assets"]);
  await assert.rejects(run(hook, [], { cwd: root, env }), error => error.code === 1 && error.stderr.includes("no parent tasks/TASK-0099.md"));
  await git(["rm", "-r", "--cached", "--quiet", "tasks/TASK-0099-assets"]);
  await rm(join(root, "tasks", "TASK-0099-assets"), { recursive: true });
  await writeFile(join(root, taskPath), source.replace("Reproduce [open]", "Reproduce [done]"));
  assert.deepEqual((await checkPlanning(["--staged"], root)).errors, []);
  assert.ok((await checkPlanning([taskPath], root)).errors.length > 0);
  assert.match(await readFile(join(root, taskPath), "utf8"), /\[done\]/);

  await git(["add", taskPath]);
  await rm(join(root, taskPath));
  assert.deepEqual((await checkPlanning([], root)).errors, [], "an unstaged move must not fail the full lint");
});
