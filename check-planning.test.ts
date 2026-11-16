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

test("planning lint flags fences the viewer would show as text or that never close", () => {
  assert.deepEqual(planningErrors("plans/a/b.md", "1. Step:\n\n   ```text\n   x\n   ```\n\n2. Next\n"), []);
  assert.ok(planningErrors("plans/a/b.md", "Para\n\n  ```text\n  x\n  ```\n").some(error => error.includes("Line 3: this fence is indented but not inside a list item")));
  assert.ok(planningErrors("plans/a/b.md", "Intro\n\n```text\nx\n").some(error => error.includes("Line 3: this fence is never closed")));
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
  assert.match((await run(hook, [], { cwd: root, env })).stdout, /ok\s+1 planning files/);
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

test("step lint: known kinds, waiting only on others, choices with one default, sizes on new tasks, banned prompt words", async (t) => {
  const { stepErrors, draftErrors } = await import("./check-planning.ts");
  const { setConfig } = await import("./public/config.js");
  const { parseWorkBreakdown } = await import("./public/actions.js");
  setConfig({ steps: { requireSizeFrom: "2026-11-13", forbiddenInPrompts: ["externalbrowser"] } });
  t.after(() => setConfig({}));
  const nodes = parseWorkBreakdown(`- W1: A [waiting] {decision, S}
- W2: B [open] {mystery, S}
- W3: Pick [open] {pick-one, S}
  - W3.1: X — x [open] {option}
  - W3.2: Y — y [open]
- W4: No size [open] {agent}`).nodes;
  const errors = stepErrors({ created: "2026-11-13" }, nodes, [{ title: "Read", prompt: "snow sql --authenticator externalbrowser" }]);
  assert.deepEqual(errors.map((e) => e.split(":")[0].split(" ")[0]), ["W1", "W2", "W3", "W3", "W4", "Action"]);
  assert.deepEqual(stepErrors({ created: "2026-11-12" }, parseWorkBreakdown("- W4: No size [open] {agent}").nodes, []), []);
  const draft = (status: string) => `---\noutbound: slack\ntarget: x\nstatus: ${status}\nstep: TASK-0001 W1\n---\n\n# D\n`;
  const task = (status: string) => `## Work breakdown\n\n- W1: Reply [${status}] {slack, S}\n`;
  assert.deepEqual(draftErrors("tasks/TASK-0001-assets/d.md", draft("ready"), task("open")), []);
  assert.match(draftErrors("tasks/TASK-0001-assets/d.md", draft("ready"), task("completed"))[0], /completed but its draft is ready/);
  assert.match(draftErrors("tasks/TASK-0001-assets/d.md", draft("sent"), task("open"))[0], /sent but TASK-0001 W1 is open/);
  assert.match(draftErrors("tasks/TASK-0002-assets/d.md", draft("ready"), task("open"))[0], /another task's assets/);
  const pr = (target: string) => `---\noutbound: pr-comment\ntarget: ${target}\nstatus: ready\nstep: TASK-0001 W1\n---\n\n# D\n`;
  for (const ok of ["#2233", "PyRel#3929", "https://github.com/acme/app/pull/2104", "https://github.com/acme/app/pull/7/files#diff-1"]) assert.deepEqual(draftErrors("tasks/TASK-0001-assets/d.md", pr(ok), task("open")), [], ok);
  for (const bad of ["2233", "https://github.com/acme/app/issues/1"]) assert.match(draftErrors("tasks/TASK-0001-assets/d.md", pr(bad), task("open"))[0], /isn't a PR the sender can parse/, bad);
});

test("reference lint: step titles on new tasks and diagram labels say what each reference is", async (t) => {
  const { stepErrors, diagramErrors, ungroundedReferences } = await import("./check-planning.ts");
  const { setConfig } = await import("./public/config.js");
  const { parseWorkBreakdown } = await import("./public/actions.js");
  setConfig({ steps: { groundReferencesFrom: "2026-11-16" } });
  t.after(() => setConfig({}));
  assert.deepEqual(ungroundedReferences("Merge #1954"), ["#1954"]);
  assert.deepEqual(ungroundedReferences("Merge #1954, the stacked review PR"), []);
  assert.deepEqual(ungroundedReferences("Decide whether W7.1 is done now that #2285 closed for #2288"), ["W7.1", "#2285", "#2288"]);
  assert.deepEqual(ungroundedReferences("Name the role on the PyRel path ([Jira draft](TASK-0001-assets/a.md#x))"), []);
  assert.deepEqual(ungroundedReferences("Retry acme@0123abc and PyRel#12"), ["acme@0123abc", "PyRel#12"]);
  const nodes = parseWorkBreakdown("- W1: Merge #1954 [open] {agent, S}\n- W2: Merge #1954, the stacked review PR [open] {agent, S}").nodes;
  assert.deepEqual(stepErrors({ created: "2026-11-16" }, nodes, []).map((e) => e.split(":")[0]), ["W1"]);
  assert.deepEqual(stepErrors({ created: "2026-11-15" }, nodes, []), [], "older tasks are not checked");
  const bad = 'diagram "What\'s left on TASK-0123" version=1\nnode a "RAI-55557\\n#2278, #2291"\nedge e1 a -> b "#2291 and #2281 on STAGING"\n';
  assert.deepEqual(diagramErrors(bad).map((e) => e.split(":")[0]), ["line 2", "line 3"]);
  const good = 'node a "RAI-55557 · role can\'t read data\\n#2278 names the role, #2291 error codes"\nedge e1 a -> b "error codes reach STAGING"\nlayout root flow\n';
  assert.deepEqual(diagramErrors(good), []);
});
