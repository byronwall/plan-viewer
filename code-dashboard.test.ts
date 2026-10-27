import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWorktree, prDiscussion } from "./code-dashboard.ts";

const DAY = 86_400_000;
const now = 100 * DAY;
const tree = (overrides = {}) => ({ repo: "/r", path: "/r.worktrees/x", branch: "x", head: "abc", commitTime: now, created: 0, dirty: 0, editTime: 0, activity: now, main: false, ...overrides });

test("worktree cleanup never offers dirty, open, recent, or main checkouts", () => {
  assert.equal(classifyWorktree(tree({ main: true }), true, now).level, "keep");
  assert.equal(classifyWorktree(tree({ dirty: 2, prState: "MERGED", prNumber: 1 }), true, now).level, "keep");
  assert.equal(classifyWorktree(tree({ prState: "OPEN", prNumber: 1, activity: 0 }), false, now).level, "keep");
  assert.equal(classifyWorktree(tree(), false, now).level, "keep");
  assert.equal(classifyWorktree(tree({ dirty: null }), false, now).level, "pending");
});

test("worktree cleanup marks finished work safe and idle work for review", () => {
  assert.deepEqual(classifyWorktree(tree({ prState: "MERGED", prNumber: 7 }), false, now), { level: "safe", reason: "PR #7 merged" });
  assert.equal(classifyWorktree(tree(), true, now).level, "safe");
  assert.equal(classifyWorktree(tree({ prState: "CLOSED", prNumber: 8 }), false, now).level, "safe");
  assert.equal(classifyWorktree(tree({ activity: now - 30 * DAY }), false, now).level, "review");
});

test("worktree cleanup says when a merged branch was never used", () => {
  assert.equal(classifyWorktree(tree({ ownCommits: 0 }), true, now).reason, "never used: no commits, no changes");
  assert.equal(classifyWorktree(tree({ ownCommits: 3 }), true, now).reason, "branch merged into main (3 commits)");
});

test("an expired reflog falls back to comparing the branch tip with the worktree's creation", () => {
  assert.equal(classifyWorktree(tree({ created: now - DAY, commitTime: now - 2 * DAY }), true, now).reason, "never used: no commits, no changes");
  assert.equal(classifyWorktree(tree({ created: now - 2 * DAY, commitTime: now - DAY }), true, now).reason, "branch merged into main");
});

test("parsePatch flags symlinks by their 120000 mode", async () => {
  const { parsePatch } = await import("./public/code.js");
  const [link, plain] = parsePatch("diff --git a/s b/s\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/s\n@@ -0,0 +1 @@\n+../t\n\\ No newline at end of file\ndiff --git a/n.md b/n.md\nnew file mode 100644\n--- /dev/null\n+++ b/n.md\n@@ -0,0 +1 @@\n+hi\n");
  assert.equal(link.symlink, true);
  assert.equal(link.lines.at(-1).text, "../t");
  assert.equal(plain.symlink, undefined);
});

test("parsePatch numbers lines and reads file status", async () => {
  const { parsePatch } = await import("./public/code.js");
  const [added, changed] = parsePatch("diff --git a/n.md b/n.md\nnew file mode 100644\n--- /dev/null\n+++ b/n.md\n@@ -0,0 +1 @@\n+hi\ndiff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -3,2 +3,2 @@\n a\n-b\n+c\n");
  assert.equal(added.status, "A");
  assert.equal(added.additions, 1);
  assert.deepEqual(changed.lines.map((line: any) => [line.kind, line.old, line.new]), [["hunk", undefined, undefined], ["ctx", 3, 3], ["del", 4, undefined], ["add", undefined, 4]]);
});

test("splitHighlightedLines reopens spans that cross line breaks", async () => {
  const { splitHighlightedLines } = await import("./public/code.js");
  assert.deepEqual(splitHighlightedLines('<span class="c">/* a\nb */</span> x\ny'), ['<span class="c">/* a</span>', '<span class="c">b */</span> x', "y"]);
});

test("prDiscussion merges comments oldest first, flags bots and drops bare approvals", () => {
  const list = prDiscussion(
    [{ id: 1, user: { login: "acme-ci[bot]", type: "Bot" }, body: "Coverage 90%", created_at: "2026-01-03T00:00:00Z" }],
    [{ id: 2, user: { login: "wile", type: "User" }, body: "Why a loop?", created_at: "2026-01-02T00:00:00Z", path: "src/a.py", line: 4 }],
    [{ id: 3, user: { login: "road", type: "User" }, body: "", state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z" },
      { id: 4, user: { login: "road", type: "User" }, body: "Looks good", state: "COMMENTED", submitted_at: "2026-01-04T00:00:00Z" }],
  );
  assert.deepEqual(list.map((item) => [item.id, item.bot]), [["line-2", false], ["comment-1", true], ["review-4", false]]);
  assert.equal(list[0].path, "src/a.py");
});
