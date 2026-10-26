// Activity page: every planning document, tracked issue and open PR in one list, newest touch first, with an inspector
// beside it so a click reads the item in place. Documents carry their file mtime, issues their latest sync activity
// (or Jira/Linear `updated`), PRs GitHub's `updatedAt`.
import { SERVICE_ICONS, documentHref, escapeHtml, renderMarkdown } from "./markdown.js";
import { GLYPHS, glyph } from "./icons.js";
import { config } from "./config.js";
import { handleIssueClick, issueInspector, issueLink, loadIssueDetail, loadIssues, openIssue } from "./issues.js";
import { avatar, ciBadge, copied, diffSize, fadeIn, hideTip, icon, iconButton, loadPrIndex, openPrOverlay, prBodyHtml, prefetchPr, reviewTag, showTip, sideFacts, sideHead, sideStatus, when } from "./code.js";

const DAY = 86_400_000;
const STRIP_DAYS = 14;
export const SOURCES = { all: "All", tasks: "Tasks", daily: "Daily", topics: "Docs", jira: "Jira", linear: "Linear", prs: "PRs" };
const RANGES = { day: ["24h", DAY], week: ["7d", 7 * DAY], month: ["30d", 30 * DAY], all: ["All", Infinity] };
const SOURCE_ICONS = { tasks: SERVICE_ICONS.task, daily: glyph("calendar", "service-icon is-stroke"), topics: glyph("file-text", "service-icon is-stroke"), jira: SERVICE_ICONS.jira, linear: SERVICE_ICONS.linear, prs: SERVICE_ICONS.github };
const DOC_SOURCE = { Tasks: "tasks", "Task documents": "tasks", Today: "daily", Daily: "daily", Topics: "topics", Reference: "topics" };
// State tones: what the colored state cell means at a glance.
const TASK_TONES = { active: "progress", open: "quiet", waiting: "wait", blocked: "fail", completed: "pass", done: "pass", cancelled: "quiet", deferred: "quiet" };
const ISSUE_TONES = { new: "quiet", indeterminate: "progress", done: "pass" };
const PR_STATES = { APPROVED: ["Approved", "pass"], CHANGES_REQUESTED: ["Changes requested", "fail"], REVIEW_REQUIRED: ["Needs review", "wait"] };

const ui = { host: null, documents: [], changes: [], issues: null, prs: null, source: "all", range: "week", day: "", query: "", mine: false, sel: "", visible: [], docCache: new Map(), prCache: new Map(), openDocument: () => {}, timer: 0 };

