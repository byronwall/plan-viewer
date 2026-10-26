// Activity page: every planning document, tracked issue and open PR in one list, newest touch first.
// Documents carry their file mtime, issues their latest sync activity (or Jira/Linear `updated`), PRs GitHub's `updatedAt`.
import { SERVICE_ICONS, documentHref, escapeHtml } from "./markdown.js";
import { GLYPHS, glyph } from "./icons.js";
import { config } from "./config.js";
import { loadIssues, openIssue } from "./issues.js";
import { loadPrIndex, openPrOverlay, when } from "./code.js";

const DAY = 86_400_000;
export const SOURCES = { all: "All", tasks: "Tasks", daily: "Daily", topics: "Topics", jira: "Jira", linear: "Linear", prs: "PRs" };
const RANGES = { day: ["24h", DAY], week: ["7 days", 7 * DAY], month: ["30 days", 30 * DAY], all: ["All time", Infinity] };
const SOURCE_ICONS = { tasks: SERVICE_ICONS.task, daily: glyph("calendar", "service-icon is-stroke"), topics: glyph("file-text", "service-icon is-stroke"), jira: SERVICE_ICONS.jira, linear: SERVICE_ICONS.linear, prs: SERVICE_ICONS.github };
const DOC_SOURCE = { Tasks: "tasks", "Task documents": "tasks", Today: "daily", Daily: "daily", Topics: "topics", Reference: "topics" };

const ui = { host: null, documents: [], changes: [], issues: null, prs: null, source: "all", range: "week", query: "", mine: false };

function syncUrl() {
  const url = new URL(location.href);
  url.search = new URLSearchParams({ view: "activity", ...(ui.source === "all" ? {} : { source: ui.source }), ...(ui.range === "week" ? {} : { range: ui.range }), ...(ui.query ? { q: ui.query } : {}), ...(ui.mine ? { mine: "1" } : {}) });
  history.replaceState(null, "", url);
}

const issueText = (row) => row.kind === "comment" ? `${row.by || "Someone"} commented: ${(row.text || "").replace(/\s+/g, " ").slice(0, 140)}`
  : row.kind === "created" ? `created${row.by ? ` by ${row.by}` : ""}`
  : `${row.kind} ${row.from || "none"} → ${row.to || "none"}${row.by ? ` · ${row.by}` : ""}`;

function rows() {
  const out = [];
  for (const doc of ui.documents) {
    if (!doc.modified) continue;
    const change = ui.changes.find((candidate) => candidate.path === doc.path);
    const detail = change ? [change.sections.map((section) => section.title).join(", "), change.kind === "changed" ? `+${change.added} −${change.removed}` : change.kind].filter(Boolean).join(" · ") : doc.path;
    out.push({ source: DOC_SOURCE[doc.group] || "topics", at: doc.modified, label: doc.task?.id || doc.date || "", title: doc.task?.title || doc.title, detail, status: doc.task?.status || doc.kind, href: documentHref(doc.path, change?.sections[0]?.anchor || ""), path: doc.path, anchor: change?.sections[0]?.anchor || "", mine: true });
  }
  if (ui.issues) {
    const latest = new Map();
    for (const row of ui.issues.activity || []) if (!latest.has(row.key) || latest.get(row.key).at < row.at) latest.set(row.key, row);
    for (const issue of ui.issues.issues || []) {
      if (!issue.inScope || issue.mirrorOf || issue.bot) continue;
      const row = latest.get(issue.key);
      const at = Math.max(new Date(issue.updated || 0).getTime() || 0, row ? new Date(row.at).getTime() : 0);
      const me = ui.issues.me;
      out.push({ source: issue.source === "linear" ? "linear" : "jira", at, label: issue.type === "Project" ? "" : issue.label || issue.key, title: issue.summary, detail: row ? issueText(row) : `updated · ${issue.assignee?.name || "unassigned"}`, status: issue.status, issue: issue.key, mine: Boolean(me) && [issue.assignee?.email, issue.reporter?.email].includes(me) });
    }
  }
  for (const pr of ui.prs?.prs || []) {
    if (!pr.updatedAt) continue; // ponytail: only open PRs carry timestamps; merged/closed ones need `updatedAt` in the history cache
    out.push({ source: "prs", at: new Date(pr.updatedAt).getTime(), label: `#${pr.number}`, title: pr.title, detail: `${pr.slug.split("/").pop()} · ${pr.branch} · ${pr.author}`, status: pr.draft ? "Draft" : pr.reviewDecision ? pr.reviewDecision.toLowerCase().replace(/_/g, " ") : "Open", pr: [pr.slug, pr.number], mine: pr.author === ui.prs.me });
  }
  return out.sort((a, b) => b.at - a.at);
}

const dayLabel = (time) => {
  const date = new Date(time);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / DAY);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
};

function rowHtml(row) {
  const attrs = row.path ? `href="${escapeHtml(row.href)}" class="markdown-document-link activity-title" data-document-path="${escapeHtml(row.path)}" data-document-anchor="${escapeHtml(row.anchor)}"`
    : row.issue ? `href="?issue=${encodeURIComponent(row.issue)}" class="activity-title" data-activity-issue="${escapeHtml(row.issue)}"`
    : `href="https://github.com/${escapeHtml(row.pr[0])}/pull/${row.pr[1]}" class="activity-title" data-activity-pr="${escapeHtml(row.pr.join("#"))}"`;
  return `<tr class="code-row activity-row"><td class="code-col-when">${new Date(row.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</td><td class="activity-col-source" title="${SOURCES[row.source]}">${SOURCE_ICONS[row.source]}</td><td class="code-col-main"><a ${attrs}>${row.label ? `<code>${escapeHtml(row.label)}</code> ` : ""}${escapeHtml(row.title)}</a><div class="code-sub activity-detail">${escapeHtml(row.detail)}</div></td><td class="activity-col-status">${escapeHtml(row.status || "")}</td><td class="activity-col-ago">${when(row.at)}</td></tr>`;
}

