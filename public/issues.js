import { SERVICE_ICONS, documentHref, escapeHtml, renderMarkdown } from "./markdown.js";
import { GLYPHS } from "./icons.js";
import { agentApp, agentName as appName, config } from "./config.js";
import { ago, avatar, ciBadge, copied, fadeIn, heat, hideTip, icon, iconButton, isSummonKey, openPrOverlay, openWorktreeOverlay, showTip, sideFacts, sideHead, sideStatus, when } from "./code.js";

// Issues page: Jira, Linear and GitHub issues in the configured scope (viewer.config.json `issues`), laid out like the Code page:
// a dense list newest first, an inspector for the selected row, and a full overview on Enter. Read-only; changes go
// through agent drafts.
export const TABS = { all: "All", triage: "Triage", epics: "Epics", activity: "Activity", migration: "Migration" };
export const issueTab = (value) => (value in TABS ? value : "all");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const storage = { get: (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }, set: (key, value) => { try { localStorage.setItem(key, value); } catch {} } };
const ui = {
  tab: "all", data: null, filter: "", scope: "all", people: new Set(), showBots: false, showDone: false, hideSeen: storage.get("issues-hide-seen", "on") === "on",
  sel: "", detail: new Map(), selected: new Set(), expanded: new Set(), since: "", activityScope: "all", poll: 0, peopleQuery: "",
  source: storage.get("issues-source", "all"), migration: "linear",
  group: storage.get("issues-group", "repo"), collapsed: new Set(storage.get("issues-collapsed", "").split("\n").filter(Boolean)),
};
let seen = {};
try { seen = JSON.parse(storage.get("issues-seen", "{}")); } catch {}
let host = null;
let notify = () => {};
// The app shell hands over its document library and how to open a document, for the "In planning" section.
let planning = { documents: () => [], open: () => {} };
export const connectPlanning = (next) => { planning = next; };

// ---------- marks ----------

const TYPE_ICONS = {
  Initiative: [GLYPHS.layers, "initiative"],
  Epic: [GLYPHS.zap, "epic"],
  Story: [GLYPHS.bookmark, "story"],
  Bug: [GLYPHS.bug, "bug"],
  "Sub-task": [GLYPHS["square-stack"], "task"],
  Task: [GLYPHS["square-check"], "task"],
  // Linear: issues are one type, drawn as Linear draws them; projects read as epics
  Issue: [GLYPHS.circle, "linear"],
  "Sub-issue": [GLYPHS["circle-dot"], "linear"],
  Project: [GLYPHS["layout-panel-left"], "project"],
};
// GitHub issues draw as GitHub does: an open circle, a checked one once closed.
const GITHUB_ICONS = { new: [GLYPHS["circle-dot"], "github"], done: [GLYPHS["circle-check"], "github-done"] };
const typeIcon = (issue) => {
  const [path, tone] = issue.source === "github" ? GITHUB_ICONS[issue.category] || GITHUB_ICONS.new : TYPE_ICONS[issue.type] || TYPE_ICONS.Task;
  return `<span class="issue-type issue-type-${tone}" data-tip="${escapeHtml(issue.type || "Issue")}" role="img" aria-label="${escapeHtml(issue.type)}"><svg class="code-icon" viewBox="0 0 24 24" aria-hidden="true">${path}</svg></span>`;
};
const PRIORITY_LEGEND = "Priority: ⇈ urgent · ↑ high · = medium · ↓ low · blank when unset";
const PRIORITY = { Highest: ["urgent", "M6 15l6-6 6 6M6 10l6-6 6 6"], Urgent: ["urgent", "M6 15l6-6 6 6M6 10l6-6 6 6"], High: ["high", "M6 15l6-6 6 6"], Medium: ["medium", "M6 10h12M6 14h12"], Low: ["low", "M6 9l6 6 6-6"], Lowest: ["low", "M6 9l6 6 6-6M6 4l6 6 6-6"] };
const priorityIcon = (issue) => {
  const [tone, path] = PRIORITY[issue.priority] || [];
  return tone ? `<span class="issue-priority issue-priority-${tone}" data-tip="${escapeHtml(issue.priority)} priority" role="img" aria-label="${escapeHtml(issue.priority)} priority"><svg class="code-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg></span>` : '<span class="issue-priority" aria-hidden="true"></span>';
};
const isTriage = (issue) => issue.category === "new" && (issue.triage || ui.data.triage.statuses.includes(issue.status) || issue.labels.some((label) => ui.data.triage.labels.some((prefix) => label.startsWith(prefix))));
const statusTag = (issue) => `<span class="code-tag issue-status issue-status-${isTriage(issue) && ui.data.triage.statuses.includes(issue.status) ? "triage" : issue.category}">${escapeHtml(issue.status)}</span>`;
const firstName = (person) => (person?.name || "").split(" ")[0];
const personMark = (person, full = false) => person ? `<span class="code-side-person" data-tip="${escapeHtml(person.name)}">${avatar(person.login || "", person.name, person.email)}${escapeHtml(full ? person.name : firstName(person))}</span>` : '<span class="code-muted">Unassigned</span>';
const isMine = (issue) => issue.source === "github" ? Boolean(ui.data.githubMe) && [issue.assignee?.login, issue.reporter?.login].includes(ui.data.githubMe) : Boolean(ui.data.me) && [issue.assignee?.email, issue.reporter?.email].includes(ui.data.me);
// Linear keys are namespaced (`linear:MOD-12`) since a Jira project can share the prefix; the label is what shows.
const label = (issue) => issue.label || issue.key;
const keyLabel = (key) => { const issue = byKey().get(key); return issue ? label(issue) : key.replace(/^(linear|github):/, ""); };
const issueUrl = (key) => byKey().get(key)?.url || `https://${ui.data.site}/browse/${key}`;
const TRACKERS = { jira: "Jira", linear: "Linear", github: "GitHub" };
const trackerName = (issue) => TRACKERS[issue?.source] || "Jira";
const keyMark = (issue) => issue.type === "Project" ? "" : `<code>${escapeHtml(label(issue))}</code>`;
// Linear projects have no identifier; in list rows the slot says what the row is instead of sitting empty.
const keyCell = (issue) => keyMark(issue) || `<span class="issue-key-none">${escapeHtml(issue.type)}</span>`;
const byKey = () => (ui.byKey ||= new Map(ui.data.issues.map((issue) => [issue.key, issue])));
const codeOf = (issue) => ui.data.code[issue.key] || { prs: [], worktrees: [] };
const aliasesFor = (key) => Object.entries(ui.data.aliases).filter(([, target]) => target === key).map(([alias]) => alias);
const isSeen = (issue) => seen[issue.key] === issue.updated;
function toggleSeen(issue) {
  if (isSeen(issue)) delete seen[issue.key]; else seen[issue.key] = issue.updated;
  storage.set("issues-seen", JSON.stringify(seen));
  return isSeen(issue);
}

function prMark(pr) {
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.draft ? "draft" : "open";
  const label = pr.number ? `#${pr.number}` : "PR";
  return pr.slug && pr.number
    ? `<button type="button" class="code-pr-chip code-pr-${state === "open" ? "open" : "draft"} issue-pr-${state}" data-issue-pr="${escapeHtml(`${pr.slug}#${pr.number}`)}" data-tip="${escapeHtml(`${pr.slug}#${pr.number} · ${pr.title || "pull request"} · ${state}`)}">${ciBadge(pr)}${label}</button>`
    : `<a class="code-pr-chip code-pr-draft" href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">${label}</a>`;
}
function codeChips(issue) {
  const { prs, worktrees } = codeOf(issue);
  const open = prs.filter((pr) => pr.state === "OPEN");
  const shown = (open.length ? open : prs).slice(0, 2);
  const more = prs.length - shown.length;
  return `${shown.map(prMark).join("")}${more > 0 ? `<span class="code-muted" data-tip="${escapeHtml(prs.slice(2).map((pr) => `#${pr.number}`).join(", "))}">+${more}</span>` : ""}${worktrees.length ? `<span class="issue-local" data-tip="${escapeHtml(`Local worktree: ${worktrees.map((tree) => tree.branch).join(", ")}`)}">${icon("local")}</span>` : ""}${!prs.length && issue.prCount ? `<span class="code-muted" data-tip="Jira's development panel sees ${issue.prCount} ${issue.prCount === 1 ? "PR" : "PRs"} (${escapeHtml(issue.prState.toLowerCase())}) the viewer can't match">${issue.prCount} in Jira</span>` : ""}`;
}

// ---------- lists ----------

const matches = (issue) => !ui.filter || ui.filter.toLowerCase().split(/\s+/).every((word) => `${issue.key} ${issue.summary} ${issue.status} ${issue.assignee?.name || "unassigned"} ${issue.labels.join(" ")} ${aliasesFor(issue.key).join(" ")} ${byKey().get(issue.parent)?.summary || ""}`.toLowerCase().includes(word));
const personKey = (issue) => issue.assignee?.name || "";
const peopleFilter = (issue) => !ui.people.size || ui.people.has(personKey(issue));
// Linear copies of Jira issues (the two-way sync's mirrors) only show on the Migration tab, beside their originals.
const sourceMatch = (issue) => ui.source === "all" || (issue.source || "jira") === ui.source;
const base = () => ui.data.issues.filter((issue) => issue.inScope && (ui.showBots || !issue.bot) && !issue.mirrorOf && sourceMatch(issue));
const SCOPES = {
  all: ["All", () => true],
  mine: ["Mine", isMine],
  unassigned: ["Unassigned", (issue) => !issue.assignee],
  active: ["In progress", (issue) => issue.category === "indeterminate"],
  due: ["Due in 7 days", (issue) => issue.due && new Date(`${issue.due}T23:59:59`) - Date.now() < 7 * DAY],
  code: ["With PRs", (issue) => codeOf(issue).prs.length > 0],
};
const open = (issue) => ui.showDone || issue.category !== "done";
const byUpdated = (a, b) => b.updated.localeCompare(a.updated);
function visibleIssues() {
  if (ui.tab === "triage") return base().filter(isTriage).filter(peopleFilter).filter(matches).sort(byUpdated);
  return base().filter(open).filter(SCOPES[ui.scope]?.[1] || SCOPES.all[1]).filter(peopleFilter).filter(matches).sort(byUpdated);
}

