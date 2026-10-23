import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPlans, folderDocs, mapPaths, newestTimes, prTouches, statusOf } from "./plans.ts";
import { setConfig } from "./public/config.js";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", ["-C", cwd, "-c", "user.name=Alex", "-c", "user.email=alex@acme.test", ...args]);

// A repository whose origin/main holds the acme fixtures, then a local edit that isn't on main.
async function fixtureRepo() {
  const repo = await mkdtemp(join(tmpdir(), "plans-repo-"));
  await cp(new URL("./fixtures/plans", import.meta.url), repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "Plans");
  await git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  await writeFile(join(repo, "docs/intent/ledger-sync/intent-brief.md"), "# Local only\n");
  await git(repo, "commit", "-qam", "Not pushed");
  return repo;
}

test("initiative maps are found outside hidden, dependency, and vendor folders", () => {
  assert.deepEqual(mapPaths(["a/initiative-map.json", "vendor/x/initiative-map.json", ".hidden/initiative-map.json", "node_modules/p/initiative-map.json", "initiative-map.json"]), ["a/initiative-map.json", "initiative-map.json"]);
});

test("an initiative's documents put the lifecycle briefs first and leave nested initiatives out", () => {
  const files = ["i/initiative-map.json", "i/notes.md", "i/shape.md", "i/intent.md", "i/child/initiative-map.json", "i/child/plan.md"];
  const docs = folderDocs("i", files, ["i", "i/child"], { shape_brief: { path: "shape.md", status: "current" }, intent_brief: { path: "intent.md" } });
  assert.deepEqual(docs.map((doc) => [doc.path, doc.label]), [["i/intent.md", "Intent"], ["i/shape.md", "Shape"], ["i/notes.md", "Notes"]]);
});

test("a map without a status gets one inferred from its milestones", () => {
  assert.deepEqual(statusOf({ initiative: { status: "Paused" } }), { status: "paused", inferred: false, evidence: "" });
  assert.equal(statusOf({ implementation: { milestones: [{ status: "done" }, { status: "planned" }] } }).status, "active");
  assert.equal(statusOf({ implementation: { milestones: [{ status: "done" }] } }).status, "completed");
  assert.equal(statusOf({}).status, "planned");
});

test("commit times come from the newest commit that touched each path", () => {
  assert.deepEqual([...newestTimes("\x00200\n\na.md\n\x00100\n\na.md\nb.md\n")], [["a.md", 200_000], ["b.md", 100_000]]);
});

test("an open PR edits, retires, or proposes initiatives", () => {
  const { touched, added } = prTouches({ files: [
    { path: "docs/a/plan.md", changeType: "MODIFIED" },
    { path: "docs/b/initiative-map.json", changeType: "DELETED" },
    { path: "docs/c/initiative-map.json", changeType: "ADDED" },
    { path: "src/app.ts", changeType: "MODIFIED" },
  ] }, ["docs/a", "docs/b"]);
  assert.deepEqual([...touched].map(([folder, entry]) => [folder, entry.change]), [["docs/a", "edits"], ["docs/b", "retires"]]);
  assert.deepEqual(added, ["docs/c/initiative-map.json"]);
});

test("plans come from origin/main, with invalid maps as error rows and briefs read by commit", async () => {
  setConfig({ code: { planSkill: "plan-skill" } });
  const repo = await fixtureRepo();
  const root = await mkdtemp(join(tmpdir(), "plans-root-"));
  const plans = createPlans(root, { repos: async () => [repo], slug: async () => "" });
  const { initiatives, repos } = await plans.load();
  assert.equal(repos[0].base, "origin/main");
  assert.deepEqual(initiatives.map((item) => item.slug).sort(), ["broken", "ledger-sync", "offline-mode"]);
  const ledger = initiatives.find((item) => item.slug === "ledger-sync")!;
  assert.equal(ledger.status, "active");
  assert.deepEqual(ledger.dependsOn, ["offline-mode"]);
  assert.deepEqual(ledger.docs.map((doc) => doc.label), ["Intent", "Shape"]);
  assert.equal(ledger.history[0].event, "shape-created");
  assert.deepEqual(ledger.briefs, { intent_brief: "current", shape_brief: "current", implementation_plan: "not-created" });
  assert.deepEqual(ledger.milestones, [{ id: "M1", title: "Webhook receiver", status: "planned" }]);
  assert.ok(ledger.edited > 0);
  const offline = initiatives.find((item) => item.slug === "offline-mode")!;
  assert.equal(offline.inferred, true);
  assert.deepEqual(offline.docs.map((doc) => doc.name), ["notes/research.md", "plan.md"]);
  assert.match(initiatives.find((item) => item.slug === "broken")!.error!, /initiative-map\.json/);

  const brief = await plans.doc(repo, ledger.ref, "docs/intent/ledger-sync/intent-brief.md");
  assert.match(brief.body, /^# Ledger sync: intent/); // main's copy, not the unpushed edit
  await assert.rejects(plans.doc(repo, "HEAD", "docs/intent/ledger-sync/intent-brief.md"), /Unknown commit/);
  await assert.rejects(plans.doc(repo, ledger.ref, "../secrets.md"), /Bad path/);
  await assert.rejects(plans.doc("/elsewhere", ledger.ref, "x.md"), /Not a tracked/);
  assert.equal((await plans.map(ledger.id)).map.initiative.slug, "ledger-sync");

  const { draft } = await plans.prompt("claude", ledger.id, "update", "docs/intent/ledger-sync/shape-brief.md");
  assert.match(draft, /^Use \/plan-skill to update the initiative "Ledger sync for Atlas"/);
  assert.match(draft, /Open document: .*shape-brief\.md/);
  assert.match(draft, /\n---\n\n$/);
  assert.match((await plans.prompt("codex", offline.id, "retire", "")).draft, /^Use the plan-skill skill to retire .* I approve retiring it/);
  setConfig({});
});
