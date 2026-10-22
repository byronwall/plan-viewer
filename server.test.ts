import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { refreshSlackChannels } from "./link-metadata.ts";
import { claudeNewSessionUrl, CodexDesktopClient, codexNewTaskUrl, taskTitle, withImages } from "./codex-desktop.ts";
import { inlineMarkdown, markdownExcerpt, markdownHeadingId as clientHeadingId, markdownOutline, renderMarkdown, resolveMarkdownAsset, resolveMarkdownAttachment, resolveMarkdownLink } from "./public/markdown.js";
import { buildWeeks, dateKey, parseDateKey, startOfWeek } from "./public/weeks.js";
import { ROOT, buildCodexPrompt, saveHandoffImages, dailyDigest, buildDocumentCodexPrompt, buildGlobalCodexPrompt, isViewableDocumentPath, listDocuments, loadDocument, markdownHeadingId, parseChunks, parseTaskDocument, safeAssetPath, setTaskStatus, slackDeepLink, summarize } from "./server.ts";

test("Slack refresh updates renamed channels, adds linked channels, and preserves other Markdown", async (t) => {
  const previous = process.env.SLACK_TOKEN;
  process.env.SLACK_TOKEN = "test-token";
  t.after(() => { if (previous === undefined) delete process.env.SLACK_TOKEN; else process.env.SLACK_TOKEN = previous; });
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const id = new URL(url).searchParams.get("channel")!;
    seen.push(id);
    return Response.json({ ok: true, channel: { id, name: id === "C0ACME0001" ? "team-atlas" : "new-channel" } });
  });
  const source = "# Channels\n\nKeep this paragraph.\n\n- C0ACME0001: #old-name\n- D12345678: Direct message\n";
  const result = await refreshSlackChannels(ROOT, source, ["C0ACME0001", "C0ACME0002"]);
  assert.equal(result, source.replace("#old-name", "#team-atlas") + "- C0ACME0002: #new-channel\n");
  assert.deepEqual(seen, ["C0ACME0001", "C0ACME0002"]);
});

test("Slack refresh rejects failed and mismatched lookups instead of returning partial updates", async (t) => {
  const previous = process.env.SLACK_TOKEN;
  process.env.SLACK_TOKEN = "test-token";
  t.after(() => { if (previous === undefined) delete process.env.SLACK_TOKEN; else process.env.SLACK_TOKEN = previous; });
  const source = "- C0ACME0001: #old-name\n- C0ACME0002:\n";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const id = new URL(url).searchParams.get("channel")!;
    return Response.json(id === "C0ACME0001" ? { ok: true, channel: { id, name: "renamed" } } : { ok: false, error: "channel_not_found" });
  });
  await assert.rejects(refreshSlackChannels(ROOT, source, []), /C0ACME0002: channel_not_found/);
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, channel: { id: "C00000000", name: "wrong" } }));
  await assert.rejects(refreshSlackChannels(ROOT, source, []), /invalid channel response/);
});

test("parses structured milestones as complete work chunks", () => {
  const chunks = parseChunks(`# Plan\n\nIntro.\n\n## Milestone 1: First slice\n\nOutcome one.\n\n### Desired end state\n\n- Works\n\n## Milestone 2: Second slice\n\nOutcome two.`);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].title, "Overview");
  assert.equal(chunks[1].title, "Milestone 1: First slice");
  assert.match(chunks[1].markdown, /Desired end state/);
  assert.doesNotMatch(chunks[1].markdown, /Outcome two/);
});

test("falls back to numbered priorities", () => {
  const chunks = parseChunks(`# Plan\n\n## Priorities\n\n### 1. Ship it\n\nOutcome.\n\n### 2. Verify it\n\nChecks.`);
  assert.deepEqual(chunks.slice(1).map((chunk) => chunk.title), ["1. Ship it", "2. Verify it"]);
});

