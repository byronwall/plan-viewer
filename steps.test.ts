import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { draftFromText } from "./outbound.ts";
import { activeRuns, applyRule, deriveSteps, pickChoice, runStatement, startStep, withStepFlag } from "./steps.ts";
import { setConfig } from "./public/config.js";

const TASK = `---
id: TASK-0001
title: Ship invites
summary: x
status: active
project: Atlas
tags: []
created: 2026-11-01
updated: 2026-11-10
---

# Ship invites

## Work breakdown

- W1: Done [completed]
- W2: Comment on ABC-1 [open] (after: W1) {jira-comment, S}
- W3: Pick a path [open] {pick-one, S}
  - W3.1: Fast — ships now [open] {option, recommended}
  - W3.2: Safe — waits a week [open] {option}
- W4: Run the DROP in the console [open] {byron, S}
- W5: Trevor reviews #1 [waiting]
- W6: Build it [active] {agent, M}
- W7: Later [open] (after: W6)
- W8: Mystery [open]
- W9: Scope [open]
  - W9.1: Child [open] {agent, S}
- W10: Reply to Pat [open] {slack, S}
- W11: Post the review [open]

## Next actions

### Draft it

Work item: W11

\`\`\`prompt
Draft the review comment.
\`\`\`

## Updates

- **2026-11-10 — Created.**
`;

const draft = (step: string, kind: string, extra = "") => {
  const path = `tasks/TASK-0001-assets/${kind}.md`;
  const text = `---\noutbound: ${kind}\ntarget: x\nstatus: ready\nstep: ${step}\n${extra}---\n\n# D\n\n<!-- send:start -->\nHi\n<!-- send:end -->\n`;
  return { path, fields: draftFromText(path, text)!.fields, draft: draftFromText(path, text)!, modified: 0 };
};

test("each open step gets one next move from its kind, status, prerequisites and machinery", () => {
  const task = { path: "tasks/TASK-0001.md", id: "TASK-0001", title: "Ship invites", status: "active", updated: "2026-11-10", markdown: TASK };
  const machinery = [
    draft("TASK-0001 W2", "jira-comment"),
    draft("TASK-0001 W10", "slack", "send: manual\n"),
    { path: "tasks/TASK-0001-assets/drop.md", fields: { step: "TASK-0001 W4", kind: "byron", why: "the classifier refuses DROP", fix: "Approve and run" }, modified: 0 },
  ];
  const steps = deriveSteps([task], machinery, ["TASK-0001"], Date.parse("2026-11-12"));
  const move = Object.fromEntries(steps.map((s) => [s.id, `${s.move}:${s.reason}`]));
  assert.deepEqual(move, {
    W2: "you-decide:approve", W3: "you-decide:pick one", W4: "you-act:the classifier refuses DROP", W5: "others:waiting",
    W6: "agent:in progress", W7: "blocked:after W6", W8: "unclassified:no kind or prompt", "W9.1": "agent:ready",
    W10: "you-act:send by hand", W11: "agent:ready",
  });
  const choice = steps.find((s) => s.id === "W3")!;
  assert.deepEqual(choice.options!.map((o) => [o.id, o.title, o.tradeoff, o.recommended]), [["W3.1", "Fast", "ships now", true], ["W3.2", "Safe", "waits a week", false]]);
  assert.equal(steps.find((s) => s.id === "W4")!.fix, "Approve and run");
  assert.equal(steps.find((s) => s.id === "W2")!.draft!.fields.outbound, "jira-comment");
  assert.equal(steps.find((s) => s.id === "W2")!.age, 2);
  // A sent draft hides its step, even before the line is marked completed.
  const sent = draft("TASK-0001 W2", "jira-comment");
  sent.draft.fields.status = "sent";
  assert.equal(deriveSteps([task], [sent]).some((s) => s.id === "W2"), false);
});

test("Up next adds and removes the next flag without touching kind, size or prerequisites, and sorts first", () => {
  const flagged = withStepFlag(withStepFlag(TASK, "W7", "next", true), "W6", "next", true);
  assert.match(flagged, /^- W7: Later \[open\] \(after: W6\) \{next\}$/m);
  assert.match(flagged, /^- W6: Build it \[active\] \{agent, M, next\}$/m);
  const steps = deriveSteps([{ path: "tasks/TASK-0001.md", id: "TASK-0001", title: "Ship invites", status: "active", updated: "2026-11-10", markdown: flagged }], []);
  assert.deepEqual(steps.slice(0, 2).map((s) => [s.id, s.next, s.kind]), [["W6", true, "agent"], ["W7", true, ""]]);
  assert.equal(withStepFlag(flagged, "W6", "next", false), withStepFlag(TASK, "W7", "next", true));
  assert.equal(withStepFlag(withStepFlag(TASK, "W8", "next", true), "W8", "next", false), TASK);
  assert.throws(() => withStepFlag(TASK, "W99", "next", true), /W99/);
});