const tableHead = (columns) => `<thead><tr>${columns.map(([className, label]) => `<th class="${className}"${className === "issue-col-priority" ? ` data-tip="${PRIORITY_LEGEND}"` : ""}>${label}</th>`).join("")}</tr></thead>`;
const parentLine = (issue) => {
  const parent = byKey().get(issue.parent);
  const aliases = aliasesFor(issue.key);
  const children = issue.level >= 1 ? childrenOf(issue.key) : [];
  const bits = [parent ? `<button type="button" class="issue-parent" data-issue-open="${escapeHtml(parent.key)}" data-tip="Open ${escapeHtml(parent.type.toLowerCase())} overview">${typeIcon(parent)}<span>${escapeHtml(parent.summary)}</span></button>` : "",
    children.length ? progress(children) : "", aliases.length ? `<span class="code-muted" data-tip="Imported from ${escapeHtml(aliases.join(", "))}">was ${escapeHtml(aliases.join(", "))}</span>` : "",
    issue.source === "github" && issue.labels.length ? `<span class="issue-labels">${issue.labels.map(escapeHtml).join(" · ")}</span>` : "",
    issue.source === "github" && issue.comments ? `<span class="issue-comment-count" data-tip="${issue.comments} comment${issue.comments === 1 ? "" : "s"}">${icon("comment")}${issue.comments}</span>` : ""].filter(Boolean);
  return bits.length ? `<div class="code-sub issue-sub">${bits.join("")}</div>` : "";
};

// Under its repository's header a GitHub issue needs only its number; elsewhere the key names the repository too.
const shortKey = (issue) => issue.source === "github" ? `<code>#${escapeHtml(label(issue).split("#")[1])}</code>` : keyCell(issue);
function issueRow(issue, { check = false, columns = COLUMNS, inGroup = false } = {}) {
  const key = issue.key;
  const cells = {
    "issue-col-priority": () => priorityIcon(issue),
    "issue-col-key": () => `<span class="issue-key-cell">${typeIcon(issue)}${inGroup ? shortKey(issue) : keyCell(issue)}</span>`,
    "code-col-main": () => `<div class="code-pr-title">${escapeHtml(issue.summary)}</div>${parentLine(issue)}`,
    "issue-col-status": () => statusTag(issue),
    "issue-col-person": () => personMark(issue.assignee),
    "issue-col-code": () => codeChips(issue),
    "code-col-when": () => `${when(issue.updated)}${ui.tab === "triage" ? `<span class="issue-seen-mark" data-tip="${isSeen(issue) ? "Seen at this version (X)" : "Not seen yet (X)"}">${isSeen(issue) ? icon("pass") : ""}</span>` : ""}`,
  };
  return `<tr class="code-row issue-row${isSeen(issue) && ui.tab === "triage" ? " is-seen" : ""}${issue.inScope ? "" : " is-context"}${issue.category === "done" ? " is-done" : ""}" data-issue-row="${escapeHtml(key)}" aria-selected="${ui.sel === key}">
    ${check ? `<td class="issue-col-check"><input type="checkbox" data-issue-select="${escapeHtml(key)}" aria-label="Select ${escapeHtml(key)}" ${ui.selected.has(key) ? "checked" : ""}></td>` : ""}
    ${columns.map(([name]) => `<td class="${name}${name === "code-col-when" ? ` code-heat-${heat(issue.updated)}` : ""}">${cells[name]()}</td>`).join("")}</tr>`;
}

function emptyState(noun) {
  const narrowing = [ui.tab !== "triage" && ui.scope !== "all" && SCOPES[ui.scope][0].toLowerCase(), ui.people.size && "picked people", ui.filter && `“${ui.filter}”`].filter(Boolean);
  if (!narrowing.length) return `<div class="code-empty"><p>No ${noun}.</p></div>`;
  return `<div class="code-empty"><p>No ${noun} match ${narrowing.map(escapeHtml).join(", ")}.</p><button type="button" class="code-bar-button" data-issue-reset>Clear filters <kbd>Esc</kbd></button></div>`;
}

const GROUPS = [["Last 24 hours", DAY], ["This week", 7 * DAY], ["This month", 30 * DAY], ["Older", Infinity]];
function grouped(issues, row, columns) {
  const seenKeys = new Set();
  const sections = GROUPS.map(([label, span]) => {
    const rows = issues.filter((issue) => !seenKeys.has(issue.key) && Date.now() - new Date(issue.updated) < span);
    rows.forEach((issue) => seenKeys.add(issue.key));
    return rows.length ? `<tbody><tr class="code-group-row"><th colspan="${columns.length}">${label} <span>${rows.length}</span></th></tr>${rows.map(row).join("")}</tbody>` : "";
  }).join("");
  return `<table class="code-table issue-table">${tableHead(columns)}${sections}</table>`;
}
const PRIORITY_HEAD = `<span class="issue-priority-head" aria-label="Priority"><svg class="code-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${PRIORITY.Urgent[1]}"/></svg></span>`;
const COLUMNS = [["issue-col-priority", PRIORITY_HEAD], ["issue-col-key", "Issue"], ["code-col-main", "Title"], ["issue-col-status", "Status"], ["issue-col-person", "Assignee"], ["issue-col-code", "Code"], ["code-col-when", "Updated"]];
// A column that would be blank, or the same, on every row stays out: GitHub issues carry no priority, a solo
// repository has no assignees, and an all-open list needs no status.
function columnsFor(issues) {
  const keep = {
    "issue-col-priority": issues.some((issue) => issue.priority),
    "issue-col-status": new Set(issues.map((issue) => issue.status)).size > 1 || issues.some((issue) => issue.source !== "github"),
    "issue-col-person": issues.some((issue) => issue.assignee),
    "issue-col-code": issues.some((issue) => codeOf(issue).prs.length || codeOf(issue).worktrees.length || issue.prCount),
  };
  return COLUMNS.filter(([name]) => keep[name] ?? true);
}
// "repo" when every issue is a GitHub one, else "project" (a Jira project or a Linear team).
const groupNoun = (issues) => (issues.every((issue) => issue.source === "github") ? "repo" : "project");
const done = (issue) => issue.category === "done";
const repoName = (slug) => slug.split("/").pop();