test("keeps decimal-numbered H3 sections beneath their H2 parent", () => {
  const chunks = parseChunks(`# Capability decomposition

## 1. Provision and connect a sandbox instance

### 1.1 Provision an instance

First capability.

### 1.2 Use a prepared sandbox

Second capability.

## 2. Build a catalog from sample data

### 2.1 Select sources and generate a model

Third capability.`);
  assert.deepEqual(chunks.map((chunk) => chunk.title), [
    "1. Provision and connect a sandbox instance",
    "2. Build a catalog from sample data",
  ]);
  assert.match(chunks[0].markdown, /^### 1\.1 Provision an instance/m);
  assert.match(chunks[0].markdown, /^### 1\.2 Use a prepared sandbox/m);
  assert.doesNotMatch(chunks[0].markdown, /^### 2\.1/m);
});

test("uses stable Markdown anchors for document chunks", () => {
  const title = "Milestone 4 implementation — Preserve report totals";
  assert.equal(markdownHeadingId(title), "milestone-4-implementation--preserve-report-totals");
  assert.equal(clientHeadingId(title), markdownHeadingId(title));
  assert.equal(parseChunks(`## ${title}\n\nComplete.`)[0].anchor, markdownHeadingId(title));
});

test("resolves relative Markdown links and fragments inside the viewer", () => {
  assert.deepEqual(
    resolveMarkdownLink("done.md#milestone-4-implementation--preserve-report-totals", "daily/2026/07/31/plan.md"),
    {
      kind: "document",
      path: "daily/2026/07/31/done.md",
      anchor: "milestone-4-implementation--preserve-report-totals",
    },
  );
  assert.deepEqual(
    resolveMarkdownLink("../../../../plans/atlas-orbit-boundary/README.md", "daily/2026/07/31/done.md"),
    { kind: "document", path: "plans/atlas-orbit-boundary/README.md", anchor: "" },
  );
  assert.deepEqual(
    resolveMarkdownLink("../../../../tasks/TASK-0001.md", "daily/2026/08/03/plan.md"),
    { kind: "document", path: "tasks/TASK-0001.md", anchor: "" },
  );
});

test("parses the minimum file-backed task contract", () => {
  const source = `---
id: TASK-0042
title: Prove the loop
summary: Keep one authoritative description.
status: waiting
project: Daily planning
tags: [tasks, viewer]
created: 2026-08-03
updated: 2026-08-04
---

# Prove the loop

## Updates

- Created.`;
  const parsed = parseTaskDocument("tasks/TASK-0042.md", source);
  assert.deepEqual(parsed.task, {
    id: "TASK-0042",
    title: "Prove the loop",
    summary: "Keep one authoritative description.",
    status: "waiting",
    project: "Daily planning",
    tags: ["tasks", "viewer"],
    created: "2026-08-03",
    updated: "2026-08-04",
  });
  assert.match(parsed.body, /^# Prove the loop/);
  assert.doesNotMatch(parsed.body, /^---/);
});

test("rejects task IDs and states outside the stable contract", () => {
  const source = `---
id: TASK-0042
title: Prove the loop
summary: Keep one authoritative description.
status: blocked
project: Daily planning
tags: []
created: 2026-08-03
updated: 2026-08-03
---
`;
  assert.throws(() => parseTaskDocument("tasks/TASK-0041.md", source), /same TASK-0000 ID/);
  assert.throws(() => parseTaskDocument("tasks/TASK-0042.md", source), /unsupported task status/);
});

test("renders internal and external links with distinct safe behavior", () => {
  const html = inlineMarkdown("See [Done](done.md#completed-outcomes) and [PR](https://github.com/example/repo/pull/1).", "daily/2026/07/31/plan.md");
  assert.match(html, /class="markdown-document-link"/);
  assert.match(html, /data-document-path="daily\/2026\/07\/31\/done\.md"/);
  assert.match(html, /data-document-anchor="completed-outcomes"/);
  assert.match(html, /class="markdown-external-link"/);
  assert.match(html, /target="_blank"/);
  assert.doesNotMatch(inlineMarkdown("[unsafe](javascript:alert(1))", "daily/2026/07/31/plan.md"), /href=/);
});

test("links commit SHAs to GitHub, inferring the repository from earlier references", () => {
  const commits = (source) => [...inlineMarkdown(source, "tasks/TASK-0001.md").matchAll(/href="https:\/\/github\.com\/acme\/([\w.-]+)\/commit\/(\w+)"/g)].map(([, repo, sha]) => `${repo}@${sha}`);
  assert.deepEqual(commits("[#1831](https://github.com/acme/atlas/pull/1831) is at head 052702c8234c."), ["atlas@052702c8234c"]);
  assert.deepEqual(commits("Orbit#3072 landed as 1a2b3c4d and `9f8e7d6`."), ["Orbit@1a2b3c4d", "Orbit@9f8e7d6"]);
  assert.deepEqual(commits("Merged Orbit@abcdef1, then atlas head 0a1b2c3d4e5f."), ["Orbit@abcdef1", "Orbit@0a1b2c3d4e5f"]);
  assert.deepEqual(commits("Plain 7f3e2d1 defaults to Atlas; `orbit-legacy@deadbeef` is explicit."), ["atlas@7f3e2d1", "orbit-legacy@deadbeef"]);
  assert.deepEqual(commits("Not commits: decade, 20261013, #3157d5, 01a1350b-b433, ABCDEF1234, codex://threads/01a1350b."), []);
});

test("links every item of a slash list with the first reference's prefix", () => {
  const hrefs = (source) => [...inlineMarkdown(source, "tasks/TASK-0001.md").matchAll(/(?:href|data-document-path)="([^"?]+)"/g)].map(([, href]) => href.replace(/^https:\/\/[^/]+\//, ""));
  assert.deepEqual(hrefs("Preserve TASK-0016/0017/0024."), ["tasks/TASK-0016.md", "tasks/TASK-0017.md", "tasks/TASK-0024.md"]);
  assert.deepEqual(hrefs("plus ATL-2733/2734 and OPS-54562/54852"), ["acme/issue/ATL-2733", "acme/issue/ATL-2734", "browse/OPS-54562", "browse/OPS-54852"]);
  assert.deepEqual(hrefs("#1831/#1872, Orbit#2738/2740"), ["acme/atlas/pull/1831", "acme/atlas/pull/1872", "acme/Orbit/pull/2738", "acme/Orbit/pull/2740"]);
  assert.deepEqual(hrefs("see https://linear.app/acme/issue/ATL-2312/fix-totals"), []);
});

test("daily digests list scheduled tasks with notes, done mentions, and work headings", () => {
  const plan = dailyDigest("# Daily plan\n\n## Scheduled tasks\n\n- [TASK-0030](../TASK-0030.md) — Read the catch-up.\n- TASK-0031 — First: containment.\n- TASK-0030 again\n\n## Milestone 2: Automatic recovery\n\n## 3. Frontend triage picks\n\n## Below the cut line\n");
  assert.deepEqual(plan.tasks, [{ id: "TASK-0030", note: "Read the catch-up." }, { id: "TASK-0031", note: "First: containment." }]);
  assert.deepEqual(plan.headings, ["Automatic recovery", "Frontend triage picks"]);
  assert.equal(plan.items, 3);
  assert.deepEqual(dailyDigest("- Closed TASK-0013 and refreshed TASK-0001.\n- Other outcome.").mentions, ["TASK-0013", "TASK-0001"]);
});

test("renders repository-local Markdown images with accessible responsive markup", () => {
  const source = "![Atlas onboarding flow](../plans/atlas-onboarding/assets/onboarding-flow.png)";
  const html = renderMarkdown(source, "tasks/TASK-0001.md");
  assert.match(html, /^<figure class="markdown-figure"><button class="markdown-image-trigger" type="button"/);
  assert.match(html, /aria-label="Open Atlas onboarding flow in image viewer"/);
  assert.match(html, /<img class="markdown-image"/);
  assert.match(html, /src="\/api\/asset\?path=plans%2Fatlas-onboarding%2Fassets%2Fonboarding-flow\.png"/);
  assert.match(html, /alt="Atlas onboarding flow"/);
  assert.match(html, /loading="lazy" decoding="async"/);
  assert.doesNotMatch(html, /^<p>!/);
});

test("resolves only approved repository image assets", () => {
  assert.deepEqual(
    resolveMarkdownAsset("../plans/atlas-onboarding/assets/onboarding-flow.svg", "tasks/TASK-0001.md"),
    { kind: "asset", path: "plans/atlas-onboarding/assets/onboarding-flow.svg" },
  );
  assert.deepEqual(resolveMarkdownAsset("https://example.com/diagram.png", "tasks/TASK-0001.md"), { kind: "unavailable" });
  assert.deepEqual(resolveMarkdownAsset("../../outside.png", "tasks/TASK-0001.md"), { kind: "unavailable" });
  assert.deepEqual(resolveMarkdownAsset("../plans/topic/notes.md", "tasks/TASK-0001.md"), { kind: "unavailable" });
  assert.deepEqual(resolveMarkdownAsset("https://uploads.linear.app/org/a/b", ""), { kind: "remote", href: "/api/linear-image?url=https%3A%2F%2Fuploads.linear.app%2Forg%2Fa%2Fb" });
});

test("GitHub bodies: raw img and details tags render, attachment images go through the proxy", () => {
  const src = "/api/github-image?slug=acme%2Fatlas&number=7&id=a0251724-7d15-4c41-b0a9-392837578513";
  const html = renderMarkdown(`<details> <summary>Try it **locally**</summary>\n\nRun \`dev\`.\n\n</details>\n\n<img width="1280" alt="Closed [sidebar]" src="${src}"\n/>\n\n**[notes.md](https://acme.example/n)**`, "");
  assert.match(html, /<details class="markdown-details"><summary>Try it <strong>locally<\/strong><\/summary><p>Run <code>dev<\/code>\.<\/p><\/details>/);
  assert.match(html, /<figure class="markdown-figure">.*<img class="markdown-image" src="\/api\/github-image\?slug=acme%2Fatlas&amp;number=7&amp;id=a0251724-[^"]*" alt="Closed sidebar"/);
  assert.match(html, /<strong><a class="markdown-external-link" href="https:\/\/acme\.example\/n"/);
  assert.doesNotMatch(renderMarkdown('<img src="javascript:alert(1)">', ""), /<img/);
});

test("angle-bracket link destinations, as Linear writes them, stay live", () => {
  assert.match(inlineMarkdown("[report](<https://acme.example/r/1>)", ""), /href="https:\/\/acme\.example\/r\/1"/);
});

test("links approved rendered and editable repository assets", () => {
  const html = inlineMarkdown("[Open SVG](../plans/topic/diagram.svg) · [Edit source](../plans/topic/diagram.dot)", "tasks/TASK-0001.md");
  assert.match(html, /class="markdown-asset-link" href="\/api\/asset\?path=plans%2Ftopic%2Fdiagram\.svg"/);
  assert.match(html, /href="\/api\/asset\?path=plans%2Ftopic%2Fdiagram\.dot"/);
  assert.equal(resolveMarkdownAttachment("../plans/topic/diagram.pdf", "tasks/TASK-0001.md").kind, "unavailable");
});

test("serves only traversal-safe repository image paths", () => {
  const asset = safeAssetPath("plans/atlas-onboarding/assets/onboarding-flow.png");
  assert.equal(asset.relative, "plans/atlas-onboarding/assets/onboarding-flow.png");
  assert.match(asset.absolute, /plans\/atlas-onboarding\/assets\/onboarding-flow\.png$/);
  assert.throws(() => safeAssetPath("../outside.png"), /Invalid asset path/);
  assert.throws(() => safeAssetPath("viewer/public/index.html"), /Invalid asset path/);
  assert.throws(() => safeAssetPath("plans/topic/diagram.pdf"), /Invalid asset path/);
  assert.equal(safeAssetPath("plans/topic/diagram.dot").relative, "plans/topic/diagram.dot");
});

test("keeps unavailable images readable without exposing an unsafe source", () => {
  const html = renderMarkdown("![Unsafe diagram](javascript:alert(1))", "tasks/TASK-0001.md");
  assert.match(html, /class="markdown-unavailable-image"/);
  assert.match(html, /aria-label="Unavailable image: Unsafe diagram"/);
  assert.doesNotMatch(html, /src=/);
});

test("creates a concise plain-text preview from chunk Markdown", () => {
  const excerpt = markdownExcerpt("### Desired end state\n\n- Review [the completed work](done.md#complete).\n- Keep `acme init` focused.\n\n**Ship** when green.");
  assert.equal(excerpt, "Desired end state Review the completed work. Keep acme init focused. Ship when green.");
  assert.equal(markdownExcerpt("One two three four five six", 14), "One two three…");
});

test("renders level-five Markdown headings as headings", () => {
  const html = renderMarkdown("##### Desired end state\n\n- Works");
  assert.match(html, /^<h4 id="desired-end-state">Desired end state<\/h4>/);
  assert.doesNotMatch(html, /#####/);
});

test("renders tables whose delimiter cells have fewer than three dashes, as Linear writes them", () => {
  assert.match(renderMarkdown("| A | B |\n| -- | -- |\n| 1 | 2 |"), /<table/);
});

test("preserves nested Markdown list structure and inline emphasis", () => {
  const html = renderMarkdown(`- **Change — Pin the base demonstration path**
  - Use one named instance.
  - Confirm the deployment path.
- **Change — Capture the first evidence**
  1. Record the expected answer.
  2. Record the timing.`);

  assert.equal(html, '<ul><li><strong>Change — Pin the base demonstration path</strong><ul><li>Use one named instance.</li><li>Confirm the deployment path.</li></ul></li><li><strong>Change — Capture the first evidence</strong><ol><li>Record the expected answer.</li><li>Record the timing.</li></ol></li></ul>');
});

test("keeps nested task-list controls inside their parent list item", () => {
  const html = renderMarkdown("- Release checks\n  - [x] Renderer tested\n  - [ ] Browser verified");
  assert.match(html, /^<ul><li>Release checks<ul><li><input class="task-box"[^>]+checked/);
  assert.match(html, /<\/li><li><input class="task-box"[^>]+>Browser verified<\/li><\/ul><\/li><\/ul>$/);
});

test("builds a nested table-of-contents outline without treating code as headings", () => {
  const outline = markdownOutline(`### Deployment

#### Networking

##### Private endpoints

#### Observability

\`\`\`
#### Not a heading
\`\`\``, 2);
  assert.deepEqual(outline, [{
    level: 3,
    title: "Deployment",
    anchor: "deployment",
    children: [
      { level: 4, title: "Networking", anchor: "networking", children: [
        { level: 5, title: "Private endpoints", anchor: "private-endpoints", children: [] },
      ] },
      { level: 4, title: "Observability", anchor: "observability", children: [] },
    ],
  }]);
});

test("turns repository-local text paths into viewer links", () => {
  const html = inlineMarkdown("Transcript: `daily/2026/07/31/orbit-cross-team-dependencies-transcript.txt`", "daily/2026/07/31/orbit-dependency-context.md");
  assert.match(html, /class="markdown-document-link code-file-link"/);
  assert.match(html, /data-document-path="daily\/2026\/07\/31\/orbit-cross-team-dependencies-transcript\.txt"/);
  assert.doesNotMatch(inlineMarkdown("`\/Users\/alex\/.codex\/attachments\/note.txt`", "daily/2026/07/31/plan.md"), /href=/);
});

test("renders GFM tables as semantic, scrollable tables", () => {
  const html = renderMarkdown(`| Step | Owner | Result |
| --- | :---: | ---: |
| Prepare | **Platform** | \`infra_ready\` |
| Validate | Customer | [Runbook](https://example.com/runbook) |`, "tasks/TASK-0001.md");
  assert.match(html, /class="markdown-table-scroll"/);
  assert.match(html, /<table><thead><tr>/);
  assert.match(html, /<th class="align-center" scope="col">Owner<\/th>/);
  assert.match(html, /<td class="align-right"><a class="markdown-external-link"/);
  assert.match(html, /<strong>Platform<\/strong>/);
  assert.doesNotMatch(html, /<p>\| Step \|/);
});

test("dispatch prompt identifies the source and preserves commentary", async () => {
  const document = await loadDocument("daily/2026/07/31/plan.md");
  const chunk = document.chunks.find((candidate) => candidate.title.startsWith("Milestone 2"));
  assert.ok(chunk);
  const prompt = buildCodexPrompt(document, chunk, "Please turn this into the next concrete action.");
  assert.match(prompt, /daily\/2026\/07\/31\/plan\.md/);
  assert.match(prompt, /single-command `acme init` bootstrap/);
  assert.match(prompt, /Please turn this into the next concrete action/);
});

test("file handoff attaches the path without copying the file contents", async () => {
  const document = await loadDocument("daily/2026/07/31/plan.md");
  const prompt = buildDocumentCodexPrompt(document, "Review the whole file.");
  assert.match(prompt, /Source file: daily\/2026\/07\/31\/plan\.md/);
  assert.match(prompt, /Review the whole file/);
  assert.doesNotMatch(prompt, /single-command `acme init` bootstrap/);
});

test("pasted handoff images are saved under tmp and listed in the prompt", async () => {
  const [path] = await saveHandoffImages([`data:image/png;base64,${Buffer.from("png").toString("base64")}`]);
  assert.ok(path.startsWith(`${ROOT}/tmp/handoff-images/`) && path.endsWith(".png"));
  assert.equal(await readFile(path, "utf8"), "png");
  await rm(path);
  assert.match(withImages("Fix it.", [path]), /Fix it\.\n\nAttached images[^\n]*\n- .*\.png$/);
  assert.equal(withImages("Fix it.", []), "Fix it.");
  await assert.rejects(saveHandoffImages(["data:text/html;base64,PGI+"]), /Only PNG/);
});

test("global handoff carries no file or chunk context", () => {
  const prompt = buildGlobalCodexPrompt("Help me plan tomorrow.");
  assert.match(prompt, /Help me plan tomorrow/);
  assert.match(prompt, /No plan, file, or chunk context is attached/);
  assert.doesNotMatch(prompt, /Source file:/);
});

test("rejects traversal outside the Markdown library", async () => {
  await assert.rejects(() => loadDocument("../AGENTS.md"), /Invalid document path/);
});

test("allows authored Markdown and text assets but ignores generated Linear exports", () => {
  assert.equal(isViewableDocumentPath("daily/2026/07/31/artifacts/transcript.txt"), true);
  assert.equal(isViewableDocumentPath("tasks/TASK-0032-assets/linear-review.md"), true);
  assert.equal(isViewableDocumentPath("tasks/TASK-0032-assets/frames/still.jpg"), false);
  assert.equal(isViewableDocumentPath("daily/2026/07/31/plan.md"), true);
  assert.equal(isViewableDocumentPath("plans/topic/README.md"), true);
  assert.equal(isViewableDocumentPath("reference/repos.md"), true);
  assert.equal(isViewableDocumentPath("tasks/TASK-0001.md"), true);
  assert.equal(isViewableDocumentPath("tasks/notes.md"), false);
  assert.equal(isViewableDocumentPath("reference/linear/ATL-123.md"), false);
  assert.equal(isViewableDocumentPath("/Users/alex/.codex/attachments/pasted-text.txt"), false);
  assert.equal(isViewableDocumentPath("viewer/public/app.js"), false);
});

test("loads a task through the existing renderer without displaying front matter", async () => {
  const document = await loadDocument("tasks/TASK-0001.md");
  assert.equal(document.path, "tasks/TASK-0001.md");
  assert.equal(document.absolutePath, join(ROOT, "tasks", "TASK-0001.md"));
  assert.equal(document.kind, "Task");
  assert.equal(document.task?.id, "TASK-0001");
  assert.equal(document.task?.status, "active");
  assert.ok(document.chunks.length > 1);
  assert.doesNotMatch(document.chunks[0].markdown, /status: active/);
});

test("indexes tasks separately from daily documents", async () => {
  const documents = await listDocuments();
  const task = documents.find((document) => document.path === "tasks/TASK-0001.md");
  assert.equal(task?.group, "Tasks");
  assert.equal(task?.task?.project, "Atlas onboarding");
  assert.deepEqual(task?.task?.tags, ["onboarding", "design-review"]);
});

test("the daily plan schedules the pilot by ID without copying its body", async () => {
  const plan = await loadDocument("daily/2026/08/03/plan.md");
  const milestone = plan.chunks.find((chunk) => chunk.title.startsWith("Milestone 3"));
  assert.ok(milestone);
  assert.match(milestone.markdown, /\[TASK-0001\]\(\.\.\/\.\.\/\.\.\/\.\.\/tasks\/TASK-0001\.md\)/);
  assert.doesNotMatch(milestone.markdown, /updated technical design/);
});

test("loads repository text assets as one plain-text chunk", async () => {
  const document = await loadDocument("daily/2026/07/31/orbit-cross-team-dependencies-transcript.txt");
  assert.equal(document.format, "text");
  assert.equal(document.kind, "Text file");
  assert.equal(document.chunks.length, 1);
  assert.match(document.chunks[0].markdown, /Transcription:/);
});

test("builds consecutive Sunday-to-Saturday weeks across month and year boundaries", () => {
  const december = parseDateKey("2026-12-31");
  assert.ok(december);
  assert.equal(dateKey(startOfWeek(december)), "2026-12-27");
  const weeks = buildWeeks(december, 3);
  assert.deepEqual(weeks.map((week) => [dateKey(week[0]), dateKey(week[6])]), [
    ["2026-12-20", "2026-12-26"],
    ["2026-12-27", "2027-01-02"],
    ["2027-01-03", "2027-01-09"],
  ]);
});

test("rejects invalid calendar dates", () => {
  assert.equal(parseDateKey("2026-02-29"), null);
  assert.equal(parseDateKey("not-a-date"), null);
});

test("groups every file from the current day under Today", () => {
  const paths = ["plan.md", "done.md", "reference.md"].map((file) => `daily/2026/08/03/${file}`);
  const currentDay = paths.map((path) => summarize(path, "# Daily file", "2026-08-03"));
  assert.ok(currentDay.every((document) => document.group === "Today" && document.isToday));
  assert.deepEqual(currentDay.map((document) => document.kind), ["Plan", "Done", "Daily note"]);
});

test("builds a Codex draft link pinned to the workspace", () => {
  const url = new URL(codexNewTaskUrl("Do the work.\nKeep context.", "/Users/me/daily-planning"));
  assert.equal(url.protocol, "codex:");
  assert.equal(url.hostname, "threads");
  assert.equal(url.pathname, "/new");
  assert.deepEqual([...url.searchParams.keys()], ["path", "prompt"]);
  assert.equal(url.searchParams.get("path"), "/Users/me/daily-planning");
  assert.equal(url.searchParams.get("prompt"), "Do the work.\nKeep context.");
});

// Claude matches a local preset by its folder; `environment=` would be read as a cloud environment ID and ignored.
test("builds a Claude draft link that names the repository folder", () => {
  const url = new URL(claudeNewSessionUrl("/Users/me/repos/acme", "Discuss this PR."));
  assert.equal(url.href.split("?")[0], "claude://code/new");
  assert.deepEqual([...url.searchParams.keys()], ["q", "folder"]);
  assert.equal(url.searchParams.get("folder"), "/Users/me/repos/acme");
});

test("uses a concise milestone title in draft-opened logs", () => {
  assert.equal(taskTitle("Milestone 2: Formalize the single-command bootstrap"), "Formalize the single-command bootstrap");
});

test("opens a Codex draft without submitting it", async () => {
  const commands: Array<{ executable: string; args: string[] }> = [];
  const client = new CodexDesktopClient(() => {}, {
    platform: "darwin",
    run: async (executable, args) => { commands.push({ executable, args }); },
  });
  assert.deepEqual(await client.openDraft("/repo", "Milestone 2: Ship it", "Do the work."), { draftOpened: true });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].executable, "/usr/bin/open");
  assert.equal(new URL(commands[0].args[0]).searchParams.get("prompt"), "Do the work.");
  assert.equal(new URL(commands[0].args[0]).searchParams.get("path"), "/repo");
});

test("opens a Claude draft in the workspace folder when Claude is the agent", async () => {
  const commands: string[][] = [];
  const client = new CodexDesktopClient(() => {}, { platform: "darwin", run: async (_executable, args) => { commands.push(args); } });
  await client.openDraft("/repo", "Ship it", "Do the work.", "claude");
  const url = new URL(commands[0][0]);
  assert.equal(url.protocol, "claude:");
  assert.match(url.searchParams.get("q")!, /^Do the work\.\n\nThis session belongs in \/repo\. .*change_directory with \/repo/);
  assert.equal(url.searchParams.get("folder"), "/repo");
});

test("extracts executable prompt blocks and preserves legacy nested actions", async () => {
  const { parseActions } = await import('./public/actions.js');
  const actions = parseActions('### Prove the fix\n\nWork item: W1.1\n\n```prompt\nInspect /repo and reproduce the failure.\nRecord evidence.\n```', 'tasks/TASK-0042.md');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].workItem, 'W1.1');
  assert.equal(actions[0].prompt, 'Inspect /repo and reproduce the failure.\nRecord evidence.');
  assert.equal(actions[0].sourcePath, 'tasks/TASK-0042.md');
  const old = parseActions('- Reproduce it.\n  - Keep the evidence.\n- Verify it.', 'tasks/TASK-0042.md');
  assert.equal(old.length, 2);
  assert.match(old[0].prompt, /Keep the evidence/);
});

test("separates scope nesting from dependencies and blocks invalid graphs", async () => {
  const { parseWorkBreakdown } = await import('./public/actions.js');
  const work = parseWorkBreakdown('- W1: Ship it [open]\n  - W1.1: Prove it [completed]\n  - W1.2: Fix it [open] (after: W1.1)\n  - W1.3: Verify it [open] (after: W1.2)');
  assert.equal(work.nodes[1].parent, 'W1');
  assert.equal(work.nodes[2].ready, true);
  assert.equal(work.nodes[2].level, 1);
  assert.equal(work.nodes[3].ready, false);
  assert.equal(work.nodes[3].level, 2);
  assert.deepEqual(work.warnings, []);
  const broken = parseWorkBreakdown('- A: First [open] (after: B)\n- B: Second [open] (after: A)\n- C: Third [open] (after: missing)\n- C: Duplicate [open]');
  assert.equal(broken.warnings.length, 3);
  assert.ok(broken.nodes.every(n => !n.ready));
});

test("work breakdown diagnostics explain unsupported statuses and how to repair dependent items", async () => {
  const { parseWorkBreakdown, renderWorkBreakdown } = await import('./public/actions.js');
  const source = '- W1: Prepare [done]\n- W2: Verify [open] (after: W1)';
  const work = parseWorkBreakdown(source);
  assert.match(work.warnings[0], /W1: Unsupported status \[done\]. Replace \[done\] with \[completed\]/);
  assert.match(work.warnings[1], /W2 depends on W1, which could not be parsed/);
  assert.equal(work.nodes[0].ready, false);
  const html = renderWorkBreakdown(work, [], 'actions', 'work-breakdown');
  assert.match(html, /Actions are paused/);
  assert.match(html, /data-chunk-id="work-breakdown" data-repair-work/);
  const repaired = parseWorkBreakdown(source.replace('[done]', '[completed]'));
  assert.deepEqual(repaired.warnings, []);
  assert.equal(repaired.nodes[1].ready, true);
  const entirelyInvalid = renderWorkBreakdown(parseWorkBreakdown('- W1: Prepare [unknown]'), [], 'actions', 'work-breakdown');
  assert.match(entirelyInvalid, /Use one of: open, active, waiting, deferred, completed/);
  assert.match(entirelyInvalid, /Prepare fix ↗/);
  assert.doesNotMatch(entirelyInvalid, /Add nested work items/);
});

test("daily next steps resolve scheduled source tasks without copying their prompts", async () => {
  const plan = await loadDocument('daily/2026/10/01/plan.md');
  assert.ok(plan.chunks.some(c => c.title === 'Next steps'));
  assert.ok(plan.scheduledActions.length > 0);
  const action = plan.scheduledActions.find(a => a.sourcePath === 'tasks/TASK-0015.md');
  assert.ok(action);
  const task = await loadDocument(action.sourcePath);
  assert.equal(action.prompt, task.nextActions.find(a => a.id === action.id)?.prompt);
  assert.doesNotMatch(plan.markdown, /```prompt/);
});

test("action handoff needs no extra typing and includes source, bounded prompt and context", async () => {
  const { buildActionPrompt } = await import('./server.ts');
  const task = await loadDocument('tasks/TASK-0015.md');
  const prompt = buildActionPrompt(task, task.nextActions[0], 'Focus on the released versions.');
  assert.ok(prompt.includes(task.absolutePath));
  assert.ok(prompt.includes(task.nextActions[0].prompt));
  assert.match(prompt, /Focus on the released versions/);
  assert.ok(prompt.indexOf('Focus on the released versions') < prompt.indexOf(task.nextActions[0].prompt), "Alex's direction comes before the stored prompt");
  assert.doesNotMatch(buildActionPrompt(task, task.nextActions[0], ''), /Alex's direction/);
});

test("action rendering escapes titles, prompts and graph labels", async () => {
  const { renderActions, renderWorkBreakdown, parseWorkBreakdown } = await import('./public/actions.js');
  const html = renderActions([{ title: '<script>bad</script>', prompt: '<img src=x onerror=bad>', sourcePath: 'tasks/TASK-0001.md' }], 'next');
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /Prepare action/);
  const graph = renderWorkBreakdown(parseWorkBreakdown('- W1: <script>bad</script> [open]'), [], 'work');
  assert.doesNotMatch(graph, /<script>/);
});

test("headings within fenced action prompts do not become task sections or split actions", async () => {
  const { parseActions } = await import('./public/actions.js');
  const markdown = '# Task\n\n## Next actions\n\n### Record findings\n\n```prompt\nUse this report format:\n## Evidence\n### Observation\nRecord results.\n```\n\n## Work breakdown\n\n- W1: Report [open]';
  const chunks = parseChunks(markdown);
  assert.deepEqual(chunks.map(c => c.title), ['Next actions', 'Work breakdown']);
  const actions = parseActions(chunks[0].markdown, 'tasks/TASK-0042.md');
  assert.equal(actions.length, 1);
  assert.match(actions[0].prompt, /### Observation/);
});

test("milestone documents retain actionable and scope sections", () => {
  const chunks = parseChunks('# Task\n\n## Milestone 1: Establish evidence\n\nInvestigate.\n\n## Next actions\n\n### Reproduce\n\n```prompt\nReproduce the failure and record evidence.\n```\n\n## Work breakdown\n\n- W1: Prove it [open]');
  assert.deepEqual(chunks.map(c => c.title), ['Milestone 1: Establish evidence', 'Next actions', 'Work breakdown']);
});

test("renders readable prerequisites alongside the graph arrows", async () => {
  const { renderWorkBreakdown, parseWorkBreakdown } = await import('./public/actions.js');
  const html = renderWorkBreakdown(parseWorkBreakdown('- W1: Evidence [open]\n- W2: Fix [open] (after: W1)'), [], 'work');
  assert.match(html, /After: W1/);
  assert.match(html, /Blocked/);
});

test("setTaskStatus rewrites only status and updated front matter", async () => {
  const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "task-status-"));
  await mkdir(join(root, "tasks"));
  const body = "# T\n\nstatus: open stays in the body.\n";
  await writeFile(join(root, "tasks/TASK-0042.md"), `---\nid: TASK-0042\ntitle: T\nsummary: S\nstatus: open\nproject: P\ntags: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n${body}`);
  const task = await setTaskStatus("tasks/TASK-0042.md", "active", root, "2026-10-01");
  assert.equal(task.status, "active");
  const contents = await readFile(join(root, "tasks/TASK-0042.md"), "utf8");
  assert.match(contents, /^status: active$/m);
  assert.match(contents, /^updated: 2026-10-01$/m);
  assert.ok(contents.endsWith(body));
  await assert.rejects(setTaskStatus("tasks/TASK-0042.md", "bogus", root));
  await assert.rejects(setTaskStatus("daily/2026/10/01/plan.md", "open", root));
});

test("related chats preserve conversation links and ignore examples and snapshots", async () => {
  const { extractChatLinks, renderChatLinks, chatLink } = await import("./public/markdown.js");
  const codex = "codex://threads/019abcde-1234-7000-8000-123456789abc";
  const chatgpt = "https://chatgpt.com/g/g-project/c/12345678-1234-1234-1234-123456789abc";
  const markdown = `## Chats\n\n- [Implementation](${codex})\n- [Discussion](${chatgpt})\n- [Duplicate](${codex})\n- [Snapshot](https://chatgpt.com/share/123)\n\n\`[Example](codex://threads/example)\`\n\n\`\`\`prompt\n[Prompt example](codex://threads/prompt-example)\n\`\`\`\n\n~~~md\n[Fenced example](codex://threads/fenced-example)\n~~~`;
  const links = extractChatLinks(markdown);
  assert.deepEqual(links, [
    { href: codex, provider: "Codex", label: "Implementation" },
    { href: chatgpt, provider: "ChatGPT", label: "Discussion" },
  ]);
  const html = renderChatLinks(links);
  assert.match(html, /href="codex:\/\/threads\//);
  assert.match(html, /ChatGPT · Discussion/);
  assert.match(html, /target="_blank" rel="noreferrer"/);
  assert.doesNotMatch(html, /Snapshot|Example/);
  for (const unsafe of ["codex://threads/new", `${codex}?prompt=send`, "codex://settings/open", "javascript:alert(1)", "https://chatgpt.com.evil.test/c/123", "https://evil@chatgpt.com/c/123"]) assert.equal(chatLink(unsafe), null);
  assert.match(renderChatLinks([{ href: codex, label: '<img src=x onerror="alert(1)">' }]), /&lt;img/);
});

test("Codex conversation Markdown opens the existing chat and blocks other app commands", () => {
  const href = "codex://threads/019abcde-1234-7000-8000-123456789abc";
  assert.deepEqual(resolveMarkdownLink(href, "tasks/TASK-0001.md"), { kind: "app", href });
  const html = inlineMarkdown(`[Resume implementation](${href})`);
  assert.match(html, /href="codex:\/\/threads\//);
  assert.match(html, /opens in Codex/);
  assert.doesNotMatch(html, /target="_blank"/);
  assert.doesNotMatch(inlineMarkdown("[New draft](codex://threads/new?prompt=do-work)"), /href=/);
});

test("task summaries expose chats from authoritative prose for daily plan references", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(join(ROOT, "tasks/TASK-0001.md"), "utf8");
  const href = "codex://threads/019abcde-1234-7000-8000-123456789abc";
  const task = summarize("tasks/TASK-0001.md", `${source}\n\n## Chats\n\n- [Implementation](${href})`).task;
  assert.deepEqual(task?.chatLinks, [{ href, provider: "Codex", label: "Implementation" }]);
});

test("every viewer handoff requests verified conversation identity without guessing", async () => {
  const { buildActionPrompt } = await import("./server.ts");
  const doc = await loadDocument("daily/2026/07/31/plan.md");
  for (const prompt of [buildCodexPrompt(doc, doc.chunks[0], "Continue"), buildDocumentCodexPrompt(doc, "Continue"), buildGlobalCodexPrompt("Continue"), buildActionPrompt(doc, { title: "Continue", prompt: "Read the task" }, "")]) {
    assert.match(prompt, /under ## Chats/);
    assert.match(prompt, /Do not guess IDs/);
    assert.match(prompt, /If the URL or ID is unavailable, continue/);
  }
});

test("Slack permalinks become desktop deep links that land on the message and its thread", async () => {
  const state = join(await mkdtemp(join(tmpdir(), "slack-")), "root-state.json");
  await writeFile(state, JSON.stringify({ workspaces: { T0ACME0001: { id: "T0ACME0001", domain: "acme" } } }));
  assert.equal(await slackDeepLink("https://acme.slack.com/archives/C0ACME0001/p1785755478863709", state), "slack://channel?team=T0ACME0001&id=C0ACME0001&message=1785755478.863709");
  assert.equal(await slackDeepLink("https://acme.slack.com/archives/C0ACME0002/p1785755442754709?thread_ts=1785755252.747989&cid=C0ACME0002", state), "slack://channel?team=T0ACME0001&id=C0ACME0002&message=1785755442.754709&thread_ts=1785755252.747989");
  await assert.rejects(slackDeepLink("https://other.slack.com/archives/C0ACME0001/p1785755478863709", state), /No Slack workspace/);
});

test("an active task with only blocked actions explains what it is waiting on", async () => {
  const task = await loadDocument("tasks/TASK-0002.md");
  assert.ok(task.nextActions.every(action => action.blocked));
  assert.match(task.actionWarnings.join(" "), /no ready next action: “Compare released versions” \(W2 is open, after W1\)/);
  assert.deepEqual((await loadDocument("tasks/TASK-0015.md")).actionWarnings, []);
});