function render() {
  if (!ui.host?.isConnected) return;
  const all = rows();
  const cutoff = Date.now() - RANGES[ui.range][1];
  const words = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
  const scoped = all.filter((row) => row.at >= cutoff && (!ui.mine || row.mine) && words.every((word) => `${row.label} ${row.title} ${row.detail} ${row.status}`.toLowerCase().includes(word)));
  const counts = Object.fromEntries(Object.keys(SOURCES).map((source) => [source, source === "all" ? scoped.length : scoped.filter((row) => row.source === source).length]));
  const shown = scoped.filter((row) => ui.source === "all" || row.source === ui.source);
  const visible = shown.slice(0, 400);
  const days = new Map();
  for (const row of visible) { const label = dayLabel(row.at); if (!days.has(label)) days.set(label, []); days.get(label).push(row); }
  const sourceTabs = Object.entries(SOURCES).filter(([source]) => (source !== "jira" && source !== "linear") || config().issues.jql).map(([source, label]) => `<button type="button" data-activity-source="${source}" aria-pressed="${ui.source === source}">${label} <span class="code-count">${counts[source]}</span></button>`).join("");
  const ranges = Object.entries(RANGES).map(([range, [label]]) => `<button type="button" data-activity-range="${range}" aria-pressed="${ui.range === range}">${label}</button>`).join("");
  const loading = [!ui.issues && config().issues.jql && "issues", !ui.prs && "PRs"].filter(Boolean);
  const focused = document.activeElement?.matches("[data-activity-filter]");
  ui.host.innerHTML = `<div class="code-toolbar"><div class="code-toolbar-rows"><div class="code-toolbar-row"><div class="code-segment">${sourceTabs}</div><label class="code-filter"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.search}</svg><input type="search" data-activity-filter placeholder="Filter" value="${escapeHtml(ui.query)}" spellcheck="false"></label><span class="code-spacer"></span><span class="code-muted">${loading.length ? `Loading ${loading.join(" and ")}…` : ""}</span></div><div class="code-controls"><div class="code-segment">${ranges}</div><label class="code-check"><input type="checkbox" data-activity-mine ${ui.mine ? "checked" : ""}> Mine</label></div></div></div>`
    + (visible.length ? `<table class="code-table activity-table">${[...days].map(([label, items]) => `<tbody><tr class="code-group-row"><th colspan="5">${escapeHtml(label)} <span>${items.length}</span></th></tr>${items.map(rowHtml).join("")}</tbody>`).join("")}</table>${shown.length > visible.length ? `<p class="code-muted">Showing the newest ${visible.length} of ${shown.length}. Narrow with a filter or range.</p>` : ""}`
      : `<p class="code-muted activity-empty">Nothing in this range. Widen the range or clear the filter.</p>`);
  ui.host.dataset.activityState = loading.length ? "loading" : "ready";
  if (focused) { const input = ui.host.querySelector("[data-activity-filter]"); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

export function renderActivityPage(container, documents) {
  const params = new URLSearchParams(location.search);
  const fresh = ui.host !== container || !container.querySelector(".activity-table, .activity-empty");
  Object.assign(ui, { host: container, documents });
  if (fresh) Object.assign(ui, { source: params.get("source") in SOURCES ? params.get("source") : "all", range: params.get("range") in RANGES ? params.get("range") : "week", query: params.get("q") || "", mine: params.get("mine") === "1" });
  render();
  fetch("/api/changes").then((response) => response.json()).then((body) => { ui.changes = body.changes || []; render(); }).catch(() => {});
  if (config().issues.jql) loadIssues().then((data) => { ui.issues = data; render(); }).catch(() => {});
  loadPrIndex().then((data) => { ui.prs = data; render(); }).catch(() => {});
}

document.addEventListener("click", (event) => {
  if (!ui.host?.isConnected || !ui.host.contains(event.target)) return;
  const { activitySource, activityRange, activityIssue, activityPr } = event.target.closest("[data-activity-source], [data-activity-range], [data-activity-issue], [data-activity-pr]")?.dataset || {};
  if (event.metaKey || event.ctrlKey) return; // let a modified click open the link in a new tab
  if (activitySource) ui.source = activitySource;
  else if (activityRange) ui.range = activityRange;
  else if (activityIssue) { event.preventDefault(); return openIssue(activityIssue); }
  else if (activityPr) { event.preventDefault(); const [slug, number] = activityPr.split("#"); return openPrOverlay(slug, Number(number)); }
  else return;
  syncUrl();
  render();
});
document.addEventListener("input", (event) => {
  if (!ui.host?.contains(event.target)) return;
  if (event.target.matches("[data-activity-filter]")) ui.query = event.target.value;
  else if (event.target.matches("[data-activity-mine]")) ui.mine = event.target.checked;
  else return;
  syncUrl();
  render();
});
