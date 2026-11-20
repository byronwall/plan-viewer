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

test("checkoutPr adds a worktree for a branch only on origin, then reuses it", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { createCodeDashboard } = await import("./code-dashboard.ts");
  const base = await realpath(await mkdtemp(join(tmpdir(), "checkout-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@acme.test", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@acme.test" } }).toString();
  const origin = join(base, "origin.git"), repo = join(base, "app"), root = join(base, "planning");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, repo], { stdio: "pipe" });
  git(repo, "commit", "-q", "--allow-empty", "-m", "first");
  git(repo, "push", "-q", "origin", "HEAD:main", "HEAD:refs/heads/acme/feature");
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config/code-repos.json"), JSON.stringify({ repos: [repo] }));
  const dashboard = createCodeDashboard(root);
  const [first, duplicate] = await Promise.all([dashboard.checkoutPr(repo, "acme/feature"), dashboard.checkoutPr(repo, "acme/feature")]);
  assert.deepEqual(first, duplicate);
  assert.deepEqual(first, { path: join(base, "app-worktrees/acme-feature"), created: true });
  assert.equal(git(first.path, "rev-parse", "--abbrev-ref", "HEAD").trim(), "acme/feature");
  assert.equal(git(first.path, "rev-parse", "--abbrev-ref", "@{upstream}").trim(), "origin/acme/feature");
  assert.deepEqual(await dashboard.checkoutPr(repo, "acme/feature"), { ...first, created: false });
  git(first.path, "branch", "--unset-upstream");
  git(first.path, "commit", "-q", "--allow-empty", "-m", "local work");
  const head = git(first.path, "rev-parse", "HEAD");
  await writeFile(join(first.path, "notes"), "local edits");
  await dashboard.checkoutPr(repo, "acme/feature");
  assert.equal(git(first.path, "rev-parse", "--abbrev-ref", "@{u}").trim(), "origin/acme/feature");
  assert.equal(git(first.path, "rev-parse", "HEAD"), head);
  assert.match(git(first.path, "status", "--porcelain"), /\?\? notes/);
  git(first.path, "branch", "--set-upstream-to=origin/main");
  await assert.rejects(dashboard.checkoutPr(repo, "acme/feature"), /tracks refs\/remotes\/origin\/main/);
  git(repo, "push", "origin", "HEAD:refs/heads/acme/local");
  git(repo, "branch", "--no-track", "acme/local", "HEAD");
  const local = await dashboard.checkoutPr(repo, "acme/local");
  assert.equal(git(local.path, "rev-parse", "--abbrev-ref", "@{u}").trim(), "origin/acme/local");

  // A registered worktree can disappear or be replaced by an unrelated clone on the same branch.
  await rm(local.path, { recursive: true });
  await assert.rejects(dashboard.checkoutPr(repo, "acme/local"), /missing or belongs to another checkout/);
  execFileSync("git", ["clone", "-q", "-b", "acme/local", origin, local.path], { stdio: "pipe" });
  git(local.path, "branch", "--unset-upstream");
  await assert.rejects(dashboard.checkoutPr(repo, "acme/local"), /missing or belongs to another checkout/);
  assert.throws(() => git(local.path, "rev-parse", "@{u}"));

  const { config, setConfig } = await import("./public/config.js");
  const previous = config();
  t.after(() => setConfig(previous));
  const customDir = join(base, "custom");
  setConfig({ code: { run: { requires: [], worktree: ["git", "worktree", "add", "--no-track", "-b", "{branch}", customDir, "origin/{branch}"] } } });
  await assert.rejects(dashboard.runPr(repo, "acme/feature"), /tracks refs\/remotes\/origin\/main/);
  git(repo, "push", "origin", "HEAD:refs/heads/acme/custom");
  assert.equal((await dashboard.checkoutPr(repo, "acme/custom")).path, customDir);
  assert.equal(git(customDir, "rev-parse", "--abbrev-ref", "@{u}").trim(), "origin/acme/custom");
  git(origin, "update-ref", "-d", "refs/heads/acme/custom");
  await assert.rejects(dashboard.checkoutPr(repo, "acme/custom"), /git fetch failed/);
  await assert.rejects(dashboard.checkoutPr(repo, "--force"), /Not a branch name/);
});

test("PR details use the origin owner and repository, and skip local branches for forks", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, delimiter } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { createCodeDashboard } = await import("./code-dashboard.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "pr-identity-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wrong = join(root, "app"), right = join(root, "renamed-clone");
  for (const [repo, owner] of [[wrong, "another-owner"], [right, "acme"]]) {
    execFileSync("git", ["init", "-q", "-b", "feature", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@acme.test", "commit", "-q", "--allow-empty", "-m", "first"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", `git@github.com:${owner}/app.git`]);
  }
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/code-repos.json"), JSON.stringify({ repos: [wrong, right] }));
  await writeFile(join(root, "gh"), `#!/bin/sh
if [ "$1" = "api" ]; then echo '[]'
elif [ "$3" = "2" ]; then echo '{"headRefName":"feature","isCrossRepository":true}'
else echo '{"headRefName":"feature","isCrossRepository":false}'; fi
`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = root + delimiter + path;
  t.after(() => { process.env.PATH = path; });
  const dashboard = createCodeDashboard(root);
  const sameRepo = await dashboard.prDetail("ACME/app", 1);
  assert.equal(sameRepo.repo, right);
  assert.equal(sameRepo.worktree, right);
  assert.equal((await dashboard.prDetail("acme/app", 2)).worktree, "");
  assert.equal((await dashboard.prDetail("untracked/app", 1)).repo, "");
});
