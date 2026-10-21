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

const linearRaw = (identifier: string, title: string, state: [string, string], extra: Record<string, unknown> = {}) => ({
  identifier, title, url: `https://linear.app/acme/issue/${identifier}`, description: "", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
  priorityLabel: "High", state: { name: state[0], type: state[1] }, team: { key: "ATL" }, labels: { nodes: [] }, relations: { nodes: [] },
  attachments: { nodes: [] }, syncedWith: [], comments: { nodes: [] }, ...extra,
});

test("Linear projects carry their body, custom status, priority, milestones and resources", async () => {
  const { slimLinearProject } = await import("./linear.ts");
  const project = slimLinearProject({
    slugId: "p1", name: "Atlas onboarding", url: "https://linear.app/acme/project/p1", status: { name: "Ideas", type: "backlog" }, priorityLabel: "High",
    description: "One line.", content: "# Atlas onboarding\n\nThe body.", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
    labels: { nodes: [{ name: "q4" }] }, externalLinks: { nodes: [{ label: "Spec", url: "https://example.com/spec" }] },
    projectMilestones: { nodes: [{ name: "Second", sortOrder: 2, progress: 0, status: "unstarted" }, { name: "First", sortOrder: 1, progress: 1, status: "done", targetDate: "2026-11-01" }] },
  }, "ATL");
  assert.equal(project.status, "Ideas");
  assert.equal(project.category, "new");
  assert.equal(project.priority, "High");
  assert.equal(project.description, "One line.\n\n# Atlas onboarding\n\nThe body.");
  assert.deepEqual(project.labels, ["q4"]);
  assert.deepEqual(project.resources, [{ name: "Spec", url: "https://example.com/spec" }]);
  assert.deepEqual(project.milestones!.map((item) => [item.name, item.target, item.status]), [["First", "2026-11-01", "done"], ["Second", "", "unstarted"]]);
});

test("Linear issues and projects join Jira ones: sync copies, imports, and matching titles group together", async (t) => {
  const { fetchLinear, slimLinearIssue } = await import("./linear.ts");
  const { clustersOf, pairIssues } = await import("./issues.ts");
  const original = slimLinearIssue(linearRaw("ATL-2845", "Onboarding checklist survives a reload", ["Backlog", "backlog"], { project: { slugId: "p1" }, attachments: { nodes: [{ url: "https://github.com/acme/atlas/pull/7" }] } }));
  assert.equal(original.key, "linear:ATL-2845");
  assert.equal(original.label, "ATL-2845");
  assert.equal(original.parent, "linear-project:p1");
  assert.deepEqual(original.prUrls, ["https://github.com/acme/atlas/pull/7"]);
  const mirror = slimLinearIssue(linearRaw("ATL-2990", "Onboarding checklist survives a reload", ["Canceled", "canceled"], { syncedWith: [{ metadata: { issueKey: "OPS-113" } }] }));
  const lonely = slimLinearIssue(linearRaw("ATL-3000", "Shared links open the wrong workspace", ["Triage", "triage"]));
  assert.equal(lonely.triage, true);
  const jira = ["OPS-113", "OPS-115", "OPS-112"].map((key) => slimIssue(fixture(key)));
  const pairs = pairIssues([original, mirror, lonely, ...jira], ["ATL"]);
  assert.deepEqual(pairs.map((pair) => [pair.a, pair.b, pair.kind]), [["linear:ATL-2990", "OPS-113", "mirror"], ["OPS-113", "linear:ATL-2845", "import"], ["linear:ATL-3000", "OPS-115", "title"]]);
  assert.deepEqual(clustersOf(pairs).map((keys) => keys.sort()), [["OPS-113", "linear:ATL-2845", "linear:ATL-2990"], ["OPS-115", "linear:ATL-3000"]]);

  const pages: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    pages.push(variables);
    const nodes = query.includes("projects(") ? [{ slugId: "p1", name: "Workspace onboarding", state: "started", health: "atRisk", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z", projectUpdates: { nodes: [{ body: "Slipping a week." }] } }]
      : variables.after ? [linearRaw("ATL-3000", "Shared links open the wrong workspace", ["Triage", "triage"])] : [linearRaw("ATL-2845", "Onboarding checklist survives a reload", ["Backlog", "backlog"])];
    const connection = query.includes("projects(") ? "projects" : "issues";
    return Response.json({ data: { team: { [connection]: { nodes, pageInfo: { hasNextPage: connection === "issues" && !variables.after, endCursor: "c1" } } } } });
  });
  const result = await fetchLinear(async (query, variables) => (await (await fetch("x", { method: "POST", body: JSON.stringify({ query, variables }) })).json()).data, ["ATL"], "2026-10-09T00:00:00Z");
  assert.deepEqual(result.issues.map((issue) => issue.label), ["ATL-2845", "ATL-3000"], "issues page through endCursor");
  assert.deepEqual(pages[0].filter, { updatedAt: { gt: "2026-10-09T00:00:00Z" } }, "an incremental read filters by updatedAt");
  assert.equal(result.projects[0].confidence, "🟡 At Risk");
  assert.equal(result.projects[0].statusUpdate, "Slipping a week.");
});