const localDay = (time) => { const date = new Date(time); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
const dayStart = (key) => new Date(`${key}T00:00:00`).getTime();
const dayLabel = (time) => {
  const diff = Math.round((dayStart(localDay(Date.now())) - dayStart(localDay(time))) / DAY);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : new Date(time).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
};
const clock = (time) => new Date(time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s?([AP])M/, (_, half) => half.toLowerCase());
const stateHtml = (label, tone, tip = "") => label ? `<span class="activity-state is-${tone}"${tip ? ` data-tip="${escapeHtml(tip)}"` : ""}>${escapeHtml(label)}</span>` : "";

function syncUrl() {
  const url = new URL(location.href);
  url.search = new URLSearchParams({ view: "activity", ...(ui.source === "all" ? {} : { source: ui.source }), ...(ui.day ? { day: ui.day } : ui.range === "week" ? {} : { range: ui.range }), ...(ui.query ? { q: ui.query } : {}), ...(ui.mine ? { mine: "1" } : {}), ...(ui.sel ? { sel: ui.sel } : {}) });
  history.replaceState(null, "", url);
}

// The event line under an issue's title: the latest synced change, with the new value emphasized.
const issueEvent = (row) => row.kind === "comment" ? `<b>${escapeHtml(row.by || "Someone")}</b> commented: <span class="activity-quote">${escapeHtml((row.text || "").replace(/\s+/g, " ").slice(0, 180))}</span>`
  : row.kind === "created" ? `created${row.by ? ` by <b>${escapeHtml(row.by)}</b>` : ""}`
  : `${escapeHtml(row.kind)} <s>${escapeHtml(row.from || "none")}</s> → <b>${escapeHtml(row.to || "none")}</b>${row.by ? ` · ${escapeHtml(row.by)}` : ""}`;
const docEvent = (change) => `${change.kind === "created" ? "created" : "edited"}${change.sections.length ? ` <b>${escapeHtml(change.sections.map((section) => section.title).join(", "))}</b>` : ""}${change.kind === "changed" ? ` <span class="activity-delta"><ins>+${change.added}</ins> <del>−${change.removed}</del></span>` : ""}`;

function rows() {
  const out = [];
  for (const doc of ui.documents) {
    if (!doc.modified) continue;
    const change = ui.changes.find((candidate) => candidate.path === doc.path && candidate.kind !== "deleted");
    const task = doc.task;
    const where = task ? [task.project, doc.group === "Task documents" ? doc.kind : ""].filter(Boolean).join(" · ") : doc.path.replace(/\/[^/]+$/, "/");
    out.push({
      id: `doc:${doc.path}`, kind: "doc", source: DOC_SOURCE[doc.group] || "topics", at: doc.modified, doc, change,
      label: task?.id || "", title: task?.title || doc.title,
      event: change && Math.abs(change.at - doc.modified) < 5 * 60_000 ? docEvent(change) : task ? "saved" : `saved <span class="activity-path">${escapeHtml(doc.path)}</span>`,
      context: escapeHtml(where), state: task ? stateHtml(task.status, TASK_TONES[task.status] || "quiet") : "",
      who: change?.source === "agent" ? `<span class="activity-agent" data-tip="Edited by an agent">${icon("session")}</span>` : "",
      mine: true, text: `${task?.id || ""} ${task?.title || doc.title} ${doc.path} ${task?.project || ""} ${task?.status || ""}`,
    });
  }
  if (ui.issues) {
    const latest = new Map();
    for (const row of ui.issues.activity || []) if (!latest.has(row.key) || latest.get(row.key).at < row.at) latest.set(row.key, row);
    const byKey = new Map((ui.issues.issues || []).map((issue) => [issue.key, issue]));
    const me = ui.issues.me;
    for (const issue of ui.issues.issues || []) {
      if (!issue.inScope || issue.mirrorOf || issue.bot) continue;
      const row = latest.get(issue.key);
      const at = Math.max(new Date(issue.updated || 0).getTime() || 0, row ? new Date(row.at).getTime() : 0);
      const parent = byKey.get(issue.parent);
      out.push({
        id: `issue:${issue.key}`, kind: "issue", source: issue.source === "linear" ? "linear" : "jira", at, issue,
        label: issue.type === "Project" ? "" : issue.label || issue.key, title: issue.summary,
        event: row && Math.abs(new Date(row.at).getTime() - at) < 60 * 60_000 ? issueEvent(row) : "updated",
        context: parent ? `<span class="activity-parent" data-tip="${escapeHtml(parent.summary)}">↳ ${escapeHtml(parent.label || parent.key)} ${escapeHtml(parent.summary.slice(0, 40))}${parent.summary.length > 40 ? "…" : ""}</span>` : escapeHtml(issue.type),
        state: stateHtml(issue.status, ISSUE_TONES[issue.category] || "quiet"),
        who: issue.assignee ? `<span data-tip="${escapeHtml(issue.assignee.name)}">${avatar("", issue.assignee.name, issue.assignee.email)}</span>` : "",
        mine: Boolean(me) && [issue.assignee?.email, issue.reporter?.email].includes(me),
        text: `${issue.label || issue.key} ${issue.summary} ${issue.status} ${issue.assignee?.name || ""} ${parent?.summary || ""}`,
      });
    }
  }
  for (const pr of ui.prs?.prs || []) {
    if (!pr.updatedAt) continue; // ponytail: only open PRs carry timestamps; merged/closed ones need `updatedAt` in the history cache
    const [label, tone] = pr.draft ? ["Draft", "quiet"] : PR_STATES[pr.reviewDecision] || ["Open", "quiet"];
    out.push({
      id: `pr:${pr.slug}#${pr.number}`, kind: "pr", source: "prs", at: new Date(pr.updatedAt).getTime(), pr,
      label: `#${pr.number}`, title: pr.title,
      event: `${new Date(pr.updatedAt) - new Date(pr.createdAt) < 60_000 ? "opened" : "updated"} <span class="activity-delta"><ins>+${pr.additions ?? 0}</ins> <del>−${pr.deletions ?? 0}</del></span>${pr.comments ? ` · ${pr.comments} comment${pr.comments === 1 ? "" : "s"}` : ""}`,
      context: `${escapeHtml(pr.slug.split("/").pop())} <span class="activity-branch">${escapeHtml(pr.branch)}</span>`,
      ci: ciBadge(pr), state: stateHtml(label, tone),
      who: `<span data-tip="${escapeHtml(pr.author)}">${avatar(pr.author)}</span>`,
      mine: pr.author === ui.prs.me, text: `#${pr.number} ${pr.title} ${pr.branch} ${pr.author} ${pr.slug} ${label}`,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

// Day strip: one stacked bar per day for the last two weeks, by source, over the rows the other filters keep.
function dayStrip(scoped) {
  const today = dayStart(localDay(Date.now()));
  const days = Array.from({ length: STRIP_DAYS }, (_, index) => localDay(today - (STRIP_DAYS - 1 - index) * DAY + DAY / 2));
  const counts = new Map(days.map((day) => [day, {}]));
  for (const row of scoped) { const bucket = counts.get(localDay(row.at)); if (bucket) bucket[row.source] = (bucket[row.source] || 0) + 1; }
  const totals = days.map((day) => Object.values(counts.get(day)).reduce((sum, count) => sum + count, 0));
  const max = Math.max(1, ...totals);
  return `<div class="activity-strip" role="group" aria-label="Filter by day">${days.map((day, index) => {
    const date = new Date(`${day}T12:00:00`);
    const parts = Object.keys(SOURCES).filter((source) => counts.get(day)[source]);
    const tip = `${date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })} · ${totals[index]} item${totals[index] === 1 ? "" : "s"}${parts.length ? `: ${parts.map((source) => `${counts.get(day)[source]} ${SOURCES[source]}`).join(", ")}` : ""}`;
    return `<button type="button" class="activity-day${date.getDay() === 1 ? " is-monday" : ""}${index === STRIP_DAYS - 1 ? " is-today" : ""}" data-activity-day="${day}" aria-pressed="${ui.day === day}" data-tip="${escapeHtml(tip)}"><span class="activity-bar">${parts.map((source) => `<i class="src-${source}" style="height:${(counts.get(day)[source] / max) * 100}%"></i>`).join("")}</span><small>${date.getDate()}</small></button>`;
  }).join("")}</div>`;
}

function rowHtml(row) {
  const href = row.doc ? documentHref(row.doc.path, row.change?.sections[0]?.anchor || "") : row.issue ? `?issue=${encodeURIComponent(row.issue.key)}` : row.pr.url;
  return `<tr class="code-row activity-row" data-activity-id="${escapeHtml(row.id)}" aria-selected="${ui.sel === row.id}"><td class="activity-col-when" data-tip="${escapeHtml(new Date(row.at).toLocaleString())}"><b>${clock(row.at)}</b>${when(row.at)}</td><td class="activity-col-source src-${row.source}" data-tip="${SOURCES[row.source]}">${SOURCE_ICONS[row.source]}</td><td class="code-col-main"><a class="activity-title" href="${escapeHtml(href)}" data-activity-open>${row.label ? `<code>${escapeHtml(row.label)}</code>` : ""}${escapeHtml(row.title)}</a><div class="activity-sub"><span class="activity-event">${row.event}</span><span class="activity-context">${row.context}</span></div></td><td class="activity-col-ci">${row.ci || ""}</td><td class="activity-col-state">${row.state}</td><td class="activity-col-who">${row.who}</td></tr>`;
}

function filtered() {
  const all = rows();
  const words = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = all.filter((row) => (!ui.mine || row.mine) && words.every((word) => row.text.toLowerCase().includes(word)));
  const inTime = ui.day ? kept.filter((row) => localDay(row.at) === ui.day) : kept.filter((row) => row.at >= Date.now() - RANGES[ui.range][1]);
  return { kept, inTime, shown: inTime.filter((row) => ui.source === "all" || row.source === ui.source) };
}

function render() {
  if (!ui.host?.isConnected) return;
  const { kept, inTime, shown } = filtered();
  const counts = Object.fromEntries(Object.keys(SOURCES).map((source) => [source, source === "all" ? inTime.length : inTime.filter((row) => row.source === source).length]));
  ui.visible = shown.slice(0, 500);
  const days = new Map();
  for (const row of ui.visible) { const label = dayLabel(row.at); if (!days.has(label)) days.set(label, []); days.get(label).push(row); }
  const issuesOn = Boolean(config().issues.jql);
  const sourceTabs = Object.entries(SOURCES).filter(([source]) => (source !== "jira" && source !== "linear") || issuesOn).map(([source, label]) => `<button type="button" data-activity-source="${source}" aria-pressed="${ui.source === source}">${source === "all" ? "" : `<i class="activity-dot src-${source}"></i>`}${label} <span class="code-count">${counts[source]}</span></button>`).join("");
  const ranges = Object.entries(RANGES).map(([range, [label]]) => `<button type="button" data-activity-range="${range}" aria-pressed="${!ui.day && ui.range === range}">${label}</button>`).join("");
  const loading = [!ui.issues && issuesOn && "issues", !ui.prs && "PRs"].filter(Boolean);
  const focused = document.activeElement?.matches("[data-activity-filter]");
  const toolbar = `<div class="activity-toolbar" data-region="toolbar"><div class="code-segment">${sourceTabs}</div><label class="code-filter"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.search}</svg><input type="search" data-activity-filter placeholder="Filter  (F)" value="${escapeHtml(ui.query)}" spellcheck="false" autocomplete="off"></label><label class="code-check"><input type="checkbox" data-activity-mine ${ui.mine ? "checked" : ""}> Mine</label><span class="activity-when-controls"><div class="code-segment">${ranges}</div>${dayStrip(kept.filter((row) => ui.source === "all" || row.source === ui.source))}</span><span class="code-spacer"></span><span class="code-muted activity-status">${loading.length ? `Loading ${loading.join(" and ")}…` : ui.day ? `${new Date(`${ui.day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · <button type="button" class="activity-clear-day" data-activity-day="${ui.day}">clear day</button>` : ""}</span></div>`;
  const table = ui.visible.length
    ? `<table class="code-table activity-table"><thead><tr><th>When</th><th></th><th>Item <span class="code-muted">· what changed · where</span></th><th data-tip="Checks on the PR's latest commit">CI</th><th>State</th><th>Who</th></tr></thead>${[...days].map(([label, items]) => `<tbody><tr class="code-group-row"><th colspan="6">${escapeHtml(label)} <span>${items.length}</span></th></tr>${items.map(rowHtml).join("")}</tbody>`).join("")}</table>${shown.length > ui.visible.length ? `<p class="code-muted activity-more">Showing the newest ${ui.visible.length} of ${shown.length}. Narrow with a filter, day or range.</p>` : ""}`
    : `<p class="code-muted activity-empty">${loading.length ? "Loading…" : "Nothing here. Widen the range, pick another day, or clear the filter."}</p>`;
  const scroll = ui.host.querySelector(".activity-inspector")?.scrollTop || 0;
  const hadInspector = ui.host.querySelector(".activity-inspector");
  if (!hadInspector) ui.host.innerHTML = `<section class="activity-surface"><div data-region="toolbar"></div><div class="activity-split"><div class="activity-list" data-region="list"></div><aside class="activity-inspector code-detail" aria-live="polite"></aside></div></section>`;
  ui.host.querySelector('[data-region="toolbar"]').outerHTML = toolbar;
  ui.host.querySelector('[data-region="list"]').innerHTML = table;
  ui.host.style.setProperty("--code-bar-h", `${ui.host.querySelector(".activity-toolbar").offsetHeight}px`);
  ui.host.dataset.activityState = loading.length ? "loading" : "ready";
  if (focused) { const input = ui.host.querySelector("[data-activity-filter]"); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  if (!hadInspector || ui.inspected !== ui.sel) renderInspector();
  else ui.host.querySelector(".activity-inspector").scrollTop = scroll;
}

// ---------- inspector ----------

const selectedRow = () => ui.visible.find((row) => row.id === ui.sel) || rows().find((row) => row.id === ui.sel);
const tools = (open, external, copy) => `<span class="code-side-tools">${iconButton("expand", `${open} (Enter)`, "data-activity-expand")}${external ? `<a class="code-icon-button" href="${escapeHtml(external)}" target="_blank" rel="noreferrer" data-tip="Open in a new tab (O)" aria-label="Open in a new tab">${icon("external")}</a>` : ""}${iconButton("copy", "Copy link (Y)", `data-activity-copy="${escapeHtml(copy)}"`)}</span>`;

function renderInspector() {
  const pane = ui.host?.querySelector(".activity-inspector");
  if (!pane) return;
  const row = selectedRow();
  ui.inspected = row ? ui.sel : null; // a selection from the URL waits for its rows to load
  if (!row) {
    pane.innerHTML = `<p class="code-detail-empty">Select a row to read it here.<br><br><kbd>J</kbd><kbd>K</kbd> move · <kbd>Enter</kbd> open in full · <kbd>O</kbd> new tab · <kbd>Y</kbd> copy link · <kbd>←</kbd><kbd>→</kbd> day · <kbd>F</kbd> filter · <kbd>Esc</kbd> clear</p>`;
    return;
  }
  pane.innerHTML = row.kind === "doc" ? docPanel(row) : row.kind === "pr" ? prPanel(row) : issueInspector(row.issue.key) || `<p class="code-muted">Loading issue…</p>`;
  pane.scrollTop = 0;
  fadeIn(pane, 140);
  const again = () => { if (ui.sel === row.id && ui.host?.isConnected) { const top = pane.scrollTop; pane.innerHTML = row.kind === "doc" ? docPanel(row) : row.kind === "pr" ? prPanel(row) : issueInspector(row.issue.key); pane.scrollTop = top; } };
  if (row.kind === "issue") loadIssues().then(() => { again(); return loadIssueDetail(row.issue.key); }).then(again).catch(() => {});
  if (row.kind === "doc" && !ui.docCache.has(`${row.doc.path}@${row.doc.modified}`)) fetch(`/api/document?path=${encodeURIComponent(row.doc.path)}`).then((response) => response.json()).then((body) => { ui.docCache.set(`${row.doc.path}@${row.doc.modified}`, body); again(); }).catch(() => {});
  if (row.kind === "pr" && !ui.prCache.has(`${row.id}@${row.pr.updatedAt}`)) fetch(`/api/code/pr?${new URLSearchParams({ slug: row.pr.slug, number: row.pr.number })}`).then((response) => response.json()).then((body) => { ui.prCache.set(`${row.id}@${row.pr.updatedAt}`, body); again(); }).catch(() => {});
}

function docPanel(row) {
  const { doc, change } = row;
  const body = ui.docCache.get(`${doc.path}@${doc.modified}`);
  const task = doc.task;
  const facts = sideFacts([
    ["Status", task ? stateHtml(task.status, TASK_TONES[task.status] || "quiet") : ""],
    ["Project", task?.project ? escapeHtml(task.project) : ""],
    ["Tags", (task?.tags || []).map((tag) => `<span class="code-tag">${escapeHtml(tag)}</span>`).join("")],
    ["Saved", `${when(doc.modified)} ago<span class="code-muted">${escapeHtml(new Date(doc.modified).toLocaleString())}</span>`],
    ["Path", `<code>${escapeHtml(doc.path)}</code>`],
  ]);
  const changed = change ? `<section>${sideHead(change.source === "agent" ? "Agent edit" : "Last edit", `${when(change.at)} ago · +${change.added} −${change.removed}`)}${change.sections.length ? `<p class="activity-sections">${change.sections.map((section) => `<a class="markdown-document-link" href="${escapeHtml(documentHref(doc.path, section.anchor))}" data-document-path="${escapeHtml(doc.path)}" data-document-anchor="${escapeHtml(section.anchor)}">${escapeHtml(section.title)}</a>`).join(" · ")}</p>` : ""}${change.lines.length ? `<ul class="activity-lines">${change.lines.slice(0, 12).map((line) => `<li>${escapeHtml(line)}</li>`).join("")}${change.lines.length > 12 ? `<li class="code-muted">+${change.lines.length - 12} more lines</li>` : ""}</ul>` : ""}</section>` : "";
  const markdown = body?.markdown?.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^\s*# .*\n/, "") || ""; // the title is in the header
  const preview = body ? `<section>${sideHead(task ? "Task" : doc.kind)}<div class="markdown activity-preview">${renderMarkdown(markdown, doc.path)}</div></section>` : `<section><p class="code-muted">Loading…</p></section>`;
  return `<div class="code-detail-head"><span class="activity-head-icon src-${row.source}">${SOURCE_ICONS[row.source]}</span><h3>${row.label ? `<code>${escapeHtml(row.label)}</code> ` : ""}${escapeHtml(row.title)}</h3>${tools("Open document", "", new URL(documentHref(doc.path, ""), location.href).href)}</div>${facts}${changed}${preview}`;
}

function prPanel(row) {
  const { pr } = row;
  const detail = ui.prCache.get(`${row.id}@${pr.updatedAt}`);
  const reviews = (pr.reviews || []).filter((review) => !/copilot|\[bot\]$/i.test(review.login));
  const facts = sideFacts([
    ["State", `${reviewTag(pr)}${pr.draft ? '<span class="code-tag code-tag-draft">draft</span>' : ""}${pr.mergeable === "CONFLICTING" ? '<span class="code-tag code-tag-dirty">conflicts</span>' : ""}${pr.ci ? sideStatus(pr.ci === "SUCCESS" ? "pass" : pr.ci === "FAILURE" || pr.ci === "ERROR" ? "fail" : "pending", pr.ci === "SUCCESS" ? "pass" : pr.ci === "FAILURE" || pr.ci === "ERROR" ? "fail" : "pending", pr.ci === "SUCCESS" ? "checks pass" : pr.ci === "FAILURE" || pr.ci === "ERROR" ? "checks fail" : "checks running") : ""}`],
    ["Author", `${avatar(pr.author)}<span>${escapeHtml(pr.author)}</span>`],
    ["Reviews", reviews.map((review) => `${avatar(review.login)}<span>${escapeHtml(review.login)} <span class="code-muted">${escapeHtml(review.state.toLowerCase().replace(/_/g, " "))}</span></span>`).join("")],
    ["Branch", `<code>${escapeHtml(pr.branch)}</code><span class="code-muted">→ ${escapeHtml(pr.base || "main")}</span>`],
    ["Size", diffSize({ additions: pr.additions, deletions: pr.deletions, files: detail?.files?.length || 0 })],
    ["Dates", `<span class="code-muted">opened ${when(pr.createdAt)} ago</span><span class="code-muted">updated ${when(pr.updatedAt)} ago</span>`],
  ]);
  const description = detail?.body ? `<section>${sideHead("Description")}<div class="markdown code-description activity-preview">${prBodyHtml(pr.slug, pr.number, detail.body)}</div></section>` : "";
  const files = detail?.files?.length ? `<section>${sideHead("Files", String(detail.files.length))}<ul class="activity-files">${detail.files.map((file) => `<li><code>${escapeHtml(file.path)}</code><span class="activity-delta"><ins>+${file.additions}</ins> <del>−${file.deletions}</del></span></li>`).join("")}</ul></section>` : "";
  const commits = detail?.commits?.length ? `<section>${sideHead("Commits", String(detail.commits.length))}<ul class="activity-files">${detail.commits.slice(-10).reverse().map((commit) => `<li><span>${escapeHtml(commit.subject)}</span><code>${escapeHtml(commit.sha.slice(0, 7))}</code></li>`).join("")}</ul></section>` : "";
  return `<div class="code-detail-head">${ciBadge(pr)}<h3><code>${escapeHtml(pr.slug.split("/").pop())}#${pr.number}</code> ${escapeHtml(pr.title)}</h3>${tools("PR overview", pr.url, pr.url)}</div>${facts}${detail ? description + files + commits : `<section><p class="code-muted">Loading…</p></section>`}`;
}

// ---------- actions ----------

function select(id, scroll = false) {
  if (!id || id === ui.sel) return;
  ui.sel = id;
  for (const tr of ui.host.querySelectorAll("[data-activity-id]")) tr.setAttribute("aria-selected", String(tr.dataset.activityId === id));
  if (scroll) ui.host.querySelector(`[data-activity-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  const row = selectedRow();
  if (row?.pr) prefetchPr(row.pr.slug, row.pr.number);
  syncUrl();
  renderInspector();
}

function move(step) {
  const ids = ui.visible.map((row) => row.id);
  const index = ids.indexOf(ui.sel);
  select(ids[Math.max(0, Math.min(ids.length - 1, index < 0 ? 0 : index + step))], true);
}

function openFull(row = selectedRow()) {
  if (!row) return;
  if (row.doc) return ui.openDocument(row.doc.path, row.change?.sections[0]?.anchor || "");
  if (row.issue) return openIssue(row.issue.key, ui.visible.filter((candidate) => candidate.issue).map((candidate) => candidate.issue.key));
  return openPrOverlay(row.pr.slug, row.pr.number);
}

function stepDay(step) {
  const today = localDay(Date.now());
  const current = ui.day || today;
  const next = localDay(dayStart(current) + step * DAY + DAY / 2);
  ui.day = next > today ? "" : next;
  syncUrl();
  render();
}

export function renderActivityPage(container, documents, { openDocument } = {}) {
  const params = new URLSearchParams(location.search);
  const fresh = ui.host !== container || !container.querySelector(".activity-surface");
  Object.assign(ui, { host: container, documents, ...(openDocument ? { openDocument } : {}) });
  if (fresh) Object.assign(ui, { source: params.get("source") in SOURCES ? params.get("source") : "all", range: params.get("range") in RANGES ? params.get("range") : "week", day: /^\d{4}-\d{2}-\d{2}$/.test(params.get("day") || "") ? params.get("day") : "", query: params.get("q") || "", mine: params.get("mine") === "1", sel: params.get("sel") || "", inspected: null });
  if (fresh) container.innerHTML = "";
  render();
  refresh();
  window.clearInterval(ui.timer);
  // Watching the page: issues and PRs re-read from the server's caches every minute, and relative times tick.
  ui.timer = window.setInterval(() => { if (ui.host?.isConnected && ui.host.querySelector(".activity-surface")) refresh(); else window.clearInterval(ui.timer); }, 60_000);
}

function refresh() {
  fetch("/api/changes").then((response) => response.json()).then((body) => { ui.changes = body.changes || []; render(); }).catch(() => {});
  if (config().issues.jql) fetch("/api/issues").then((response) => response.json()).then((data) => { ui.issues = data; render(); }).catch(() => {});
  loadPrIndex().then((data) => { ui.prs = data; render(); }).catch(() => {});
}

const live = () => ui.host?.isConnected && ui.host.querySelector(".activity-surface");

document.addEventListener("click", (event) => {
  if (!live() || !ui.host.contains(event.target)) return;
  const inspector = event.target.closest(".activity-inspector");
  if (inspector) {
    if (event.target.closest("[data-activity-expand]")) return openFull();
    const copy = event.target.closest("[data-activity-copy]");
    if (copy) return navigator.clipboard.writeText(copy.dataset.activityCopy).then(() => copied(copy));
    if (event.target.closest("[data-issue-open], [data-issue-copy], [data-issue-skill], [data-issue-pr], [data-issue-wt], a[data-planning-path]")) return handleIssueClick(event);
    return;
  }
  const control = event.target.closest("[data-activity-source], [data-activity-range], [data-activity-day]");
  if (control) {
    const { activitySource, activityRange, activityDay } = control.dataset;
    if (activitySource) ui.source = activitySource;
    if (activityRange) { ui.range = activityRange; ui.day = ""; }
    if (activityDay) ui.day = ui.day === activityDay ? "" : activityDay;
    syncUrl();
    return render();
  }
  const tr = event.target.closest("[data-activity-id]");
  if (!tr) return;
  if (event.target.closest("[data-activity-open]")) {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return; // a modified click opens the link in a new tab
    event.preventDefault();
  }
  select(tr.dataset.activityId);
  if (!ui.host.querySelector(".activity-inspector").offsetWidth) openFull(); // too narrow for the inspector: open it in full
});
document.addEventListener("dblclick", (event) => {
  const tr = live() && event.target.closest("[data-activity-id]");
  if (tr) openFull(ui.visible.find((row) => row.id === tr.dataset.activityId));
});
document.addEventListener("input", (event) => {
  if (!live() || !ui.host.contains(event.target)) return;
  if (event.target.matches("[data-activity-filter]")) ui.query = event.target.value;
  else if (event.target.matches("[data-activity-mine]")) ui.mine = event.target.checked;
  else return;
  syncUrl();
  render();
});
document.addEventListener("pointerover", (event) => {
  if (!live() || !ui.host.contains(event.target)) return;
  const target = event.target.closest("[data-tip]");
  if (target) showTip(target); else hideTip();
});
window.addEventListener("keydown", (event) => {
  if (!live() || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
  if (document.querySelector("dialog[open]") || document.querySelector(":popover-open:not(.code-tip)")) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable]")) {
    if (!event.target.matches?.("[data-activity-filter]")) return;
    if (event.key === "Escape") { ui.query = ""; event.target.value = ""; event.target.blur(); syncUrl(); render(); event.preventDefault(); }
    if (event.key === "ArrowDown" || event.key === "Enter") { event.target.blur(); move(event.key === "Enter" ? 0 : 1); event.preventDefault(); }
    return;
  }
  const row = selectedRow();
  const actions = {
    j: () => move(1), arrowdown: () => move(1), k: () => move(-1), arrowup: () => move(-1),
    arrowleft: () => stepDay(-1), arrowright: () => stepDay(1),
    enter: () => openFull(),
    f: () => ui.host.querySelector("[data-activity-filter]")?.focus(),
    o: () => row && window.open(row.pr?.url || (row.issue && issueLink(row.issue.key)) || (row.doc ? documentHref(row.doc.path, "") : ""), "_blank", "noreferrer"),
    y: () => row && navigator.clipboard.writeText(row.pr?.url || (row.issue && issueLink(row.issue.key)) || new URL(documentHref(row.doc.path, ""), location.href).href),
    escape: () => { if (!ui.day && !ui.query && !ui.mine && ui.source === "all") return; Object.assign(ui, { day: "", query: "", mine: false, source: "all" }); syncUrl(); render(); },
  };
  const action = actions[event.key.toLowerCase()];
  if (!action) return;
  event.preventDefault();
  event.stopPropagation(); // J/K jump document sections elsewhere; here they walk the list
  action();
});