// One section per repository (or project), the most recently touched first; open issues above closed ones in each.
function byProject(issues, columns) {
  const groups = new Map();
  for (const issue of issues) groups.set(issue.project, [...(groups.get(issue.project) || []), issue]);
  const sections = [...groups].map(([project, rows]) => {
    const sorted = rows.sort((a, b) => done(a) - done(b) || byUpdated(a, b));
    const closed = sorted.filter(done).length;
    const collapsed = ui.collapsed.has(project);
    const latest = sorted.reduce((last, issue) => (issue.updated > last ? issue.updated : last), "");
    const home = sorted[0].source === "github" ? sorted[0].url.replace(/\/issues\/\d+$/, "/issues") : "";
    const head = `<tr class="code-group-row issue-project-row"><th colspan="${columns.length}"><button type="button" class="issue-project-toggle" data-issue-collapse="${escapeHtml(project)}" aria-expanded="${!collapsed}"><svg class="code-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg><span class="issue-project-name">${escapeHtml(project)}</span><span class="issue-project-count">${[sorted.length - closed && `${sorted.length - closed} open`, closed && `${closed} closed`].filter(Boolean).join(" · ")}</span></button>${home ? `<a class="issue-project-link" href="${escapeHtml(home)}" target="_blank" rel="noreferrer" data-tip="${escapeHtml(project)} issues on GitHub">${icon("external")}</a>` : ""}<span class="issue-project-when code-heat-${heat(latest)}">${when(latest)}</span></th></tr>`;
    return { latest, html: `<tbody>${head}${collapsed ? "" : sorted.map((issue) => issueRow(issue, { columns, inGroup: true })).join("")}</tbody>` };
  }).sort((a, b) => b.latest.localeCompare(a.latest));
  return `<table class="code-table issue-table">${tableHead(columns)}${sections.map((section) => section.html).join("")}${quietRepos(issues, columns)}</table>`;
}
// Tracked repositories with nothing in the list, named once at the foot so the page accounts for every one of them.
function quietRepos(issues, columns) {
  if (ui.filter || ui.people.size || ui.scope !== "all" || !(ui.data.githubRepos || []).length) return "";
  const shown = new Set(issues.map((issue) => issue.project));
  const quiet = ui.data.githubRepos.map(repoName).filter((name) => !shown.has(name)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return quiet.length ? `<tbody><tr class="issue-quiet-repos"><td colspan="${columns.length}">No ${ui.showDone ? "" : "open "}issues in ${quiet.map(escapeHtml).join(", ")}</td></tr></tbody>` : "";
}

function allBody() {
  const issues = visibleIssues();
  if (!issues.length) return emptyState(ui.showDone ? "issues" : "open issues");
  const columns = columnsFor(issues);
  return ui.group === "repo" ? byProject(issues, columns.map(([name, head]) => [name, name === "issue-col-key" ? "#" : head])) : grouped(issues, (issue) => issueRow(issue, { columns }), columns);
}

function triageBody() {
  const all = visibleIssues();
  const issues = ui.hideSeen ? all.filter((issue) => !isSeen(issue)) : all;
  if (!all.length) return emptyState("issues waiting for triage");
  const done = all.length && !issues.length ? `<p class="code-muted issue-all-seen">All ${all.length} seen at their current version. <button type="button" class="code-bar-button" data-issue-hide-seen>Show them <kbd>U</kbd></button></p>` : "";
  return done || `<table class="code-table issue-table">${tableHead([["issue-col-check", `<input type="checkbox" data-issue-select-all aria-label="Select all" ${issues.every((issue) => ui.selected.has(issue.key)) ? "checked" : ""}>`], ...COLUMNS])}<tbody>${issues.map((issue) => issueRow(issue, { check: true })).join("")}</tbody></table>`;
}

// ---------- epics ----------

const childrenOf = (key) => ui.data.issues.filter((issue) => issue.parent === key && (ui.showBots || !issue.bot));
function progress(children) {
  const counts = { done: 0, indeterminate: 0, new: 0 };
  for (const child of children) counts[child.category] = (counts[child.category] || 0) + 1;
  const total = children.length;
  const bar = (kind) => `<span class="issue-progress-${kind}" style="width:${total ? (counts[kind] / total) * 100 : 0}%"></span>`;
  return `<span class="issue-progress-wrap" data-tip="${counts.done} done · ${counts.indeterminate} in progress · ${counts.new} to do"><span class="issue-progress">${bar("done")}${bar("indeterminate")}</span><span class="issue-progress-count">${counts.done}/${total}</span></span>`;
}
const confidenceMark = (issue) => issue.confidence ? `<span class="issue-confidence" data-tip="${escapeHtml(issue.confidence)}">${escapeHtml([...issue.confidence][0])}</span>` : "";
const dateRange = (issue) => issue.start || issue.due ? `<span class="issue-dates${issue.due && issue.category !== "done" && new Date(`${issue.due}T23:59:59`) < Date.now() ? " is-late" : ""}">${escapeHtml(issue.start ? shortDate(issue.start) : "…")} → ${escapeHtml(issue.due ? shortDate(issue.due) : "…")}</span>` : "";
const shortDate = (value) => new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function epicRow(epic) {
  const children = childrenOf(epic.key);
  const expanded = ui.expanded.has(epic.key);
  const shown = children.filter(open).sort((a, b) => ({ indeterminate: 0, new: 1, done: 2 }[a.category] - { indeterminate: 0, new: 1, done: 2 }[b.category]) || byUpdated(a, b));
  const row = `<tr class="code-row issue-row issue-epic-row${epic.inScope ? "" : " is-context"}" data-issue-row="${escapeHtml(epic.key)}" aria-selected="${ui.sel === epic.key}">
    <td class="issue-col-key"><span class="issue-key-cell"><button type="button" class="issue-chevron" data-issue-expand="${escapeHtml(epic.key)}" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} ${escapeHtml(label(epic))}" ${children.length ? "" : "disabled"}><svg class="code-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>${typeIcon(epic)}${keyMark(epic)}</span></td>
    <td class="code-col-main"><div class="code-pr-title">${escapeHtml(epic.summary)}</div></td>
    <td class="issue-col-progress">${progress(children)}</td>
    <td class="issue-col-confidence">${confidenceMark(epic)}</td>
    <td class="issue-col-status">${statusTag(epic)}</td>
    <td class="issue-col-dates">${dateRange(epic)}</td>
    <td class="issue-col-person">${personMark(epic.assignee)}</td>
    <td class="code-col-when code-heat-${heat(epic.updated)}">${when(epic.updated)}</td></tr>`;
  const kids = expanded ? shown.map((child) => childRow(child)).join("") : "";
  return row + kids;
}
function childRow(issue) {
  return `<tr class="code-row issue-row issue-child-row${issue.inScope ? "" : " is-context"}" data-issue-row="${escapeHtml(issue.key)}" aria-selected="${ui.sel === issue.key}">
    <td class="issue-col-key"><span class="issue-key-cell issue-indent">${typeIcon(issue)}${keyCell(issue)}</span></td>
    <td class="code-col-main"><div class="issue-child-title">${escapeHtml(issue.summary)}</div></td>
    <td class="issue-col-progress">${codeChips(issue)}</td>
    <td class="issue-col-confidence">${priorityIcon(issue)}</td>
    <td class="issue-col-status">${statusTag(issue)}</td>
    <td class="issue-col-dates">${issue.due ? `<span class="issue-dates">due ${escapeHtml(shortDate(issue.due))}</span>` : ""}</td>
    <td class="issue-col-person">${personMark(issue.assignee)}</td>
    <td class="code-col-when code-heat-${heat(issue.updated)}">${when(issue.updated)}</td></tr>`;
}

// Initiatives group their epics; an epic counts when it, or any of its children, is in scope.
function epicGroups() {
  const epics = ui.data.issues.filter((issue) => issue.level === 1 && sourceMatch(issue) && (issue.inScope || childrenOf(issue.key).some((child) => child.inScope)))
    .filter((epic) => open(epic) && (matches(epic) || childrenOf(epic.key).some(matches)) && (!ui.people.size || peopleFilter(epic) || childrenOf(epic.key).some(peopleFilter)));
  const groups = new Map();
  for (const epic of epics.sort(byUpdated)) {
    const parent = byKey().get(epic.parent);
    const key = parent?.level >= 2 ? parent.key : epic.source === "linear" ? "linear" : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(epic);
  }
  const order = (key) => (key === "linear" ? 2 : key ? 0 : 1);
  return [...groups].sort(([a], [b]) => order(a) - order(b));
}
function epicsBody() {
  const groups = epicGroups();
  if (!groups.length) return emptyState(ui.showDone ? "epics" : "open epics");
  const columns = [["issue-col-key", "Epic"], ["code-col-main", "Title"], ["issue-col-progress", "Progress"], ["issue-col-confidence", ""], ["issue-col-status", "Status"], ["issue-col-dates", "Dates"], ["issue-col-person", "Owner"], ["code-col-when", "Updated"]];
  const sections = groups.map(([key, epics]) => {
    const initiative = byKey().get(key);
    const head = initiative
      ? `<tr class="code-group-row issue-initiative-row" data-issue-row="${escapeHtml(initiative.key)}" aria-selected="${ui.sel === initiative.key}"><th colspan="${columns.length}">${typeIcon(initiative)}<button type="button" class="issue-initiative" data-issue-open="${escapeHtml(initiative.key)}">${escapeHtml(initiative.key)} ${escapeHtml(initiative.summary)}</button>${confidenceMark(initiative)} <span>${epics.length} ${epics.length === 1 ? "epic" : "epics"} · ${escapeHtml(initiative.status)}</span></th></tr>`
      : `<tr class="code-group-row"><th colspan="${columns.length}">${key === "linear" ? "Linear projects" : "No initiative"} <span>${epics.length}</span></th></tr>`;
    return `<tbody>${head}${epics.map(epicRow).join("")}</tbody>`;
  }).join("");
  return `<table class="code-table issue-table issue-epics">${tableHead(columns)}${sections}</table>`;
}

// ---------- activity ----------

const ACTIVITY_SCOPES = { all: "Everything", mine: "Mine", comments: "Comments", status: "Status" };
function activityRows() {
  const issues = byKey();
  const since = ui.since ? new Date(`${ui.since}T00:00:00`).getTime() : 0;
  return ui.data.activity.filter((row) => {
    const issue = issues.get(row.key);
    if (!issue || (!ui.showBots && issue.bot) || issue.mirrorOf || !sourceMatch(issue) || new Date(row.at).getTime() < since) return false;
    if (ui.activityScope === "mine" && !isMine(issue)) return false;
    if (ui.activityScope === "comments" && row.kind !== "comment") return false;
    if (ui.activityScope === "status" && !["status", "created"].includes(row.kind)) return false;
    return peopleFilter(issue) && matches(issue);
  });
}
const KIND_TEXT = {
  created: (row) => `created${row.by ? ` by ${escapeHtml(row.by)}` : ""}`,
  comment: (row) => `<b>${escapeHtml(row.by || "Someone")}</b> commented: <span class="issue-activity-quote">${escapeHtml(row.text.replace(/\s+/g, " ").slice(0, 160))}</span>`,
  labels: (row) => [row.to && `labeled ${escapeHtml(row.to)}`, row.from && `unlabeled ${escapeHtml(row.from)}`].filter(Boolean).join(" · "),
};
const changeText = (row) => (KIND_TEXT[row.kind] || ((change) => `${escapeHtml(change.kind)} <span class="code-muted">${escapeHtml(change.from || "none")}</span> → <b>${escapeHtml(change.to || "none")}</b>`))(row);
const dayLabel = (time) => {
  const date = new Date(time);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / DAY);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
};
function activityBody() {
  const rows = activityRows();
  if (!rows.length) return emptyState("activity");
  const shown = rows.slice(0, 400); // ponytail: a flat cap; page by day if the feed gets long
  const days = new Map();
  for (const row of shown) { const label = dayLabel(row.at); if (!days.has(label)) days.set(label, []); days.get(label).push(row); }
  const issues = byKey();
  const sections = [...days].map(([label, items]) => `<tbody><tr class="code-group-row"><th colspan="4">${escapeHtml(label)} <span>${items.length}</span></th></tr>${items.map((row) => {
    const issue = issues.get(row.key);
    return `<tr class="code-row issue-row" data-issue-row="${escapeHtml(row.key)}" aria-selected="${ui.sel === row.key}"><td class="code-col-when">${new Date(row.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</td><td class="issue-col-key"><span class="issue-key-cell">${typeIcon(issue)}${keyCell(issue)}</span></td><td class="code-col-main"><div class="issue-child-title">${escapeHtml(issue.summary)}</div><div class="code-sub issue-activity-change">${changeText(row)}</div></td><td class="issue-col-person">${personMark(issue.assignee)}</td></tr>`;
  }).join("")}</tbody>`).join("");
  return `<table class="code-table issue-table issue-activity">${sections}</table>${rows.length > shown.length ? `<p class="code-muted issue-more">Showing the newest ${shown.length} of ${rows.length}. Narrow with the filter or a day.</p>` : ""}`;
}

// ---------- inspector and overview ----------

function skillButtons(keys) {
  return (ui.data.skills || []).map((skill, index) => iconButton(skill.icon || "review", `${skill.label}${keys.length > 1 ? ` ${keys.length} issues` : ""} in ${appName()} (${index + 1})`, `data-issue-skill="${escapeHtml(skill.id)}" data-keys="${escapeHtml(keys.join(","))}"`)).join("");
}

function issueFacts(issue, overlay = false) {
  const parent = byKey().get(issue.parent);
  const aliases = aliasesFor(issue.key);
  const keys = ui.selected.size && ui.selected.has(issue.key) && !overlay ? [...ui.selected] : [issue.key];
  const status = sideStatus(issue.category === "done" ? "pass" : issue.category === "indeterminate" ? "progress" : "quiet", issue.category === "done" ? "pass" : issue.category === "indeterminate" ? "pending" : "draft", escapeHtml(issue.status));
  return sideFacts([
    ["Status", `${status}${issue.resolution && issue.resolution !== "Done" ? `<span class="code-muted">${escapeHtml(issue.resolution)}</span>` : ""}${issue.confidence ? `<span>${escapeHtml(issue.confidence)}</span>` : ""}`],
    ["Type", `${typeIcon(issue)}<span>${escapeHtml(issue.type)}</span>${priorityIcon(issue)}<span class="code-muted">${escapeHtml(issue.priority)}</span>`],
    ["Owner", `${personMark(issue.assignee, true)}${issue.reporter && issue.reporter.name !== issue.assignee?.name ? `<span class="code-muted">from ${escapeHtml(issue.reporter.name)}</span>` : ""}`],
    [issue.source === "linear" && parent?.type === "Project" ? "Project" : "Parent", parent ? `<button type="button" class="issue-link-row" data-issue-open="${escapeHtml(parent.key)}">${typeIcon(parent)}${keyMark(parent)}<span>${escapeHtml(parent.summary)}</span></button>` : issue.parent ? `<code>${escapeHtml(keyLabel(issue.parent))}</code>` : ""],
    ["Dates", `<span class="code-muted" data-tip="Created ${escapeHtml(new Date(issue.created).toLocaleString())}">opened ${ago(issue.created)} ago</span><span class="code-muted" data-tip="Updated ${escapeHtml(new Date(issue.updated).toLocaleString())}">updated ${ago(issue.updated)} ago</span>${dateRange(issue)}`],
    ["Initiative", (issue.initiatives || []).map((item) => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.name)}</a>`).join("")],
    ["Labels", issue.labels.filter((label) => !aliases.includes(label.toUpperCase())).map((label) => `<span class="code-tag">${escapeHtml(label)}</span>`).join("")],
    ["Was", aliases.map((alias) => `<code>${escapeHtml(alias)}</code>`).join(" ")],
    [appName(), `<span class="code-side-skills">${skillButtons(keys)}</span>`],
    [trackerName(issue), `<span class="code-side-tools"><a class="code-icon-button" href="${escapeHtml(issueUrl(issue.key))}" target="_blank" rel="noreferrer" data-tip="Open in ${trackerName(issue)} (O)" aria-label="Open in ${trackerName(issue)}">${icon("external")}</a>${iconButton("copy", "Copy link (Y)", `data-issue-copy="${escapeHtml(issueUrl(issue.key))}"`)}${overlay ? "" : iconButton("expand", "Open overview (Enter)", `data-issue-open="${escapeHtml(issue.key)}"`)}</span>`],
  ]);
}

function codeSection(issue) {
  const { prs, worktrees } = codeOf(issue);
  if (!prs.length && !worktrees.length) return issue.prCount ? `<section>${sideHead("Code")}<p class="code-muted">Jira's development panel sees ${issue.prCount} ${issue.prCount === 1 ? "PR" : "PRs"} (${escapeHtml(issue.prState.toLowerCase())}); none mention this key.</p></section>` : "";
  return `<section>${sideHead("Code", String(prs.length + worktrees.length))}<ul class="issue-code-list">${prs.map((pr) => `<li>${prMark(pr)}<span>${escapeHtml(pr.title || pr.url)}</span>${pr.author ? avatar(pr.author) : ""}</li>`).join("")}${worktrees.map((tree) => `<li><button type="button" class="issue-link-row" data-issue-wt="${escapeHtml(tree.path)}" data-tip="Worktree overview">${icon("branch")}<span>${escapeHtml(tree.branch)}</span></button></li>`).join("")}</ul></section>`;
}

const linkRow = (key, summary, status, category, label = "") => `<li><button type="button" class="issue-link-row" data-issue-open="${escapeHtml(key)}">${label ? `<span class="code-muted">${escapeHtml(label)}</span>` : ""}${byKey().has(key) ? typeIcon(byKey().get(key)) : ""}<code>${escapeHtml(keyLabel(key))}</code><span>${escapeHtml(summary)}</span><span class="code-tag issue-status issue-status-${escapeHtml(category)}">${escapeHtml(status)}</span></button></li>`;
// Tasks first, then every other planning document that mentions this key (or a key it used to have).
function planningSection(issue) {
  const keys = [issue.key, ...aliasesFor(issue.key)].map((key) => key.replace(/^(linear|github):/, ""));
  const docs = planning.documents().filter((doc) => doc.issueKeys?.some((key) => keys.includes(key))).sort((a, b) => !!b.task - !!a.task);
  if (!docs.length) return "";
  return `<section>${sideHead("In planning", String(docs.length))}<ul class="issue-code-list">${docs.map((doc) => `<li><a class="issue-link-row" href="${escapeHtml(documentHref(doc.path, ""))}" data-planning-path="${escapeHtml(doc.path)}" data-tip="${escapeHtml(doc.path)}">${doc.task ? SERVICE_ICONS.task : icon("doc")}<code>${escapeHtml(doc.task?.id || doc.date || doc.kind)}</code><span>${escapeHtml(doc.task?.title || doc.title)}</span>${doc.task ? `<span class="code-tag">${escapeHtml(doc.task.status)}</span>` : ""}</a></li>`).join("")}</ul></section>`;
}
function relationsSection(issue, overlay = false) {
  const children = childrenOf(issue.key).sort((a, b) => a.category.localeCompare(b.category) || byUpdated(a, b));
  const kids = children.length && !overlay ? `<section>${sideHead("Children", `${children.filter((child) => child.category === "done").length}/${children.length} done`)}${progress(children)}<ul class="issue-code-list">${children.map((child) => linkRow(child.key, child.summary, child.status, child.category)).join("")}</ul></section>` : "";
  const links = issue.links.length ? `<section>${sideHead("Links", String(issue.links.length))}<ul class="issue-code-list">${issue.links.map((link) => linkRow(link.key, link.summary, link.status, link.category, link.label)).join("")}</ul></section>` : "";
  return planningSection(issue) + counterpartsSection(issue) + kids + links;
}

// ---------- migration: the same work in Linear and Jira ----------

const ROLES = { mirror: ["Linear copy", "Jira original"], import: ["Jira import", "Linear original"], title: ["Same title", "Same title"] };
// The other side of every pair this issue is in, named by what it is to this one.
function counterparts(key) {
  return (ui.data.pairs || []).flatMap((pair) => pair.a === key ? [[pair.b, ROLES[pair.kind][1], pair.kind]] : pair.b === key ? [[pair.a, ROLES[pair.kind][0], pair.kind]] : []);
}
function counterpartsSection(issue) {
  const items = counterparts(issue.key).filter(([key]) => byKey().has(key));
  if (!items.length) return "";
  return `<section>${sideHead("In the other tracker", String(items.length))}<ul class="issue-code-list">${items.map(([key, role]) => { const other = byKey().get(key); return linkRow(key, other.summary, other.status, other.category, role); }).join("")}</ul></section>`;
}

// Each group of linked items, plus every open Linear original with no Jira counterpart.
const MIGRATION = { linear: "In Linear only", drift: "Out of step", copies: "Open Linear copies", title: "Same title", linked: "Linked" };
function migrationGroups() {
  const issues = byKey();
  const kinds = new Map();
  for (const pair of ui.data.pairs || []) for (const key of [pair.a, pair.b]) kinds.set(key, [...(kinds.get(key) || []), pair.kind]);
  const groups = (ui.data.clusters || []).map((keys) => keys.map((key) => issues.get(key)).filter(Boolean)).filter((members) => members.length > 1).map((members) => {
    const pairKinds = new Set(members.flatMap((member) => kinds.get(member.key) || []));
    // Originals and imports should agree on how far along the work is; a synced Linear copy is a duplicate to close.
    const stages = new Set(members.filter((member) => !member.mirrorOf).map((member) => member.category));
    const openCopy = members.some((member) => member.mirrorOf && member.category !== "done");
    const kind = pairKinds.size === 1 && pairKinds.has("title") ? "title" : stages.size > 1 ? "drift" : openCopy ? "copies" : "linked";
    const primary = members.find((member) => member.source !== "linear" && !member.mirrorOf && !(kinds.get(member.key) || []).includes("import")) || members.find((member) => member.source !== "linear") || members[0];
    return { kind, primary, members, updated: members.map((member) => member.updated).sort().at(-1) };
  });
  const paired = new Set((ui.data.clusters || []).flat());
  const alone = ui.data.issues.filter((issue) => issue.source === "linear" && !issue.mirrorOf && issue.category !== "done" && !paired.has(issue.key))
    .map((issue) => ({ kind: "linear", primary: issue, members: [issue], updated: issue.updated }));
  const all = [...groups, ...alone].filter(({ members }) => (ui.showBots || !members.some((member) => member.bot)) && members.some(matches) && (!ui.people.size || members.some(peopleFilter)));
  return all.sort((a, b) => b.updated.localeCompare(a.updated));
}
const memberChip = (issue) => `<button type="button" class="issue-member" data-issue-open="${escapeHtml(issue.key)}" data-tip="${escapeHtml(`${trackerName(issue)} · ${issue.status}${issue.mirrorOf ? " · synced copy" : ""}`)}">${typeIcon(issue)}<code>${escapeHtml(label(issue))}</code><span class="code-tag issue-status issue-status-${issue.category}">${escapeHtml(issue.status)}</span></button>`;
const RELATION = { mirror: "synced", import: "imported", title: "same title?" };
function migrationRow(group) {
  const { primary, members } = group;
  const side = (linear) => members.filter((member) => (member.source === "linear") === linear).map(memberChip).join("");
  const kinds = [...new Set((ui.data.pairs || []).filter((pair) => members.some((member) => member.key === pair.a)).map((pair) => RELATION[pair.kind]))];
  return `<tr class="code-row issue-row" data-issue-row="${escapeHtml(primary.key)}" aria-selected="${ui.sel === primary.key}">
    <td class="issue-col-check"><input type="checkbox" data-issue-select="${escapeHtml(primary.key)}" aria-label="Select ${escapeHtml(label(primary))}" ${ui.selected.has(primary.key) ? "checked" : ""}></td>
    <td class="code-col-main"><div class="code-pr-title">${escapeHtml(primary.summary)}</div>${parentLine(primary)}</td>
    <td class="issue-col-side">${side(true) || '<span class="code-muted">—</span>'}</td>
    <td class="issue-col-relation">${kinds.length ? escapeHtml(kinds.join(", ")) : ""}</td>
    <td class="issue-col-side">${side(false) || '<span class="code-muted">not in Jira</span>'}</td>
    <td class="issue-col-person">${personMark(primary.assignee)}</td>
    <td class="code-col-when code-heat-${heat(group.updated)}">${when(group.updated)}</td></tr>`;
}
function migrationBody() {
  const groups = migrationGroups().filter((group) => group.kind === ui.migration);
  if (!groups.length) return emptyState(MIGRATION[ui.migration].toLowerCase());
  const columns = [["issue-col-check", ""], ["code-col-main", "Title"], ["issue-col-side", "Linear"], ["issue-col-relation", ""], ["issue-col-side", "Jira"], ["issue-col-person", "Assignee"], ["code-col-when", "Updated"]];
  const note = { linear: "Open Linear issues and projects with no Jira copy: what's left to migrate.", drift: "Linked across trackers, but at different stages: in progress on one side and in the backlog or finished on the other.", copies: "Jira issues the two-way sync copied into Linear, where the copy is still open: duplicates to close in Linear.", title: "No sync or import marker, but the same title: likely duplicates to confirm.", linked: "Linked by the sync or the import and in step." }[ui.migration];
  return `<p class="code-muted issue-migration-note">${note}</p>${grouped(groups.map((group) => ({ ...group.primary, updated: group.updated, group })), (item) => migrationRow(item.group), columns)}`;
}

// A project's or epic's issues in the overview, in progress first, each opening with J/K walking its siblings.
const STAGES = [["indeterminate", "In progress"], ["new", "To do"], ["done", "Done"]];
function childrenTable(issue) {
  const children = childrenOf(issue.key);
  if (!children.length) return "";
  const stages = STAGES.map(([category, title]) => [title, children.filter((child) => child.category === category).sort(byUpdated)]).filter(([, rows]) => rows.length);
  const keys = stages.flatMap(([, rows]) => rows.map((child) => child.key)).join(",");
  const body = stages.map(([title, rows]) => `<tbody><tr class="code-group-row"><th colspan="6">${title} <span>${rows.length}</span></th></tr>${rows.map((child) => `<tr class="code-row issue-row" data-issue-open="${escapeHtml(child.key)}" data-issue-list="${escapeHtml(keys)}">
    <td class="issue-col-priority">${priorityIcon(child)}</td>
    <td class="issue-col-key"><span class="issue-key-cell">${typeIcon(child)}${keyCell(child)}</span></td>
    <td class="code-col-main"><div class="issue-child-title">${escapeHtml(child.summary)}</div></td>
    <td class="issue-col-status">${statusTag(child)}</td>
    <td class="issue-col-person">${personMark(child.assignee)}</td>
    <td class="code-col-when code-heat-${heat(child.updated)}">${when(child.updated)}</td></tr>`).join("")}</tbody>`).join("");
  return `<section>${sideHead(issue.type === "Project" ? "Issues" : "Children", String(children.length))}${progress(children)}<table class="code-table issue-table issue-children">${body}</table></section>`;
}

// Jira and Linear keep single line breaks, so two plain lines in a row are two paragraphs here, not one.
const PLAIN = /^(?!\s*([-+*]\s|\d+\.\s|>|#|```|\|))\S/;
function softBreaks(text) {
  let fenced = false;
  return text.split(/\r?\n/).map((line, index, lines) => {
    if (line.startsWith("```")) fenced = !fenced;
    return !fenced && PLAIN.test(line) && PLAIN.test(lines[index + 1] || "") && !line.includes("|") ? `${line}\n` : line;
  }).join("\n");
}
const markdownBlock = (text) => `<div class="markdown code-description issue-markdown">${renderMarkdown(softBreaks(text), "")}</div>`;
function textSections(issue, full) {
  const detail = ui.detail.get(issue.key);
  if (!detail) return `<section><p class="code-muted">${ui.detail.has(issue.key) ? "Loading…" : ""}</p></section>`;
  const comments = full ? detail.comments : detail.comments.slice(-2);
  const update = detail.statusUpdate ? `<section>${sideHead("Status update")}${markdownBlock(detail.statusUpdate)}</section>` : "";
  const description = `<section>${sideHead("Description")}${detail.description ? markdownBlock(full || detail.description.length < 900 ? detail.description : `${detail.description.slice(0, 900)}…`) : '<p class="code-muted">No description.</p>'}</section>`;
  const thread = detail.comments.length ? `<section>${sideHead("Comments", full || detail.comments.length <= 2 ? String(detail.comments.length) : `last 2 of ${detail.comments.length}`)}<ol class="issue-comments">${comments.map((comment) => `<li><header>${avatar("", comment.author?.name || "?", comment.author?.email)}<b>${escapeHtml(comment.author?.name || "Unknown")}</b>${when(comment.created)}</header>${markdownBlock(comment.body)}</li>`).join("")}</ol></section>` : "";
  const milestones = detail.milestones?.length ? `<section>${sideHead("Milestones", `${detail.milestones.filter((item) => item.status === "done").length}/${detail.milestones.length} done`)}<ol class="issue-milestones">${detail.milestones.map((item) => `<li class="issue-milestone-${escapeHtml(item.status)}">
    <header><b>${escapeHtml(item.name)}</b>${item.target ? `<span class="code-muted">${escapeHtml(item.target)}</span>` : ""}<span class="code-muted">${Math.round(item.progress * 100)}%</span></header>${item.description && full ? markdownBlock(item.description) : ""}</li>`).join("")}</ol></section>` : "";
  const resources = detail.resources?.length ? `<section>${sideHead("Resources", String(detail.resources.length))}<ul class="issue-code-list">${detail.resources.map((item) => `<li><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${icon("external")}<span>${escapeHtml(item.name)}</span></a></li>`).join("")}</ul></section>` : "";
  return update + description + milestones + resources + (full ? childrenTable(issue) : "") + thread;
}

async function loadDetail(key) {
  if (ui.detail.has(key)) return;
  ui.detail.set(key, null);
  try {
    const response = await fetch(`/api/issues/issue?key=${encodeURIComponent(key)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load the issue.");
    ui.detail.set(key, body);
  } catch (error) {
    ui.detail.delete(key);
    notify(error.message, true);
  }
  if (ui.sel === key) renderDetail();
  if (dialog?.open && overview.key === key) renderOverview();
}

function renderDetail({ animate = false } = {}) {
  const pane = host?.querySelector(".issue-surface .code-detail"); // not another page's inspector in the same container
  if (!pane) return;
  const issue = byKey().get(ui.sel);
  const multi = ui.selected.size > 1 ? `<p class="issue-multi">${ui.selected.size} selected · ${skillButtons([...ui.selected])} <button type="button" class="code-bar-button" data-issue-select-none>Clear</button></p>` : "";
  pane.innerHTML = issue
    ? `${multi}<div class="code-detail-head">${typeIcon(issue)}<h3>${keyMark(issue)} ${escapeHtml(issue.summary)}</h3></div>${issueFacts(issue)}${codeSection(issue)}${relationsSection(issue)}${textSections(issue, false)}`
    : `${multi}<p class="code-detail-empty">Select an issue to see its details, code, and comments.<br><br><kbd>J</kbd><kbd>K</kbd> move · <kbd>Enter</kbd> overview · <kbd>1</kbd>–<kbd>${(ui.data.skills || []).length}</kbd> agent drafts · <kbd>Space</kbd> select · <kbd>X</kbd> seen · <kbd>O</kbd> open · <kbd>Y</kbd> copy link · <kbd>A</kbd> people · <kbd>F</kbd> filter · <kbd>R</kbd> refresh</p>`;
  if (animate) { pane.scrollTop = 0; fadeIn(pane, 160); }
  if (issue) loadDetail(issue.key);
}

// The issue inspector for other pages (Activity): the same sections as this page's, with its buttons routed through
// `handleIssueClick`. `loadIssueDetail` resolves once the description and comments are in.
export const issueInspector = (key) => {
  const issue = ui.data && byKey().get(key);
  return issue ? `<div class="code-detail-head">${typeIcon(issue)}<h3>${keyMark(issue)} ${escapeHtml(issue.summary)}</h3></div>${issueFacts(issue)}${codeSection(issue)}${relationsSection(issue)}${textSections(issue, false)}` : "";
};
export const loadIssueDetail = (key) => loadDetail(key);
export const issueLink = (key) => issueUrl(key);
export const handleIssueClick = (event) => handleClick(event);

// The overview: the issue in full, walking the list it was opened from with J/K and X.
let dialog = null;
const overview = { key: "", list: [] };
function ensureDialog() {
  if (dialog) return;
  dialog = Object.assign(document.body.appendChild(document.createElement("dialog")), { className: "code-diff issue-overview", tabIndex: -1 });
  dialog.innerHTML = `<header class="code-diff-head" data-o="head"></header><div class="issue-overview-split"><aside class="code-diff-pr" data-o="side"></aside><div class="issue-overview-main" data-o="main"></div></div>`;
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    document.dispatchEvent(new CustomEvent("overview-closed", { detail: location.href }));
    syncIssueUrl("");
    overview.key = "";
  });
  let pressedBackdrop = false;
  dialog.addEventListener("pointerdown", (event) => { pressedBackdrop = event.target === dialog; });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) { if (pressedBackdrop) dialog.close(); return; }
    if (event.target.closest("[data-issue-close]")) return dialog.close();
    handleClick(event);
  });
  dialog.addEventListener("pointerover", (event) => { const target = event.target.closest("[data-tip]"); if (target) showTip(target); else hideTip(); });
  dialog.addEventListener("pointerleave", hideTip);
  dialog.addEventListener("keydown", (event) => {
    if (isSummonKey(event)) return;
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.altKey || event.target.closest?.("input, textarea")) return;
    const key = event.key.toLowerCase();
    const issue = byKey().get(overview.key);
    const step = { j: 1, arrowdown: 1, k: -1, arrowup: -1 }[key];
    if (step) stepOverview(step);
    else if (key === "x" && issue) { const marked = toggleSeen(issue); const next = marked ? overview.list.slice(overview.list.indexOf(issue.key) + 1).find((candidate) => !isSeen(byKey().get(candidate))) : null; if (next) openIssue(next, overview.list); else renderOverview(); render(); }
    else if ((key === "[" || key === "]") && issue) stepSibling(issue, key === "]" ? 1 : -1);
    else if (key === "p" && issue?.parent && byKey().has(issue.parent)) openIssue(issue.parent, overview.list);
    else if (key === "o" && issue) window.open(issueUrl(issue.key), "_blank", "noreferrer");
    else if (key === "y" && issue) navigator.clipboard.writeText(issueUrl(issue.key)).then(() => notify(`Copied ${issueUrl(issue.key)}`));
    else if (/^[1-9]$/.test(key) && dialog.querySelectorAll(".code-side-skills [data-issue-skill]")[key - 1]) dialog.querySelectorAll(".code-side-skills [data-issue-skill]")[key - 1].click();
    else if (key === "w" && dialog.querySelector("[data-issue-wt]")) dialog.querySelector("[data-issue-wt]").click();
    else return;
    event.preventDefault();
  });
}
function stepOverview(step) {
  const index = overview.list.indexOf(overview.key);
  const next = overview.list[index + step];
  if (index >= 0 && next) openIssue(next, overview.list);
}
function stepSibling(issue, step) {
  if (!issue.parent) return;
  const siblings = childrenOf(issue.parent).sort(byUpdated).map((child) => child.key);
  const next = siblings[siblings.indexOf(issue.key) + step];
  if (next) openIssue(next, overview.list);
}
function renderOverview() {
  const issue = byKey().get(overview.key);
  if (!issue) return;
  const position = overview.list.indexOf(issue.key);
  const walk = position >= 0 && overview.list.length > 1 ? `<span class="code-muted">${position + 1} of ${overview.list.length} · <kbd>J</kbd><kbd>K</kbd> walk · <kbd>X</kbd> seen and next</span>` : "";
  const where = issue.source === "linear" ? `Linear · ${issue.project} team${issue.mirrorOf ? ` · synced copy of ${issue.mirrorOf}` : ""}` : issue.source === "github" ? `GitHub · ${issue.project}${issue.components.length ? ` · ${issue.components.join(", ")}` : ""}` : `${issue.project} · ${issue.components.join(", ") || "no component"}`;
  dialog.querySelector('[data-o="head"]').innerHTML = `${typeIcon(issue)}<div class="issue-overview-title"><h3>${keyMark(issue)} ${escapeHtml(issue.summary)}</h3><p class="code-muted">${escapeHtml(where)}${issue.inScope ? "" : " · outside the configured scope"}${isSeen(issue) ? " · seen" : ""}</p></div><span class="code-spacer"></span>${walk}${iconButton("fail", "Close (Esc)", "data-issue-close")}`;
  dialog.querySelector('[data-o="side"]').innerHTML = issueFacts(issue, true) + codeSection(issue) + relationsSection(issue, true);
  dialog.querySelector('[data-o="main"]').innerHTML = `<div class="issue-overview-text">${textSections(issue, true)}</div>`;
}
function syncIssueUrl(key) {
  const url = new URL(location.href);
  if (key) url.searchParams.set("issue", key); else url.searchParams.delete("issue");
  if (url.href !== location.href) history.replaceState(history.state, "", url);
}

// Opens the overview from anywhere (the Issues page, ⌘K, an ?issue= URL, Recently viewed).
export async function openIssue(key, list = null) {
  if (!ui.data) await load().catch(() => {});
  if (!byKey().has(key)) return notify(`${key} isn't in the cached issues.`, true);
  ensureDialog();
  overview.key = key;
  if (list) overview.list = list;
  else if (!overview.list.includes(key)) overview.list = [key];
  syncIssueUrl(key);
  renderOverview();
  if (!dialog.open) { dialog.showModal(); dialog.focus({ preventScroll: true }); }
  dialog.querySelector(".issue-overview-main").scrollTop = 0;
  loadDetail(key);
  if (host?.isConnected && ui.sel !== key && host.querySelector(`[data-issue-row="${CSS.escape(key)}"]`)) select(key, true);
}

// ---------- page ----------

function peoplePopover() {
  const counts = new Map();
  for (const issue of base().filter(open)) counts.set(personKey(issue), (counts.get(personKey(issue)) || 0) + 1);
  const query = ui.peopleQuery.toLowerCase();
  const rows = [...counts].filter(([name]) => (name || "unassigned").toLowerCase().includes(query)).sort((a, b) => b[1] - a[1]);
  return `<label class="code-filter"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.search}</svg><input type="search" data-people-query placeholder="Find a person" value="${escapeHtml(ui.peopleQuery)}" spellcheck="false" autocomplete="off"></label><ul class="code-branch-list">${rows.map(([name, count]) => `<li><button type="button" class="issue-person-row" data-issue-person="${escapeHtml(name)}" aria-pressed="${ui.people.has(name)}">${name ? avatar("", name) : icon("person")}<span>${escapeHtml(name || "Unassigned")}</span><span class="code-count">${count}</span></button></li>`).join("")}</ul>${ui.people.size ? '<div class="code-branch-actions"><button type="button" class="code-bar-button" data-issue-people-clear>Everyone</button></div>' : ""}`;
}

function toolbar() {
  const count = (value) => ` <span class="code-count">${value}</span>`;
  const segment = (attr, current, options) => `<div class="code-segment">${Object.entries(options).map(([id, label]) => `<button type="button" ${attr}="${id}" aria-pressed="${current === id}">${label}</button>`).join("")}</div>`;
  const scoped = base();
  const both = ["jira", "linear"].every((source) => ui.data.sources?.includes(source));
  const groups = both ? migrationGroups() : [];
  const counts = { all: scoped.filter(open).length, triage: scoped.filter(isTriage).length, epics: epicGroups().reduce((sum, [, epics]) => sum + epics.length, 0), activity: "", migration: groups.filter((group) => ["drift", "copies", "title"].includes(group.kind)).length };
  // A tab or scope with nothing in it (Epics for GitHub issues, Mine when everything is mine) stays out unless it is the one open.
  const tabs = `<div class="code-segment code-tabs">${Object.entries(TABS).filter(([id]) => (id !== "migration" || both) && (counts[id] !== 0 || ui.tab === id)).map(([id, label]) => `<button type="button" data-issue-tab="${id}" aria-pressed="${ui.tab === id}">${label}${counts[id] === "" ? "" : count(counts[id])}</button>`).join("")}</div>`;
  const people = `<button type="button" class="code-bar-button issue-people-trigger${ui.people.size ? " is-active" : ""}" popovertarget="issue-people" data-issue-people-trigger>${icon("person")}${ui.people.size === 1 ? escapeHtml([...ui.people][0] || "Unassigned") : ui.people.size ? `${ui.people.size} people` : "Everyone"} <kbd>A</kbd></button>`;
  let controls = "";
  if (ui.tab === "all") {
    const total = scoped.filter(open).length;
    const scopes = Object.entries(SCOPES).map(([id, [label, test]]) => [id, label, scoped.filter(open).filter(test).length]).filter(([id, , value]) => id === "all" || id === ui.scope || (value > 0 && value < total));
    const noun = groupNoun(scoped);
    controls = segment("data-issue-group", ui.group, { repo: `By ${noun}`, recent: "By update" }) + (scopes.length > 1 ? segment("data-issue-scope", ui.scope, Object.fromEntries(scopes.map(([id, label, value]) => [id, `${label}${count(value)}`]))) : "");
  }
  if (ui.tab === "triage") controls = `<label class="code-check"><input type="checkbox" data-issue-hide-seen-box ${ui.hideSeen ? "checked" : ""}> Hide seen <kbd>U</kbd>${count(scoped.filter(isTriage).filter(isSeen).length)}</label>${ui.selected.size ? `<span class="issue-bulk">${ui.selected.size} selected ${skillButtons([...ui.selected])}<button type="button" class="code-bar-button" data-issue-select-none>Clear</button></span>` : '<span class="code-muted">Space selects rows for one draft about several issues.</span>'}`;
  if (ui.tab === "migration") controls = segment("data-issue-migration", ui.migration, Object.fromEntries(Object.entries(MIGRATION).map(([id, label]) => [id, `${label}${count(groups.filter((group) => group.kind === id).length)}`]))) + (ui.selected.size ? `<span class="issue-bulk">${ui.selected.size} selected ${skillButtons([...ui.selected])}<button type="button" class="code-bar-button" data-issue-select-none>Clear</button></span>` : "");
  if (ui.tab === "activity") controls = segment("data-issue-activity", ui.activityScope, ACTIVITY_SCOPES) + `<label class="code-check">Since <input type="date" data-issue-since value="${escapeHtml(ui.since)}"></label>`;
  const sourceCount = (source) => count(ui.data.issues.filter((issue) => issue.inScope && !issue.bot && !issue.mirrorOf && (issue.source || "jira") === source && open(issue)).length);
  const sources = ui.data.sources?.length > 1 && ui.tab !== "migration" ? segment("data-issue-source", ui.source, { all: "All", ...Object.fromEntries(ui.data.sources.map((source) => [source, `${TRACKERS[source]}${sourceCount(source)}`])) }) : "";
  const shared = `${sources}${people}${ui.tab !== "triage" && ui.tab !== "activity" ? `<label class="code-check"><input type="checkbox" data-issue-done ${ui.showDone ? "checked" : ""}> Done</label>` : ""}${(config().issues.hideLabels || []).length || ui.showBots ? `<label class="code-check" data-tip="Issues labeled ${escapeHtml((config().issues.hideLabels || []).join(", "))}"><input type="checkbox" data-issue-bots ${ui.showBots ? "checked" : ""}> Bots${count(ui.data.issues.filter((issue) => issue.inScope && issue.bot && issue.category !== "done").length)}</label>` : ""}`;
  const repos = ui.data.githubRepos || [];
  const reach = repos.length && ui.tab === "all" ? `${new Set(scoped.filter(open).filter((issue) => issue.source === "github").map((issue) => issue.project)).size} of ${repos.length} tracked repos · ` : "";
  const synced = ui.data.syncing ? escapeHtml(ui.data.progress || "Syncing issues…") : `${reach}${ui.data.syncedAt ? `synced ${ago(ui.data.syncedAt)} ago` : "never synced"}`;
  return `<div class="code-toolbar"><div class="code-toolbar-rows"><div class="code-toolbar-row">${tabs}<label class="code-filter"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.search}</svg><input type="search" data-issue-filter placeholder="Filter  (F)" value="${escapeHtml(ui.filter)}" spellcheck="false"></label><span class="code-spacer"></span><span class="code-muted issue-synced">${synced}</span>${iconButton("refresh", ui.data.syncing ? "Syncing issues…" : "Re-read every issue  (R)", `data-issue-refresh class="code-icon-button${ui.data.syncing ? " is-spinning" : ""}"`)}</div><div class="code-controls">${controls}${shared}</div></div></div>`;
}

const lastHtml = new WeakMap();
function patch(region, html) {
  const element = host.querySelector(`[data-region="${region}"]`);
  if (lastHtml.get(element) === html) return null;
  lastHtml.set(element, html);
  element.innerHTML = html;
  return element;
}

function render({ animate = false } = {}) {
  if (!host?.isConnected || !ui.data?.enabled || !host.querySelector(".issue-surface, .issue-loading")) return;
  if (!host.querySelector(".issue-surface")) {
    host.innerHTML = `<section class="issue-surface" aria-label="Issues"><div data-region="toolbar"></div><div data-region="errors"></div><div class="code-split"><div class="code-list" data-region="list"></div><aside class="code-detail" data-region="detail" aria-live="polite"></aside></div><div id="issue-people" class="code-settings code-branch-pop issue-people-pop" popover aria-label="Filter by person" data-region="people"></div></section>`;
    animate = true;
    new ResizeObserver(([entry]) => host.style.setProperty("--code-bar-h", `${Math.ceil(entry.borderBoxSize[0].blockSize)}px`)).observe(host.querySelector('[data-region="toolbar"]'));
  }
  const filter = host.querySelector("[data-issue-filter]");
  const focused = document.activeElement === filter;
  const caret = filter?.selectionStart;
  hideTip();
  patch("toolbar", toolbar());
  patch("errors", ui.data.error ? `<p class="work-warning">Issue sync failed: ${escapeHtml(ui.data.error)}</p>` : "");
  const body = ui.tab === "triage" ? triageBody() : ui.tab === "epics" ? epicsBody() : ui.tab === "activity" ? activityBody() : ui.tab === "migration" ? migrationBody() : allBody();
  const list = patch("list", body);
  if (list && animate) fadeIn(list);
  if (!host.querySelector("#issue-people:popover-open")) patch("people", peoplePopover());
  renderDetail();
  if (focused) {
    const next = host.querySelector("[data-issue-filter]");
    if (next !== document.activeElement) { next.focus(); next.setSelectionRange(caret, caret); }
  }
}

async function load(refresh = false) {
  window.clearTimeout(ui.poll);
  const response = await fetch(refresh ? "/api/issues?refresh" : "/api/issues");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load issues.");
  ui.data = data;
  ui.byKey = null;
  if (refresh) ui.detail.clear();
  for (const key of ui.selected) if (!byKey().has(key)) ui.selected.delete(key);
  if (host?.isConnected) {
    if (!data.enabled) host.innerHTML = `<section class="issue-loading"><p>No issue source configured. Set <code>issues.jql</code>, <code>issues.linear.teams</code> or <code>issues.github</code> in <code>viewer.config.json</code> to list issues here.</p></section>`;
    render();
    host.dataset.issuesState = data.syncing ? "syncing" : "ready"; // agents wait on [data-issues-state="ready"]
    if (data.syncing) ui.poll = window.setTimeout(() => load().catch((error) => notify(error.message, true)), 2500);
  }
  if (dialog?.open) renderOverview();
  return data;
}
export const loadIssues = () => (ui.data ? Promise.resolve(ui.data) : load());
export const cachedIssues = () => ui.data;

function syncUrl() {
  const url = new URL(location.href);
  const issue = url.searchParams.get("issue");
  url.search = new URLSearchParams({ view: "issues", ...(ui.tab === "all" ? {} : { tab: ui.tab }), ...(ui.source === "all" ? {} : { source: ui.source }), ...(ui.tab === "all" && ui.group !== "repo" ? { group: ui.group } : {}), ...(ui.since ? { since: ui.since } : {}), ...(issue ? { issue } : {}) });
  history.replaceState(null, "", url);
}

function resetFilters() {
  Object.assign(ui, { filter: "", scope: "all", activityScope: "all", since: "" });
  ui.people.clear();
  syncUrl();
}

function select(key, scroll = false) {
  ui.sel = key;
  for (const row of host.querySelectorAll("[data-issue-row]")) row.setAttribute("aria-selected", String(row.dataset.issueRow === key));
  if (scroll) host.querySelector(`[data-issue-row="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
  renderDetail({ animate: !scroll });
}
const rowKeys = () => [...new Set([...host.querySelectorAll(".code-list [data-issue-row]")].map((row) => row.dataset.issueRow))];
function move(step) {
  const keys = rowKeys();
  if (!keys.length) return;
  const index = keys.indexOf(ui.sel);
  select(keys[Math.max(0, Math.min(keys.length - 1, index < 0 ? 0 : index + step))], true);
}

async function draft(skill, keys) {
  const response = await fetch("/api/issues/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: agentApp(), skill, keys }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not open the draft.");
  const label = ui.data.skills.find((candidate) => candidate.id === skill)?.label || skill;
  notify(`Drafted ${label} for ${keys.length === 1 ? keys[0] : `${keys.length} issues`} in ${appName()}. Review it and press Enter to send.`);
}

async function handleClick(event) {
  const target = event.target.closest("button, input, a");
  const row = event.target.closest("[data-issue-row]");
  const opener = event.target.closest("tr[data-issue-open]");
  if (!target && opener) return openIssue(opener.dataset.issueOpen, opener.dataset.issueList.split(","));
  if (!target) { if (row && host?.contains(row)) select(row.dataset.issueRow); return; }
  if (target.matches("a[data-planning-path]") && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    event.stopPropagation();
    dialog?.close();
    return planning.open(target.dataset.planningPath);
  }
  if (target.matches("a")) return;
  const { dataset } = target;
  try {
    if (dataset.issueTab) { ui.tab = issueTab(dataset.issueTab); syncUrl(); return render({ animate: true }); }
    if (dataset.issueScope) { ui.scope = dataset.issueScope; return render({ animate: true }); }
    if (dataset.issueGroup) { ui.group = dataset.issueGroup; storage.set("issues-group", ui.group); syncUrl(); return render({ animate: true }); }
    if (dataset.issueCollapse !== undefined) {
      ui.collapsed.has(dataset.issueCollapse) ? ui.collapsed.delete(dataset.issueCollapse) : ui.collapsed.add(dataset.issueCollapse);
      storage.set("issues-collapsed", [...ui.collapsed].join("\n"));
      return render();
    }
    if (dataset.issueSource) { ui.source = dataset.issueSource; storage.set("issues-source", ui.source); syncUrl(); return render({ animate: true }); }
    if (dataset.issueMigration) { ui.migration = dataset.issueMigration; return render({ animate: true }); }
    if (dataset.issueActivity) { ui.activityScope = dataset.issueActivity; return render({ animate: true }); }
    if ("issueDone" in dataset) { ui.showDone = target.checked; return render({ animate: true }); }
    if ("issueBots" in dataset) { ui.showBots = target.checked; return render({ animate: true }); }
    if ("issueHideSeenBox" in dataset || "issueHideSeen" in dataset) { ui.hideSeen = "issueHideSeenBox" in dataset ? target.checked : !ui.hideSeen; storage.set("issues-hide-seen", ui.hideSeen ? "on" : "off"); return render({ animate: true }); }
    if ("issueRefresh" in dataset) { target.classList.add("is-spinning"); return load(true); }
    if ("issueReset" in dataset) { resetFilters(); return render({ animate: true }); }
    if (dataset.issuePerson !== undefined) { ui.people.has(dataset.issuePerson) ? ui.people.delete(dataset.issuePerson) : ui.people.add(dataset.issuePerson); render({ animate: true }); return patch("people", peoplePopover()); }
    if ("issuePeopleClear" in dataset) { ui.people.clear(); render({ animate: true }); return patch("people", peoplePopover()); }
    if (dataset.issueSelect) { target.checked ? ui.selected.add(dataset.issueSelect) : ui.selected.delete(dataset.issueSelect); return render(); }
    if ("issueSelectAll" in dataset) { for (const key of rowKeys()) target.checked ? ui.selected.add(key) : ui.selected.delete(key); return render(); }
    if ("issueSelectNone" in dataset) { ui.selected.clear(); return render(); }
    if (dataset.issueExpand) { ui.expanded.has(dataset.issueExpand) ? ui.expanded.delete(dataset.issueExpand) : ui.expanded.add(dataset.issueExpand); return render(); }
    if (dataset.issueOpen) return openIssue(dataset.issueOpen, rowKeys().includes(dataset.issueOpen) ? rowKeys() : null);
    if (dataset.issueCopy) { await navigator.clipboard.writeText(dataset.issueCopy); return copied(target); }
    if (dataset.issueSkill) return draft(dataset.issueSkill, dataset.keys.split(","));
    if (dataset.issuePr) { const [slug, number] = dataset.issuePr.split("#"); return openPrOverlay(slug, Number(number)); }
    if (dataset.issueWt) return openWorktreeOverlay(dataset.issueWt);
  } catch (error) {
    notify(error.message, true);
  }
}

function handleKey(event) {
  if (!host?.querySelector(".issue-surface") || !host.isConnected || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
  if (document.querySelector("dialog[open]")) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable]")) {
    const filter = event.target.matches?.("[data-issue-filter]");
    if (filter && event.key === "Escape") { ui.filter = ""; event.target.value = ""; event.target.blur(); render(); event.preventDefault(); }
    if (filter && event.key === "ArrowDown") { event.target.blur(); move(1); event.preventDefault(); }
    if (event.target.matches?.("[data-people-query]") && event.key === "Enter") { host.querySelector("[data-issue-person]")?.click(); event.preventDefault(); }
    return;
  }
  if (document.querySelector(":popover-open:not(.code-tip)")) return; // the tooltip stays a popover while hidden
  const key = event.key.toLowerCase();
  const issue = byKey().get(ui.sel);
  const keys = issue && ui.selected.has(issue.key) ? [...ui.selected] : issue ? [issue.key] : [...ui.selected];
  const skill = (index) => ui.data.skills[index] && keys.length && draft(ui.data.skills[index].id, keys);
  const actions = {
    arrowdown: () => move(1), j: () => move(1), arrowup: () => move(-1), k: () => move(-1),
    f: () => host.querySelector("[data-issue-filter]")?.focus(),
    r: () => { host.querySelector("[data-issue-refresh]")?.classList.add("is-spinning"); return load(true); },
    a: () => host.querySelector("#issue-people")?.showPopover(),
    u: () => { if (ui.tab !== "triage") return; ui.hideSeen = !ui.hideSeen; storage.set("issues-hide-seen", ui.hideSeen ? "on" : "off"); render({ animate: true }); },
    escape: () => { if (!host.querySelector("[data-issue-reset]") && !ui.selected.size) return; ui.selected.clear(); resetFilters(); render({ animate: true }); },
    enter: () => issue && openIssue(issue.key, rowKeys()),
    " ": () => { if (!issue || !["triage", "migration"].includes(ui.tab)) return; ui.selected.has(issue.key) ? ui.selected.delete(issue.key) : ui.selected.add(issue.key); render(); },
    x: () => { if (!issue) return; toggleSeen(issue); render(); if (ui.tab === "triage") move(ui.hideSeen ? 0 : 1); },
    o: () => issue && window.open(issueUrl(issue.key), "_blank", "noreferrer"),
    y: () => issue && navigator.clipboard.writeText(issueUrl(issue.key)).then(() => notify(`Copied ${issueUrl(issue.key)}`)),
    arrowright: () => { if (issue?.level >= 1 && ui.tab === "epics") { ui.expanded.add(issue.key); render(); } },
    arrowleft: () => { if (ui.tab !== "epics" || !issue) return; const epic = issue.level >= 1 ? issue.key : issue.parent; ui.expanded.delete(epic); render(); select(epic, true); },
  };
  for (let index = 1; index <= 9; index++) actions[String(index)] = () => skill(index - 1);
  if (!actions[key]) return;
  event.preventDefault();
  event.stopPropagation(); // A is the global Tasks shortcut elsewhere; here it picks people
  Promise.resolve(actions[key]()).catch((error) => notify(error.message, true));
}

export function renderIssuesPage(container, { tab, showNotice }) {
  notify = showNotice;
  ui.tab = issueTab(tab);
  ui.since = new URLSearchParams(location.search).get("since") || "";
  const source = new URLSearchParams(location.search).get("source");
  if (["all", "jira", "linear", "github"].includes(source)) ui.source = source;
  const group = new URLSearchParams(location.search).get("group");
  if (group === "recent" || group === "repo") ui.group = group;
  if (host !== container) {
    host = container;
    container.addEventListener("click", (event) => { if (container.querySelector(".issue-surface")) handleClick(event); });
    container.addEventListener("dblclick", (event) => {
      const row = event.target.closest("[data-issue-row]");
      if (!row || !container.querySelector(".issue-surface") || event.target.closest("button, a, input, label")) return;
      window.getSelection()?.removeAllRanges();
      openIssue(row.dataset.issueRow, rowKeys());
    });
    container.addEventListener("input", (event) => {
      if (event.target.matches("[data-issue-filter]")) { ui.filter = event.target.value; render(); }
      else if (event.target.matches("[data-people-query]")) { ui.peopleQuery = event.target.value; const input = event.target; patch("people", peoplePopover()); const next = host.querySelector("[data-people-query]"); next.focus(); next.setSelectionRange(input.value.length, input.value.length); }
      else if (event.target.matches("[data-issue-since]")) { ui.since = event.target.value; syncUrl(); render({ animate: true }); }
    });
    container.addEventListener("toggle", (event) => {
      if (event.target.id !== "issue-people" || event.newState !== "open") return;
      const anchor = container.querySelector("[data-issue-people-trigger]").getBoundingClientRect();
      event.target.style.top = `${anchor.bottom + 6}px`;
      event.target.style.left = `${Math.max(8, Math.min(innerWidth - event.target.offsetWidth - 8, anchor.left))}px`;
      event.target.querySelector("input")?.focus();
    }, true);
    window.addEventListener("keydown", handleKey, true);
    container.addEventListener("pointerover", (event) => {
      if (!container.querySelector(".issue-surface")) return;
      const target = event.target.closest("[data-tip]");
      if (target && !target.closest("a[href]:not(.code-icon-button)")) showTip(target); else hideTip();
    });
    container.addEventListener("pointerleave", hideTip);
  }
  container.dataset.issuesState = "loading";
  container.innerHTML = `<section class="issue-loading"><p>Loading issues…</p></section>`;
  if (ui.data) render();
  load().catch((error) => notify(error.message, true));
}