test("Pick completes the choice, defers the options not picked, and records the pick", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "steps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tasks"), { recursive: true });
  await writeFile(join(root, "tasks/TASK-0001.md"), TASK);
  await assert.rejects(pickChoice(root, "tasks/TASK-0001.md", "W3", [], "Pat", "2026-11-12"), /Pick exactly one/);
  await assert.rejects(pickChoice(root, "tasks/TASK-0001.md", "W2", ["W3.1"], "Pat", "2026-11-12"), /isn't a choice/);
  await pickChoice(root, "tasks/TASK-0001.md", "W3", ["W3.1"], "Pat", "2026-11-12");
  const md = await readFile(join(root, "tasks/TASK-0001.md"), "utf8");
  assert.match(md, /^- W3: Pick a path \[completed\] \{pick-one, S\}$/m);
  assert.match(md, /^ {2}- W3\.1: Fast — ships now \[open\] \{option, recommended\}$/m);
  assert.match(md, /^ {2}- W3\.2: Safe — waits a week \[deferred\] \{option, not picked\}$/m);
  assert.match(md, /^## Updates\n\n- \*\*2026-11-12 — Picked W3\.1 \(Fast\) for W3 \(Pat, in the viewer\):\*\* Pick a path\.\n/m);
  assert.match(md, /^updated: 2026-11-12$/m);
  await assert.rejects(pickChoice(root, "tasks/TASK-0001.md", "W3", ["W3.1"], "Pat", "2026-11-12"), /already decided/);
});

test("Approve and run runs only a single read-only statement, records the output and completes the step", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "steps-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tasks/TASK-0001-assets"), { recursive: true });
  await writeFile(join(root, "tasks/TASK-0001.md"), TASK);
  const machinery = (run: string) => `---\nkind: byron\nstep: TASK-0001 W4\ntarget: dev\nrun: ${run}\n---\n\n# Check\n`;
  setConfig({ user: "Pat", steps: { run: [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "{target}", "{statement}"] } });
  t.after(() => setConfig({}));
  await writeFile(join(root, "tasks/TASK-0001-assets/write.md"), machinery("drop schema X.Y"));
  await assert.rejects(runStatement(root, "tasks/TASK-0001-assets/write.md", "Pat", "2026-11-12"), /Only a single read-only statement/);
  await writeFile(join(root, "tasks/TASK-0001-assets/two.md"), machinery("select 1; drop schema X.Y"));
  await assert.rejects(runStatement(root, "tasks/TASK-0001-assets/two.md", "Pat", "2026-11-12"), /Only a single read-only statement/);
  await writeFile(join(root, "tasks/TASK-0001-assets/read.md"), machinery("select current_user()"));
  const result = await runStatement(root, "tasks/TASK-0001-assets/read.md", "Pat", "2026-11-12");
  assert.equal(result.ok, true);
  assert.equal(result.output, '["dev","select current_user()"]');
  assert.match(await readFile(join(root, "tasks/TASK-0001-assets/read.md"), "utf8"), /## Run, .* \(Pat, in the viewer\)\n\n```text\n\["dev","select current_user\(\)"\]\n```\n$/);
  assert.match(await readFile(join(root, "tasks/TASK-0001.md"), "utf8"), /^- W4: Run the DROP in the console \[completed\] \{byron, S\}$/m);
});

test("Apply adds a drafted allow rule once to the workspace settings file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "steps-apply-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tasks/TASK-0001-assets"), { recursive: true });
  await writeFile(join(root, "tasks/TASK-0001.md"), TASK);
  await writeFile(join(root, "tasks/TASK-0001-assets/rule.md"), "---\nkind: decision\nstep: TASK-0001 W8\napply: Bash(python3 scripts/probe.py:*)\n---\n\n# Rule\n");
  setConfig({ steps: { settingsFile: ".claude/settings.json" } });
  t.after(() => setConfig({}));
  assert.equal((await applyRule(root, "tasks/TASK-0001-assets/rule.md", "Pat", "2026-11-12")).added, true);
  assert.equal((await applyRule(root, "tasks/TASK-0001-assets/rule.md", "Pat", "2026-11-12")).added, false);
  assert.deepEqual(JSON.parse(await readFile(join(root, ".claude/settings.json"), "utf8")), { permissions: { allow: ["Bash(python3 scripts/probe.py:*)"] } });
  setConfig({ steps: { settingsFile: "../outside.json" } });
  await assert.rejects(applyRule(root, "tasks/TASK-0001-assets/rule.md", "Pat", "2026-11-12"), /inside the workspace/);
});

test("Start marks the step active, holds a slot until the run ends, and refuses past the slots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "steps-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tasks"), { recursive: true });
  await writeFile(join(root, "tasks/TASK-0001.md"), TASK);
  setConfig({ steps: { start: [process.execPath, "-e", "setTimeout(() => {}, 300)", "{prompt}"], slots: 1 } });
  t.after(() => setConfig({}));
  const task = { path: "tasks/TASK-0001.md", id: "TASK-0001", title: "Ship invites", status: "active", updated: "2026-11-10", markdown: TASK };
  const [w11, w91] = ["W11", "W9.1"].map((id) => deriveSteps([task], []).find((s) => s.id === id)!);
  const started = await startStep(root, w11, "2026-11-12");
  assert.equal(started.started, true);
  assert.deepEqual(activeRuns().map((run) => run.key), ["TASK-0001 W11"]);
  assert.match(await readFile(join(root, "tasks/TASK-0001.md"), "utf8"), /^- W11: Post the review \[active\]$/m);
  await assert.rejects(startStep(root, w91, "2026-11-12"), /All 1 agent slots are in use/);
  await new Promise((done) => setTimeout(done, 700));
  assert.deepEqual(activeRuns(), []);
});
