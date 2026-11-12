import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { draftFromText } from "./outbound.ts";
import { deriveSteps, pickChoice } from "./steps.ts";

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
    W6: "agent:running", W7: "blocked:after W6", W8: "unclassified:no kind or prompt", "W9.1": "agent:ready",
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
