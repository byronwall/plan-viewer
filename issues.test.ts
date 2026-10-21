import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { adfToMarkdown, aliasesOf, createIssueTracker, diffIssue, keysIn, slimIssue } from "./issues.ts";
import { config, setConfig } from "./public/config.js";

const raw = JSON.parse(await readFile(new URL("./fixtures/jira/issues.json", import.meta.url), "utf8"));
const fixture = (key: string) => raw.find((issue: any) => issue.key === key);

test("Jira's document format becomes Markdown the viewer renders", () => {
  const text = (value: string, marks: any[] = []) => ({ type: "text", text: value, marks });
  const markdown = adfToMarkdown({ type: "doc", content: [
    { type: "heading", attrs: { level: 1 }, content: [text("Plan")] },
    { type: "paragraph", content: [text("Run "), text("npm test", [{ type: "code" }]), text(" then "), text("ship", [{ type: "strong" }, { type: "link", attrs: { href: "https://example.test" } }])] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("one")] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("nested")] }] }] }] }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [text("A")] }] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [text("1")] }] }] }] },
  ] });
  assert.equal(markdown, "### Plan\n\nRun `npm test` then [**ship**](https://example.test)\n\n- one\n  - nested\n\n| A |\n| --- |\n| 1 |");
});

test("an issue keeps its fields, PR links, and comments; a later copy diffs into activity", () => {
  const issue = slimIssue(fixture("OPS-112"));
  assert.equal(issue.parent, "OPS-110");
  assert.equal(issue.category, "indeterminate");
  assert.deepEqual(issue.prUrls, ["https://github.com/acme/atlas/pull/1938"]);
  assert.equal(issue.comments.length, 2);
  const created = diffIssue(undefined, issue).map((row) => row.kind);
  assert.deepEqual(created, ["created", "comment", "comment"]);
  const later = { ...issue, status: "Closed", assignee: null, updated: "2026-10-22T00:00:00.000+0000", comments: [...issue.comments, { id: "9", author: null, created: "2026-10-22T00:00:00.000+0000", body: "Merged." }] };
  assert.deepEqual(diffIssue(issue, later).map((row) => [row.kind, row.from, row.to]), [["status", "In Review", "Closed"], ["assignee", "Alex Rivera", "Unassigned"], ["comment", undefined, undefined]]);
});

test("old tracker keys resolve to the issue they were imported into", () => {
  const issue = slimIssue(fixture("OPS-113"));
  assert.deepEqual(aliasesOf(issue, ["ATL"]), ["ATL-2845"]);
  const issues = new Map([["OPS-113", issue], ["OPS-112", slimIssue(fixture("OPS-112"))]]);
  const aliases = new Map([["ATL-2845", "OPS-113"]]);
  assert.deepEqual(keysIn("alex/atl-2845-checklist and OPS-112, not OPS-1120", issues, aliases), ["OPS-113", "OPS-112"]);
});

test("a sync reads the scope, its parents and epic children, and joins issues to PRs through aliases", async (t) => {
  const saved = config();
  t.after(() => setConfig(saved));
  setConfig({ ...saved, trackers: [{ prefix: "ATL", service: "linear", url: "https://linear.app/acme/issue/{id}" }], issues: { ...saved.issues, jql: "component = Atlas", hideLabels: ["security"], command: ["node", resolve("fixtures/jira/fake-acli.js")] } });
  const root = await mkdtemp(join(tmpdir(), "issues-"));
  const prs = [{ slug: "acme/atlas", number: 2001, title: "Keep the checklist on reload", branch: "alex/atl-2845-checklist", url: "https://github.com/acme/atlas/pull/2001" }];
  const tracker = createIssueTracker(root, async () => ({ prs, worktrees: [{ repo: "/r", path: "/r/wt", branch: "alex/ops-114-name" }] }));
  await tracker.refresh();
  const data: any = await tracker.load();
  const keys = data.issues.map((issue: any) => issue.key);
  assert.ok(keys.includes("OPS-100"), "the parent initiative outside the scope is fetched as context");
  assert.ok(keys.includes("OPS-122"), "an epic's child outside the scope is fetched as context");
  assert.equal(data.issues.find((issue: any) => issue.key === "OPS-122").inScope, false);
  assert.equal(data.issues.find((issue: any) => issue.key === "OPS-130").bot, true);
  assert.equal(data.me, "alex@acme.test");
  assert.equal(data.aliases["ATL-2845"], "OPS-113");
  assert.deepEqual(data.code["OPS-113"].prs.map((pr: any) => pr.number), [2001]);
  assert.deepEqual(data.code["OPS-112"].prs.map((pr: any) => pr.number), [1938], "a PR linked from the description");
  assert.equal(data.code["OPS-114"].worktrees[0].path, "/r/wt");
  assert.ok(data.activity.some((row: any) => row.kind === "comment" && row.key === "OPS-112"));
  assert.equal(tracker.aliasMetadata(["linear:ATL-2845"])["linear:ATL-2845"].state, "Backlog · now OPS-113");
  assert.ok(!("description" in data.issues[0]), "long text stays in the detail call");
  assert.match(tracker.detail("OPS-112").description, /Show three templates/);
});
