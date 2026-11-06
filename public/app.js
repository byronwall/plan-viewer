import { contextScore, fuzzyChunks, searchDocuments, searchPrs, termMatch, textScore } from "./search.js";
import { isSettled, renderActions, renderWorkBreakdown, showDoneToggle, workStatusIcon, workStatusLabel } from "./actions.js";
import { applyLinkMetadata, collectLinks, metadataKey, renderDock, selectDocumentSort, selectDockSource, taskDocumentSequence } from "./dock.js";
import { GLYPHS } from "./icons.js";
import { enhanceTable } from "./table-viewer.js";
import { delimitedTable, diagramHref, documentHref, escapeHtml, inlineMarkdown, isSlackLink, markdownOutline, relativeDate, renderChatLinks, renderMarkdown as renderMarkdownSource, renderUpdates, SERVICE_ICONS } from "./markdown.js";
import { TABS as CODE_TABS, connectPlanning, setPeople, ago, copyPrompt, cachedPrIndex, commitLinkMatch, diffSize, hideTip, icon, modKey, installCommitCards, loadPrIndex, openCommit, openPrOverlay, openWorktreeOverlay, openServers, isSummonKey, prefetchPr, renderCodePage } from "./code.js";
import { TABS as ISSUE_TABS, cachedIssues, isMyIssue, loadIssues, openIssue, renderIssuesPage } from "./issues.js";
import { renderActivityPage } from "./activity.js";
import { openSlackThread, refreshSlackStars, setSlackFavorites, setSlackNotice, slackThreadTitle } from "./slack.js";
import { channelLabel, fresh as freshThread, lastActive, opener, permalink, refreshSlackPage, renderSlackPage } from "./slack-page.js";
import { announceClosed, createOverlay, setOverlayParams } from "./overlay.js";
import { comparePanels, inlineSvg, isDiffDiagram, sourceHtml } from "./diagram.js";
import { diagramsPageHtml, filterDiagrams } from "./diagrams-page.js";
import { cachedPlans, loadPlans, openPlan, planTitle, searchPlans, setPlanNotice } from "./plans.js";
import { AGENTS, agentApp, agentName, config, issuesOn, referenceConfig, setConfig, setAgentApp } from "./config.js";
import { addDays, dateKey, localTodayKey, parseDateKey, startOfWeek } from "./dates.js";

const state = { documents: [], defaultPath: "", selectedPath: "", document: null, activeChunkId: "", openComposer: null, view: "document" };

const elements = {
  library: document.querySelector(".library"),
  documents: document.querySelector("#documents"),
  searchButton: document.querySelector("#open-search"),
  searchDialog: document.querySelector("#search-dialog"),
  searchInput: document.querySelector("#document-search"),
  searchResults: document.querySelector("#search-results"),
  searchStatus: document.querySelector("#search-status"),
  shortcutsDialog: document.querySelector("#shortcuts-dialog"),
  tableViewer: document.querySelector("#table-viewer"),
  tasksButton: document.querySelector("#open-tasks"),
  topicsButton: document.querySelector("#open-topics"),
  referenceButton: document.querySelector("#open-reference"),
  diagramsButton: document.querySelector("#open-diagrams"),
  activityButton: document.querySelector("#open-activity"),
  codeButton: document.querySelector("#open-code"),
  issuesButton: document.querySelector("#open-issues"),
  slackButton: document.querySelector("#open-slack"),
  globalHandoff: document.querySelector("#global-handoff"),
  agentPicker: document.querySelector("#agent-picker"),
  get documentHandoff() { return document.querySelector("[data-dock-draft]"); },
  title: document.querySelector("#document-title"),
  meta: document.querySelector("#document-meta"),
  taskDocumentPath: document.querySelector("#task-document-path"),
  taskPathValue: document.querySelector("#task-path-value"),
  taskPathStatus: document.querySelector("#task-path-status"),
  copyTaskPath: document.querySelector("#copy-task-path"),
  count: document.querySelector("#chunk-count"),
  chunkNav: document.querySelector("#chunk-nav"),
  chunks: document.querySelector("#chunks"),
  toaster: document.querySelector("#toaster"),
  handoffPopover: document.querySelector("#handoff-popover"),
  imageViewer: document.querySelector("#image-viewer"),
};

let handoffTrigger = null;
let imageViewerResizeObserver = null;
let navigationScrollLock = null;
let navigationScrollTimer = 0;
const chunkOutlines = new Map();
const actionGroups = new Map();
// A per-browser on/off preference; private windows and blocked storage fall back to the default.
function storedFlag(key, fallback) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value === "1"; } catch { return fallback; }
}
function storeFlag(key, value) {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch {}
}
// How a diff diagram's two panels sit: "right" (side by side), "down" (stacked), or "" for what the file says.
function storedPanels() {
  try { const value = localStorage.getItem("plan-viewer:diagram-panels"); return value === "right" || value === "down" ? value : ""; } catch { return ""; }
}
const imageViewerState = { showSource: storedFlag("plan-viewer:diagram-source", true), panels: storedPanels(), items: [], index: 0, scale: 1, fitScale: 1, isFitView: true, offset: { x: 0, y: 0 }, pan: null, trigger: null };

// Sonner-style toasts: stacked bottom-right above the history button, newest in front. Hovering fans the stack out
// and pauses every timer; a fourth toast pushes the oldest out.
const TOAST_GLYPHS = { success: GLYPHS["circle-check"], error: GLYPHS["circle-alert"], info: GLYPHS.info };
const toasts = [];
function showNotice(message, error = false, { description = "", action = null, kind = error ? "error" : "success" } = {}) {
  const element = document.createElement("li");
  element.className = `toast toast-${kind}`;
  element.setAttribute("role", error ? "alert" : "status");
  element.innerHTML = `<svg class="toast-icon" viewBox="0 0 24 24" aria-hidden="true">${TOAST_GLYPHS[kind]}</svg><div class="toast-text"><p class="toast-title"></p>${description ? '<p class="toast-description"></p>' : ""}</div>${action ? '<button type="button" class="toast-action"></button>' : ""}<button type="button" class="toast-close" aria-label="Dismiss"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.x}</svg></button>`;
  element.querySelector(".toast-title").textContent = message;
  if (description) element.querySelector(".toast-description").textContent = description;
  const entry = { element, remaining: error ? 9000 : 6000, timer: 0, started: 0, height: 0 };
  element.querySelector(".toast-close").addEventListener("click", () => dismissToast(entry));
  if (action) Object.assign(element.querySelector(".toast-action"), { textContent: action.label, onclick: () => { dismissToast(entry); action.run(); } });
  elements.toaster.prepend(element);
  entry.height = element.offsetHeight;
  toasts.unshift(entry);
  toasts.slice(3).forEach(dismissToast);
  layoutToasts();
  if (!elements.toaster.matches(":hover, :focus-within")) startToast(entry);
  return entry;
}
setPlanNotice(showNotice);
setSlackNotice(showNotice);
setSlackFavorites({ toggle: (href) => toggleFavorite(href), has: (href) => isFavorite(href) });
function startToast(entry) {
  entry.started = Date.now();
  entry.timer = window.setTimeout(() => dismissToast(entry), entry.remaining);
}
function dismissToast(entry) {
  const index = toasts.indexOf(entry);
  if (index < 0) return;
  toasts.splice(index, 1);
  window.clearTimeout(entry.timer);
  entry.element.dataset.removed = "";
  window.setTimeout(() => entry.element.remove(), 240);
  layoutToasts();
}
function layoutToasts() {
  let offset = 0;
  toasts.forEach((entry, index) => {
    entry.element.style.cssText = `--index: ${index}; --offset: ${offset}px; --height: ${entry.height}px`;
    offset += entry.height + 8;
  });
  elements.toaster.style.setProperty("--front-height", `${toasts[0]?.height || 0}px`);
}
elements.toaster.addEventListener("mouseenter", () => toasts.forEach((entry) => { window.clearTimeout(entry.timer); entry.remaining -= Date.now() - entry.started; }));
elements.toaster.addEventListener("mouseleave", () => toasts.forEach(startToast));

function formatDate(date, includeYear = false) {
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  }).format(new Date(`${date}T12:00:00`));
}

function dailyDocumentLabel(doc) {
  if (doc.kind === "Plan") return doc.kind;
  if (/^Reference\s+[—-]/i.test(doc.title)) return "Reference";
  return doc.title;
}

function resetPageNavigation() {
  elements.taskDocumentPath.hidden = true;
  elements.taskPathValue.textContent = "";
  delete elements.copyTaskPath.dataset.copyPath;
  elements.taskPathStatus.textContent = "";
  elements.copyTaskPath.classList.remove("is-copied", "copy-error");
  elements.copyTaskPath.title = "Click to copy path";
  elements.tasksButton.setAttribute("aria-current", "false");
  elements.topicsButton.setAttribute("aria-current", "false");
  elements.referenceButton.setAttribute("aria-current", "false");
  elements.diagramsButton.setAttribute("aria-current", "false");
  elements.codeButton.setAttribute("aria-current", "false");
  elements.issuesButton.setAttribute("aria-current", "false");
  elements.slackButton.setAttribute("aria-current", "false");
  elements.activityButton.setAttribute("aria-current", "false");
  elements.chunks.classList.remove("tasks-page", "library-page", "diagrams-page", "code-page", "issues-page", "slack-page", "activity-page");
}

function documentButton(doc, dailyChild = false) {
  const label = dailyChild ? dailyDocumentLabel(doc) : doc.title;
  return `<button class="document-link" data-path="${escapeHtml(doc.path)}" aria-current="${doc.path === state.selectedPath ? "page" : "false"}">
    <strong title="${escapeHtml(doc.title)}">${escapeHtml(label)}</strong>
  </button>`;
}

function renderLibrary() {
  const visible = state.documents;
  const today = visible.filter((doc) => doc.group === "Today");
  const daily = visible.filter((doc) => doc.group === "Daily");
  const dates = [...new Set(daily.map((doc) => doc.date))];
  const sections = [];

  // One row per day that says what the day was about: its plan's first scheduled task (or work heading), with a count
  // of the rest. The hover card lists them all with the day's other files; the row opens the plan.
  const dayRow = (date, docs, isToday = false) => {
    const day = new Date(`${date}T12:00:00`);
    const plan = docs.find((doc) => doc.kind === "Plan");
    const target = plan || docs[0];
    const focus = dayFocus(plan);
    const lead = focus[0] || (plan ? "" : target.title.replace(/^Reference\s+[—-]\s*/i, ""));
    const current = docs.some((doc) => doc.path === state.selectedPath);
    return `<button class="day-row${isToday ? " is-today" : ""}${lead ? "" : " is-bare"}" type="button" data-path="${escapeHtml(target.path)}" data-day="${date}" aria-current="${current ? "page" : "false"}">
      <time datetime="${date}"><span>${day.toLocaleDateString("en-US", { weekday: "short" })}</span>${day.getDate()}</time>
      <span class="day-focus">${escapeHtml(lead || "Plan")}</span>${focus.length > 1 ? `<span class="day-more">+${focus.length - 1}</span>` : ""}
    </button>`;
  };
  if (today.length) sections.push(`<section class="document-group"><h2 class="group-label">Today</h2>${dayRow(today[0].date, today, true)}</section>`);
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  for (const month of months) {
    const label = new Date(`${month}-01T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    // A hairline marks each week boundary within a month; skipped weeks still get just one.
    const weekOf = (date) => dateKey(startOfWeek(parseDateKey(date)));
    const rows = dates.filter((date) => date.startsWith(month)).map((date, index, monthDates) =>
      `${index && weekOf(date) !== weekOf(monthDates[index - 1]) ? '<hr class="week-break">' : ""}${dayRow(date, daily.filter((doc) => doc.date === date))}`);
    sections.push(`<section class="document-group"><h2 class="group-label">${label}</h2>${rows.join("")}</section>`);
  }
  hideLinkTip();
  elements.documents.innerHTML = sections.join("") || `<p class="empty-library">No planning documents found.</p>`;
  if (elements.searchDialog.open) renderSearchResults();
}

// What a plan's rail row leads with: per scheduled task, the plan's note for that day (tasks carry over, notes don't),
// else the task's title; plans without tasks give their work headings.
function dayFocus(plan) {
  const tasks = plan?.focus?.tasks || [];
  return tasks.length ? tasks.map(({ id, note }) => note.replace(/\.$/, "") || state.documents.find((doc) => doc.task?.id === id)?.task.title || id) : plan?.focus?.headings || [];
}

function dayTipHtml(date) {
  const docs = state.documents.filter((doc) => doc.date === date);
  const plan = docs.find((doc) => doc.kind === "Plan");
  const tasks = (plan?.focus?.tasks || []).map(({ id, note }) => {
    const doc = state.documents.find((candidate) => candidate.task?.id === id);
    return tipRow(TASK_STATUS_LABELS[doc?.task.status] || "Missing", doc?.task.title || id, note, doc?.task.status || "missing", doc ? `doc:${doc.path}` : "");
  });
  const headings = tasks.length ? [] : (plan?.focus?.headings || []).map((heading, index) => tipRow(`${index + 1}.`, heading, "", "", `doc:${plan.path}`));
  const files = docs.filter((doc) => doc !== plan).map((doc) => tipRow("File", doc.title, doc.path.split("/").pop(), "", `doc:${doc.path}`));
  return tipHead(formatDate(date, true), tasks.length ? plural(tasks.length, "scheduled task") : headings.length ? plural(headings.length, "section") : "")
    + (tasks.join("") + headings.join("") || (plan ? tipEmpty("No scheduled tasks.") : ""))
    + files.join("")
    + `<div class="hover-card-hint">${plan ? `<button type="button" data-open="doc:${escapeHtml(plan.path)}">Peek at the plan</button> · ` : ""}<kbd>[</kbd> <kbd>]</kbd> step days</div>`;
}

const TASK_STATUS_LABELS = { open: "Open", active: "Active", waiting: "Waiting", deferred: "Deferred", completed: "Completed" };
// Waiting tasks sit below open work until they need a look: their check-in date arrives, or something their Next
// actions name moves (/api/waiting: a PR merges, a tracker issue changes). Then they lead the list as "Check in".
const TASK_STATUS_ORDER = { active: 0, open: 1, waiting: 2, deferred: 3, completed: 4 };
let waitingSignals = {};
const movedItems = (path) => (waitingSignals[path] || []).filter((item) => item.moved);
const itemLabel = (item) => metadataLabel(item.key);
const metadataLabel = (key) => key.replace(/^github:[^/]+\/([^#]+)#/, "$1#").replace(/^(jira|linear):/, "");
function checkInReason(task, path) {
  if (task.status !== "waiting") return "";
  const moved = movedItems(path);
  if (moved.length) return moved.map((item) => `${itemLabel(item)} ${item.tone === "done" || item.tone === "closed" ? item.state.toLowerCase() : "changed"} ${shortDate(item.when.slice(0, 10))}`).join(" · ");
  return task.checkIn && task.checkIn <= localTodayKey() ? `Check-in date ${shortDate(task.checkIn)}` : "";
}
const statusRank = (doc) => checkInReason(doc.task, doc.path) ? -1 : TASK_STATUS_ORDER[doc.task.status];
const shortDate = (date) => new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function statusPill(task, path) {
  const reason = checkInReason(task, path);
  const waiting = task.status === "waiting" && task.checkIn;
  const label = reason ? "Check in" : waiting ? `Waiting · ${shortDate(task.checkIn)}` : TASK_STATUS_LABELS[task.status];
  const title = reason ? `${reason} · change status` : waiting ? `Check in ${formatDate(task.checkIn, true)}${task.checkInDerived ? " (a week after its last update)" : ""} · change status` : "Change status";
  return `<button type="button" class="task-status task-status-${task.status}${reason ? " task-status-due" : ""}" data-status-path="${escapeHtml(path)}" data-status="${task.status}" aria-haspopup="menu" title="${escapeHtml(title)}">${label}</button>`;
}

// The rail's page links each carry the one number worth knowing, amber when it needs you (a due check-in, a review
// request, new Slack replies), and a hover card listing what sits behind it. Each reads data the viewer already loaded.
let slackThreads = null;
// A card row; with `open` ("doc:path", "pr:slug#n", "issue:KEY", "slack:url") it is a button that opens that item's overlay.
const tipRow = (label, title, detail = "", tone = "", open = "") => {
  const body = `<span class="tip-label"${tone ? ` data-tone="${tone}"` : ""}>${escapeHtml(label)}</span><span><strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</span>`;
  return open ? `<button type="button" class="tip-row" data-open="${escapeHtml(open)}">${body}</button>` : `<div class="tip-row">${body}</div>`;
};
const tipHead = (name, state = "") => `<div class="hover-card-head"><span class="hover-card-name">${escapeHtml(name)}</span>${state ? `<span class="hover-card-state is-quiet">${escapeHtml(state)}</span>` : ""}</div>`;
const tipEmpty = (text) => `<div class="hover-card-line tip-empty">${escapeHtml(text)}</div>`;
const recentDocs = (docs, count = 6) => docs.filter((doc) => doc.modified).sort((a, b) => b.modified - a.modified).slice(0, count);
const docRows = (docs) => recentDocs(docs).map((doc) => tipRow(ago(doc.modified), doc.title, doc.path, "", `doc:${doc.path}`)).join("") || tipEmpty("Nothing here yet.");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function navSummary(view) {
  const docs = state.documents;
  if (view === "activity") {
    const midnight = new Date().setHours(0, 0, 0, 0);
    const today = docs.filter((doc) => doc.modified >= midnight).length;
    return { count: today ? `${today} today` : "", card: tipHead("Recently changed", today ? `${plural(today, "document")} today` : "") + docRows(docs) };
  }
  if (view === "tasks") {
    const tasks = docs.filter((doc) => doc.task);
    const due = tasks.filter((doc) => checkInReason(doc.task, doc.path));
    const by = (status) => tasks.filter((doc) => doc.task.status === status && !due.includes(doc));
    const live = [...by("active"), ...by("open")];
    const rows = [...due.map((doc) => tipRow("Check in", doc.task.title, checkInReason(doc.task, doc.path), "attention", `doc:${doc.path}`)),
      ...live.sort((a, b) => b.task.updated.localeCompare(a.task.updated)).map((doc) => tipRow(TASK_STATUS_LABELS[doc.task.status], doc.task.title, `${doc.task.id} · ${doc.task.project}`, doc.task.status, `doc:${doc.path}`))];
    const counts = [["active", by("active").length], ["open", by("open").length], ["waiting", by("waiting").length]].filter(([, count]) => count).map(([status, count]) => `${count} ${status}`).join(" · ");
    return { count: due.length ? plural(due.length, "check-in") : live.length ? `${live.length} open` : "", attention: due.length > 0, card: tipHead("Tasks", counts) + (rows.slice(0, 8).join("") || tipEmpty("No open tasks.")) + (rows.length > 8 ? tipEmpty(`+${rows.length - 8} more on the Tasks page`) : "") };
  }
  if (view === "diagrams") {
    const diagrams = state.diagrams || [];
    return { count: diagrams.length ? String(diagrams.length) : "", card: tipHead("Diagrams", diagrams.length ? `${plural(diagrams.length, "diagram")} · newest first` : "")
      + (diagrams.slice(0, 6).map((diagram) => tipRow(ago(diagram.modified), diagram.title, diagram.task || diagram.path, "", `diagram:${diagram.path}`)).join("") || tipEmpty(state.diagrams ? "No diagrams yet." : "Loading diagrams…")) };
  }
  if (view in LIBRARY_VIEWS) {
    const group = docs.filter((doc) => doc.group === LIBRARY_VIEWS[view].group);
    return { count: group.length ? String(group.length) : "", card: tipHead(LIBRARY_VIEWS[view].title, group.length ? `${plural(group.length, "document")} · newest first` : "") + docRows(group) };
  }
  if (view === "code") {
    const index = cachedPrIndex();
    if (!index) return { count: "", card: tipHead("Pull requests") + tipEmpty("Loading pull requests…") };
    const open = index.prs.filter((pr) => pr.state === "OPEN").sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const review = open.filter((pr) => pr.requestedOfMe);
    const mine = open.filter((pr) => pr.author === index.me && !pr.requestedOfMe);
    const rows = [...review.map((pr) => tipRow("Review", pr.title, `${pr.slug.split("/").pop()}#${pr.number}`, "attention", `pr:${pr.slug}#${pr.number}`)),
      ...mine.map((pr) => tipRow(pr.draft ? "Draft" : pr.reviewDecision === "APPROVED" ? "Approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "Changes" : "Yours", pr.title, `${pr.slug.split("/").pop()}#${pr.number}`, pr.reviewDecision === "APPROVED" ? "completed" : "", `pr:${pr.slug}#${pr.number}`))];
    return { count: review.length ? `${review.length} to review` : mine.length ? `${mine.length} yours` : "", attention: review.length > 0, card: tipHead("Pull requests", [review.length && `${review.length} to review`, mine.length && `${mine.length} yours`].filter(Boolean).join(" · ")) + (rows.slice(0, 8).join("") || tipEmpty(index.prs.length ? "Nothing waiting on you." : "No tracked repositories yet.")) };
  }
  if (view === "issues") {
    const data = cachedIssues();
    if (!data?.issues) return { count: "", card: tipHead("Issues") + tipEmpty("Loading issues…") };
    const mine = data.issues.filter((issue) => issue.category !== "done" && isMyIssue(issue)).sort((a, b) => (a.category === "indeterminate" ? 0 : 1) - (b.category === "indeterminate" ? 0 : 1) || String(b.updated).localeCompare(String(a.updated)));
    const moving = mine.filter((issue) => issue.category === "indeterminate").length;
    return { count: moving ? `${moving} in progress` : mine.length ? `${mine.length} yours` : "", card: tipHead("Your issues", [moving && `${moving} in progress`, mine.length - moving && `${mine.length - moving} to do`].filter(Boolean).join(" · ")) + (mine.slice(0, 8).map((issue) => tipRow(issue.status, issue.summary, issue.key, issue.category === "indeterminate" ? "active" : "", `issue:${issue.key}`)).join("") || tipEmpty("Nothing assigned to you.")) };
  }
  if (view === "slack") {
    if (!slackThreads) return { count: "", card: tipHead("Slack") + tipEmpty("Loading threads…") };
    const threads = [...slackThreads].sort((a, b) => (freshThread(b) - freshThread(a)) || lastActive(b) - lastActive(a));
    const unread = threads.filter(freshThread).length;
    return { count: unread ? `${unread} new` : "", attention: unread > 0, card: tipHead("Linked threads", unread ? `${unread} with new replies` : plural(threads.length, "thread")) + (threads.slice(0, 7).map((entry) => tipRow(freshThread(entry) ? "New" : ago(lastActive(entry)), opener(entry) || "Thread", channelLabel(entry), freshThread(entry) ? "attention" : "", `slack:${permalink(entry)}`)).join("") || tipEmpty("No linked threads yet.")) };
  }
  return { count: "", card: "" };
}

function updateNavCounts() {
  for (const button of document.querySelectorAll(".view-navigation-link[data-view]")) {
    const { count, attention } = navSummary(button.dataset.view);
    let badge = button.querySelector(".view-navigation-count");
    if (!badge) badge = button.appendChild(Object.assign(document.createElement("span"), { className: "view-navigation-count" }));
    badge.textContent = count;
    badge.classList.toggle("is-attention", Boolean(attention));
  }
}

async function loadWaiting() {
  try {
    const response = await fetch("/api/waiting");
    if (!response.ok) return;
    const { waiting } = await response.json();
    const changed = JSON.stringify(waiting) !== JSON.stringify(waitingSignals);
    waitingSignals = waiting;
    updateNavCounts();
    if (changed && state.view === "tasks") renderTasksPage();
  } catch {}
}
setInterval(loadWaiting, 10 * 60 * 1000);

const TASK_SORTS = {
  id: (a, b) => a.task.id.localeCompare(b.task.id),
  title: (a, b) => a.task.title.localeCompare(b.task.title),
  status: (a, b) => statusRank(a) - statusRank(b) || b.task.updated.localeCompare(a.task.updated),
  project: (a, b) => a.task.project.localeCompare(b.task.project),
  refs: (a, b) => (a.task.referencedBy?.length || 0) - (b.task.referencedBy?.length || 0),
  updated: (a, b) => a.task.updated.localeCompare(b.task.updated),
};
const taskSort = { key: "status", dir: 1 };
let selectedTaskPath = "";
// `?view=tasks&task=TASK-0035` restores the selected row on refresh and history navigation.
const taskFromUrl = () => {
  const id = new URLSearchParams(location.search).get("task");
  return /^TASK-\d{4}$/.test(id || "") ? `tasks/${id}.md` : "";
};
// Matches the .tasks-page container query that shows the detail pane.
const taskPaneVisible = () => elements.chunks.clientWidth >= 1000;

// `&done=1` shows completed and deferred tasks, sorted the same way but after the live ones, as work breakdowns do.
let showDoneTasks = new URLSearchParams(location.search).get("done") === "1";

function taskDocuments() {
  const tasks = state.documents
    .filter((doc) => doc.task)
    .sort((a, b) => taskSort.dir * TASK_SORTS[taskSort.key](a, b) || a.task.id.localeCompare(b.task.id));
  const live = tasks.filter((doc) => !isSettled(doc.task.status));
  return { tasks: showDoneTasks ? [...live, ...tasks.filter((doc) => isSettled(doc.task.status))] : live, settled: tasks.length - live.length };
}

function updateTasksUrl(historyMode) {
  if (historyMode === "none") return;
  const url = new URL(location.href);
  const task = selectedTaskPath.match(/TASK-\d{4}/)?.[0];
  url.search = new URLSearchParams({ view: "tasks", ...(task ? { task } : {}), ...(showDoneTasks ? { done: "1" } : {}) });
  url.hash = "";
  history[historyMode === "push" ? "pushState" : "replaceState"](null, "", url);
}

function referenceLabel(path) {
  const doc = state.documents.find((candidate) => candidate.path === path);
  if (!doc) return path;
  if (doc.date) return `${formatDate(doc.date, true)} · ${dailyDocumentLabel(doc)}`;
  return doc.task ? `${doc.task.id} · ${doc.task.title}` : doc.title;
}

function taskSortHeader(key, label) {
  const active = taskSort.key === key;
  return `<th scope="col" aria-sort="${active ? (taskSort.dir > 0 ? "ascending" : "descending") : "none"}" class="task-col-${key}"><button type="button" data-task-sort="${key}">${label}<span aria-hidden="true">${active ? (taskSort.dir > 0 ? "↑" : "↓") : ""}</span></button></th>`;
}

function renderTasksPage() {
  const { tasks, settled } = taskDocuments();
  state.view = "tasks";
  resetPageNavigation();
  elements.tasksButton.setAttribute("aria-current", "page");
  for (const file of elements.documents.querySelectorAll('.document-link[aria-current="page"]')) file.setAttribute("aria-current", "false");
  elements.title.textContent = "Tasks";
  elements.meta.textContent = `Repository tasks  /  ${showDoneTasks ? "all" : "unfinished"}`;
  elements.count.textContent = `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`;
  elements.chunkNav.hidden = true;
  elements.chunkNav.replaceChildren();
  elements.chunks.classList.add("tasks-page");
  if (!tasks.some((doc) => doc.path === selectedTaskPath)) selectedTaskPath = taskPaneVisible() ? tasks[0]?.path || "" : "";
  elements.chunks.innerHTML = `<section class="task-browser" aria-label="Unfinished tasks">
    <div class="task-index">${settled ? showDoneToggle(settled, `data-show-done-tasks${showDoneTasks ? " checked" : ""}`) : ""}${tasks.length ? `<table class="task-table">
      <thead><tr>${taskSortHeader("id", "ID")}${taskSortHeader("title", "Task")}${taskSortHeader("status", "Status")}${taskSortHeader("project", "Project")}${taskSortHeader("refs", "Refs")}${taskSortHeader("updated", "Updated")}</tr></thead>
      <tbody>${tasks.map((doc) => `<tr data-select-task="${escapeHtml(doc.path)}" aria-selected="${doc.path === selectedTaskPath}"${isSettled(doc.task.status) ? ' class="is-done"' : ""}>
        <td class="task-col-id"><button class="task-list-id" type="button" data-task-path="${escapeHtml(doc.path)}" title="Open ${escapeHtml(doc.task.id)}">${escapeHtml(doc.task.id)}</button></td>
        <td class="task-col-title"><button class="task-row-select" type="button" data-select-task="${escapeHtml(doc.path)}">${escapeHtml(doc.task.title)}</button></td>
        <td class="task-col-status">${statusPill(doc.task, doc.path)}</td>
        <td class="task-col-project">${escapeHtml(doc.task.project)}</td>
        <td class="task-col-refs">${doc.task.referencedBy?.length || "—"}</td>
        <td class="task-col-updated"><time datetime="${escapeHtml(doc.task.updated)}" title="${escapeHtml(formatDate(doc.task.updated, true))}">${escapeHtml(shortDate(doc.task.updated))}</time></td>
      </tr>`).join("")}</tbody>
    </table>` : `<p class="task-empty">No unfinished tasks found.</p>`}</div>
    <aside class="task-detail" id="task-detail" aria-live="polite"></aside>
  </section>`;
  renderTaskDetail();
}

// What a waiting task is waiting for: its check-in date and the items its Next actions name, moved ones first.
function waitingSection(task, path) {
  if (task.status !== "waiting") return "";
  const items = [...(waitingSignals[path] || [])].sort((a, b) => b.moved - a.moved);
  const date = `<p class="task-detail-checkin">Check in <strong>${escapeHtml(formatDate(task.checkIn))}</strong>${task.checkInDerived ? " · a week after its last update" : ""}</p>`;
  const rows = items.map((item) => `<li><a class="ref-row waiting-item${item.moved ? " is-moved" : ""}" href="${escapeHtml(item.href)}" target="_blank" rel="noreferrer"><code>${escapeHtml(itemLabel(item))}</code><span>${escapeHtml(item.title || "")}</span><em data-tone="${escapeHtml(item.tone)}">${escapeHtml(item.state)}${item.moved ? ` · ${escapeHtml(shortDate(item.when.slice(0, 10)))}` : ""}</em></a></li>`).join("");
  return `<section class="task-detail-section task-detail-waiting"><h4>Waiting on${items.length ? ` <span>${items.length}</span>` : ""}</h4>${date}${rows ? `<ul>${rows}</ul>` : '<p class="task-detail-empty">Its Next actions name no PR or issue to watch, so only the date brings it back.</p>'}</section>`;
}

async function renderTaskDetail() {
  const pane = document.getElementById("task-detail");
  const summary = state.documents.find((doc) => doc.path === selectedTaskPath);
  if (!pane) return;
  if (!summary) { pane.innerHTML = `<p class="task-detail-empty">Select a task to see its next actions and where it is referenced.</p>`; return; }
  const { task } = summary;
  const dateOf = (path) => state.documents.find((doc) => doc.path === path)?.date || "";
  const references = [...(task.referencedBy || [])].sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || a.localeCompare(b));
  const docLink = (path, label, className = "") => `<a class="markdown-document-link ${className}" href="${escapeHtml(documentHref(path, ""))}" data-document-path="${escapeHtml(path)}" data-document-anchor="">${label}</a>`;
  const head = `<header class="task-detail-head">
      <div class="task-detail-badges"><span class="task-list-id">${escapeHtml(task.id)}</span>${statusPill(task, summary.path)}</div>
      <button class="task-detail-open" type="button" data-task-path="${escapeHtml(summary.path)}">Open <span aria-hidden="true">→</span></button>
    </header>
    <h3>${escapeHtml(task.title)}</h3>
    <p class="task-detail-summary">${escapeHtml(task.summary)}</p>
    <p class="task-detail-meta"><span>${escapeHtml(task.project)}</span><span>Updated ${escapeHtml(formatDate(task.updated))}</span>${task.tags.map((tag) => `<span class="task-detail-tag">${escapeHtml(tag)}</span>`).join("")}</p>`;
  // Chats are the lowest-value links here, so they wait behind a disclosure at the end.
  const chats = task.chatLinks?.length ? `<details class="task-detail-chats"><summary>Chats <span>${task.chatLinks.length}</span></summary>${renderChatLinks(task.chatLinks)}</details>` : "";
  // References group by what they are: days (plan/done/notes on one line), other tasks, then topics and notes.
  const referenced = references.map((path) => state.documents.find((doc) => doc.path === path) || { path, title: path });
  const days = new Map();
  for (const doc of referenced.filter((doc) => doc.date)) days.set(doc.date, [...(days.get(doc.date) || []), doc]);
  const dayRows = [...days].map(([date, docs]) => `<li class="ref-day"><span>${escapeHtml(formatDate(date))}</span><span class="ref-day-files">${docs.sort((a, b) => dailyRank(a.path) - dailyRank(b.path)).map((doc) => docLink(doc.path, escapeHtml(dailyDocumentLabel(doc)), "ref-chip")).join("")}</span></li>`).join("");
  const taskRows = referenced.filter((doc) => doc.task).map((doc) => `<li>${docLink(doc.path, `<code>${escapeHtml(doc.task.id)}</code><span>${escapeHtml(doc.task.title)}</span>`, "ref-row")}</li>`).join("");
  const otherRows = referenced.filter((doc) => !doc.date && !doc.task).map((doc) => `<li>${docLink(doc.path, `<span>${escapeHtml(doc.title)}</span>`, "ref-row")}</li>`).join("");
  const refGroup = (label, rows) => rows ? `<div class="ref-group"><h5>${label}</h5><ul>${rows}</ul></div>` : "";
  const refs = `<section class="task-detail-section"><h4>Referenced in <span>${references.length}</span></h4>${references.length
    ? `${refGroup("Days", dayRows)}${refGroup("Tasks", taskRows)}${refGroup("Documents", otherRows)}`
    : `<p class="task-detail-empty">Not referenced from any plan or note yet.</p>`}</section>`;
  pane.innerHTML = `${head}${waitingSection(task, summary.path)}<section class="task-detail-section task-detail-actions"><h4>Next actions</h4><p class="task-detail-empty">Loading…</p></section>${refs}${chats}`;
  try {
    const response = await fetch(`/api/document?path=${encodeURIComponent(summary.path)}`);
    const doc = await response.json();
    if (!response.ok) throw new Error(doc.error || "Could not load the task.");
    if (selectedTaskPath !== summary.path) return;
    actionGroups.set("task-detail", doc.nextActions);
    const nodes = doc.work?.nodes || [];
    const leaves = nodes.filter((node) => !nodes.some((child) => child.parent === node.id));
    const progress = leaves.length ? `<p class="task-detail-progress"><span style="--done:${leaves.filter((n) => n.status === "completed").length / leaves.length}"></span>${leaves.filter((n) => n.status === "completed").length} of ${leaves.length} work items done · ${leaves.filter((n) => n.ready).length} ready</p>` : "";
    pane.querySelector(".task-detail-actions").innerHTML = `<h4>Next actions <span>${doc.nextActions.length}</span></h4>${progress}${doc.nextActions.length ? "" : '<p class="task-detail-empty">No next actions.</p>'}${renderActions(doc.nextActions.slice(0, 3), "task-detail")}${doc.nextActions.length > 3 ? `<a class="markdown-document-link task-detail-more" href="${escapeHtml(documentHref(summary.path, "next-actions"))}" data-document-path="${escapeHtml(summary.path)}" data-document-anchor="next-actions">All ${doc.nextActions.length} actions</a>` : ""}`;
  } catch (error) {
    pane.querySelector(".task-detail-actions").innerHTML = `<h4>Next actions</h4><p class="work-warning">${escapeHtml(error.message)}</p>`;
  }
}

elements.chunks.addEventListener("change", (event) => {
  // A work breakdown's toggle (in its section and its dock panel copy) keeps `&done=1` on the document URL like the Tasks page.
  if (event.target.matches("[data-show-done-work]")) {
    for (const toggle of elements.chunks.querySelectorAll("[data-show-done-work]")) toggle.checked = event.target.checked;
    const url = new URL(location.href);
    if (event.target.checked) url.searchParams.set("done", "1"); else url.searchParams.delete("done");
    history.replaceState(null, "", url);
    return;
  }
  if (!event.target.matches("[data-show-done-tasks]")) return;
  showDoneTasks = event.target.checked;
  updateTasksUrl("replace");
  renderTasksPage();
});

function showTasks({ historyMode = "push" } = {}) {
  if (state.openComposer && elements.handoffPopover.matches(":popover-open") && !requestComposerClose()) return;
  closeComposer();
  updateTasksUrl(historyMode);
  renderTasksPage();
}

// Topics and Reference get their own pages instead of sidebar lists. Topics group each `plans/<topic>/` folder under its README.
const LIBRARY_VIEWS = {
  topics: { group: "Topics", title: "Topics", meta: "Cross-day plans  /  plans/", intro: "Cross-day planning work, one folder per topic." },
  reference: { group: "Reference", title: "Reference", meta: "Stable context  /  reference/", intro: "Repository maps, conventions and other cross-day facts." },
};

function libraryRow(doc, label = doc.title, detail = doc.path) {
  return `<a class="library-row markdown-document-link" href="${escapeHtml(documentHref(doc.path, ""))}" data-document-path="${escapeHtml(doc.path)}" data-document-anchor="" title="${escapeHtml(doc.path)}"><strong>${escapeHtml(label)}</strong><code>${escapeHtml(detail)}</code></a>`;
}

function showLibrary(view, { historyMode = "push" } = {}) {
  if (state.openComposer && elements.handoffPopover.matches(":popover-open") && !requestComposerClose()) return;
  closeComposer();
  if (historyMode !== "none") {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ view });
    url.hash = "";
    history[historyMode === "push" ? "pushState" : "replaceState"](null, "", url);
  }
  renderLibraryPage(view);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderLibraryPage(view) {
  const config = LIBRARY_VIEWS[view];
  const docs = state.documents.filter((doc) => doc.group === config.group);
  state.view = view;
  resetPageNavigation();
  elements[`${view}Button`].setAttribute("aria-current", "page");
  for (const file of elements.documents.querySelectorAll('.document-link[aria-current="page"]')) file.setAttribute("aria-current", "false");
  elements.title.textContent = config.title;
  elements.meta.textContent = config.meta;
  elements.count.textContent = `${docs.length} ${docs.length === 1 ? "file" : "files"}`;
  elements.chunkNav.hidden = true;
  elements.chunkNav.replaceChildren();
  elements.chunks.classList.add("library-page");
  let body;
  let intro = config.intro;
  if (view === "topics") {
    const index = docs.find((doc) => doc.path === "plans/README.md");
    if (index) intro += ` Index: <a class="markdown-document-link library-index" href="${escapeHtml(documentHref(index.path, ""))}" data-document-path="${escapeHtml(index.path)}" data-document-anchor="">plans/README.md</a>`;
    const folders = new Map();
    for (const doc of docs.filter((candidate) => candidate !== index)) {
      const folder = doc.path.split("/").length > 2 ? doc.path.split("/")[1] : "";
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push(doc);
    }
    body = [...folders].map(([folder, files]) => {
      const readme = files.find((doc) => doc.path.endsWith("/README.md") || doc.path === "plans/README.md");
      const rest = files.filter((doc) => doc !== readme);
      const folderPath = `plans/${folder}/`;
      return `<section class="library-group"><h2>${readme ? libraryRow(readme, readme.title, folderPath) : `<span class="library-row"><strong>${escapeHtml(folder)}</strong><code>${escapeHtml(folderPath)}</code></span>`}</h2>${rest.length ? `<div class="library-children">${rest.map((doc) => libraryRow(doc, doc.title, doc.path.slice(folderPath.length))).join("")}</div>` : ""}</section>`;
    }).join("");
  } else {
    body = `<section class="library-group">${docs.map((doc) => libraryRow(doc)).join("")}</section>`;
  }
  elements.chunks.innerHTML = `<section class="library-list" aria-label="${config.title}"><p class="library-intro">${intro}</p>${body || '<p class="library-intro">Nothing here yet.</p>'}</section>`;
}

// Every `.draft` in the workspace; read on load and again when one is saved, created or deleted.
async function loadDiagrams() {
  try {
    state.diagrams = (await fetch("/api/diagrams").then((response) => response.json())).diagrams || [];
  } catch {
    state.diagrams = state.diagrams || [];
  }
  updateNavCounts();
  // The document dock's Diagrams panel counts the task's diagrams, so it is redrawn once the list arrives, unless a panel is open.
  const dock = elements.chunks.querySelector("[data-doc-dock]");
  if (state.view === "document" && state.document && dock && !dock.querySelector(".doc-dock-panel:popover-open")) {
    dock.remove();
    renderDocumentDock(state.document);
  }
  if (state.view !== "diagrams" || elements.imageViewer.open) return;
  const y = scrollY;
  const typing = document.activeElement?.matches(".diagram-filter");
  renderDiagramsPage();
  window.scrollTo({ top: y, behavior: "instant" });
  if (typing) elements.chunks.querySelector(".diagram-filter")?.focus();
  if (pendingDiagram) { openDiagram(pendingDiagram); pendingDiagram = ""; }
}

function showDiagrams({ historyMode = "push" } = {}) {
  if (state.openComposer && elements.handoffPopover.matches(":popover-open") && !requestComposerClose()) return;
  closeComposer();
  if (historyMode !== "none") {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ view: "diagrams" });
    url.hash = "";
    history[historyMode === "push" ? "pushState" : "replaceState"](null, "", url);
  }
  renderDiagramsPage();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderDiagramsPage() {
  const query = new URLSearchParams(location.search).get("q") || "";
  state.view = "diagrams";
  resetPageNavigation();
  elements.diagramsButton.setAttribute("aria-current", "page");
  for (const file of elements.documents.querySelectorAll('.document-link[aria-current="page"]')) file.setAttribute("aria-current", "false");
  elements.title.textContent = "Diagrams";
  elements.meta.textContent = "Every .draft in the workspace";
  elements.count.textContent = state.diagrams ? plural(state.diagrams.length, "diagram") : "";
  elements.chunkNav.hidden = true;
  elements.chunkNav.replaceChildren();
  elements.chunks.classList.add("library-page", "diagrams-page");
  if (!state.diagrams) {
    elements.chunks.innerHTML = `<section class="library-list"><p class="library-intro">Loading diagrams…</p></section>`;
    return;
  }
  elements.chunks.innerHTML = diagramsPageHtml(state.diagrams, state.documents, query, ago);
  if (query) filterDiagrams(elements.chunks, query);
}

elements.chunks.addEventListener("input", (event) => {
  const filter = event.target.closest(".diagram-filter");
  if (!filter) return;
  filterDiagrams(elements.chunks, filter.value);
  setOverlayParams({ q: filter.value.trim() });
});
elements.chunks.addEventListener("keydown", (event) => {
  const filter = event.target.closest(".diagram-filter");
  if (!filter) return;
  if (event.key === "Escape" && filter.value) { event.stopPropagation(); filter.value = ""; filter.dispatchEvent(new Event("input", { bubbles: true })); }
  else if (event.key === "Escape") filter.blur();
  else if (event.key === "Enter") elements.chunks.querySelector(".diagram-card:not([hidden])")?.click();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || state.view !== "diagrams" || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest?.("input, textarea, [contenteditable]") || document.querySelector("dialog[open]")) return;
  const filter = elements.chunks.querySelector(".diagram-filter");
  if (!filter) return;
  event.preventDefault();
  filter.focus();
  filter.select();
});

function showCode({ historyMode = "push", tab = "" } = {}) {
  if (state.openComposer && elements.handoffPopover.matches(":popover-open") && !requestComposerClose()) return;
  closeComposer();
  if (historyMode !== "none") {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ view: "code", ...(tab ? { tab } : {}) });
    url.hash = "";
    history[historyMode === "push" ? "pushState" : "replaceState"](null, "", url);
  }
  renderCode(tab);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderCode(tab = new URLSearchParams(location.search).get("tab") || "") {
  state.view = "code";
  resetPageNavigation();
  elements.codeButton.setAttribute("aria-current", "page");
  for (const file of elements.documents.querySelectorAll('.document-link[aria-current="page"]')) file.setAttribute("aria-current", "false");
  elements.title.textContent = "Code";
  elements.meta.textContent = `Tracked repositories  /  ${config().code.reposFile}`;
  elements.count.textContent = "";
  elements.chunkNav.hidden = true;
  elements.chunkNav.replaceChildren();
  elements.chunks.classList.add("code-page");
  renderCodePage(elements.chunks, { tab, showNotice });
}

function showIssues({ historyMode = "push", tab = "" } = {}) {
  if (state.openComposer && elements.handoffPopover.matches(":popover-open") && !requestComposerClose()) return;
  closeComposer();
  if (historyMode !== "none") {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ view: "issues", ...(tab ? { tab } : {}) });
    url.hash = "";
    history[historyMode === "push" ? "pushState" : "replaceState"](null, "", url);
  }
  renderIssues(tab);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderIssues(tab = new URLSearchParams(location.search).get("tab") || "") {
  state.view = "issues";
  resetPageNavigation();
  elements.issuesButton.setAttribute("aria-current", "page");
  for (const file of elements.documents.querySelectorAll('.document-link[aria-current="page"]')) file.setAttribute("aria-current", "false");
  elements.title.textContent = "Issues";
  const { jql, linear, github } = config().issues;
  elements.meta.textContent = [jql && `Jira  /  ${jql}`, linear?.teams?.length && `Linear  /  ${linear.teams.join(", ")}`, github && "GitHub  /  tracked repositories"].filter(Boolean).join("   ·   ");
  elements.count.textContent = "";
  elements.chunkNav.hidden = true;
  elements.chunkNav.replaceChildren();
  elements.chunks.classList.add("code-page", "issues-page");
  renderIssuesPage(elements.chunks, { tab, showNotice });
}

function showSlack({ historyMode = "push" } = {}) {
  if (state.openComposer && elements.handoffPopover.matches(":popover-open") && !requestComposerClose()) return;
  closeComposer();
  if (historyMode !== "none") {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ view: "slack" });
    url.hash = "";
    history[historyMode === "push" ? "pushState" : "replaceState"](null, "", url);
  }
  renderSlack();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderSlack() {
  state.view = "slack";
  resetPageNavigation();
  elements.slackButton.setAttribute("aria-current", "page");
  for (const file of elements.documents.querySelectorAll('.document-link[aria-current="page"]')) file.setAttribute("aria-current", "false");
  elements.title.textContent = "Slack";
  elements.meta.textContent = "Threads the planning documents link, read through Codex's Slack connector";
  elements.count.textContent = "";
  elements.chunkNav.hidden = true;
  elements.chunkNav.replaceChildren();
  elements.chunks.classList.add("code-page", "slack-page");
  renderSlackPage(elements.chunks, { showNotice, toggleFavorite, isFavorite, favorites: () => favorites.map((favorite) => favorite.href) });
}

function showActivity({ historyMode = "push" } = {}) {
  if (state.openComposer && elements.handoffPopover.matches(":popover-open") && !requestComposerClose()) return;
  closeComposer();
  if (historyMode !== "none") {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ view: "activity" });
    url.hash = "";
    history[historyMode === "push" ? "pushState" : "replaceState"](null, "", url);
  }
  renderActivity();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderActivity() {
  state.view = "activity";
  resetPageNavigation();
  elements.activityButton.setAttribute("aria-current", "page");
  for (const file of elements.documents.querySelectorAll('.document-link[aria-current="page"]')) file.setAttribute("aria-current", "false");
  elements.title.textContent = "Activity";
  elements.meta.textContent = "Everything that changed, newest first";
  elements.count.textContent = "";
  elements.chunkNav.hidden = true;
  elements.chunkNav.replaceChildren();
  elements.chunks.classList.add("code-page", "activity-page");
  renderActivityPage(elements.chunks, state.documents, { openDocument: (path, anchor) => selectDocument(path, { historyMode: "push", anchor }), openDiagram: (path) => openDiagram(path) });
}

function composerTemplate(target) {
  const hint = `<p class="composer-hint"><kbd>Enter</kbd> to open · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · paste images</p>`;
  const close = `<button class="popover-close" type="button" aria-label="Close dialog">×</button>`;
  const heading = (meta) => `<header class="composer-heading"><div><h3>${escapeHtml(target.title)}</h3>${meta ? `<p class="composer-meta">${meta}</p>` : ""}</div>${close}</header>`;
  if (target.scope === "work") {
    const { node, nodes, action, mode } = target;
    const label = workStatusLabel(node, nodes);
    const waiting = node.deps.filter((id) => nodes.find((n) => n.id === id)?.status !== "completed");
    const meta = `<span title="${escapeHtml(state.selectedPath)}">${escapeHtml(state.selectedPath.split("/").pop())}</span> · ${escapeHtml(node.id)} · ${node.ready ? escapeHtml(label) : `<span class="action-waiting">${escapeHtml(label)}${waiting.length ? ` · after ${escapeHtml(waiting.join(", "))}` : ""}</span>`}`;
    const preview = mode === "run" && action ? `<div class="action-prompt-preview" aria-label="Stored action prompt"><div class="markdown">${renderMarkdownSource(action.prompt, state.selectedPath)}</div></div>` : "";
    const field = mode === "update"
      ? `<label for="work-context">What should change? <span class="optional-label">optional</span></label><textarea id="work-context" name="commentary" placeholder="Split it, reword it, mark it done, add or drop a prerequisite… Leave empty to bring it in line with the latest updates."></textarea>`
      : `<label for="work-context">Add context <span class="optional-label">optional</span></label><textarea id="work-context" name="commentary" placeholder="${node.ready ? "A constraint, recent finding, or where to start…" : "Say whether the prerequisites are done, or what can safely start now…"}"></textarea>`;
    return `<form class="composer" data-composer-key="${escapeHtml(target.key)}" data-scope="work" data-work-item="${escapeHtml(node.id)}" data-work-mode="${mode}">
      ${heading(meta)}
      <div class="composer-body">${preview}<div class="composer-field">${field}<div class="composer-images" hidden></div></div></div>
      <footer class="composer-actions">${hint}<button class="copy-prompt-button" type="button">Copy prompt</button><button class="cancel-button" type="button">Cancel</button><button class="send-button" type="submit">Open in ${agentName()}</button></footer>
    </form>`;
  }
  if (target.scope === "action") {
    const { action } = target;
    const meta = `<span title="${escapeHtml(action.sourcePath)}">${escapeHtml(action.sourcePath.split("/").pop())}</span>${action.workItem ? ` · ${escapeHtml(action.workItem)}` : ""}${action.blocked ? ` · <span class="action-waiting">${escapeHtml(action.blockedReason || "Waiting on prerequisites")}</span>` : ""}`;
    return `<form class="composer" data-composer-key="${escapeHtml(target.key)}" data-scope="action" data-source-path="${escapeHtml(action.sourcePath)}" data-action-id="${escapeHtml(action.id)}" data-expected-prompt="${escapeHtml(action.prompt)}">
      ${heading(meta)}
      <div class="composer-body">
        <div class="action-prompt-preview" aria-label="Prompt"><div class="markdown">${renderMarkdownSource(action.prompt, action.sourcePath)}</div></div>
        <div class="composer-field">
          <label for="action-context">Add context <span class="optional-label">optional</span></label>
          <textarea id="action-context" name="commentary" placeholder="A constraint, recent finding, or where to start…"></textarea>
          <div class="composer-images" hidden></div>
        </div>
      </div>
      <footer class="composer-actions">${hint}<button class="copy-prompt-button" type="button">Copy prompt</button><button class="cancel-button" type="button">Cancel</button><button class="send-button" type="submit">Open in ${agentName()}</button></footer>
    </form>`;
  }
  const context = target.scope === "chunk"
    ? `<div class="composer-context"><div class="composer-context-body" id="composer-context-body"><div class="markdown">${renderMarkdownSource(target.chunk.markdown, state.selectedPath)}</div></div><button class="context-toggle" type="button" aria-expanded="false" aria-controls="composer-context-body" hidden>Show full chunk</button></div>`
    : target.selection
      ? `<div class="composer-context"><div class="composer-context-body" id="composer-context-body"><blockquote class="composer-selection">${escapeHtml(target.selection)}</blockquote></div><button class="context-toggle" type="button" aria-expanded="false" aria-controls="composer-context-body" hidden>Show full selection</button></div>`
      : "";
  const meta = target.scope === "document" || (target.scope === "global" && state.view === "document") ? escapeHtml(target.section ? `${state.selectedPath} · ${target.section}` : state.selectedPath) : "";
  const fieldLabel = target.scope === "chunk" ? `What should ${agentName()} do with this chunk?` : target.selection ? `What should ${agentName()} do with this selection?` : `What should ${agentName()} do?`;
  return `<form class="composer" data-composer-key="${escapeHtml(target.key)}" data-scope="${target.scope}" ${target.chunk ? `data-chunk-id="${target.chunk.id}"` : ""} ${target.selection ? `data-selection="${escapeHtml(target.selection)}" data-section="${escapeHtml(target.section)}"` : ""}>
    ${heading(meta)}
    <div class="composer-body">
      ${context}
      <div class="composer-field">
        <label for="comment-${target.key}">${fieldLabel}</label>
        <textarea id="comment-${target.key}" name="commentary" placeholder="Add direction, a question, or the outcome you want…" required>${escapeHtml(target.commentary || '')}</textarea>
        <div class="composer-images" hidden></div>
      </div>
    </div>
    <footer class="composer-actions">${hint}<button class="copy-prompt-button" type="button">Copy prompt</button><button class="cancel-button" type="button">Cancel</button><button class="send-button" type="submit">Open draft in ${agentName()}</button></footer>
  </form>`;
}

function resizeComposerTextarea(textarea) {
  if (!textarea) return;
  const maxHeight = Math.max(140, Math.min(480, window.innerHeight - 250));
  textarea.style.height = "0px";
  const contentHeight = textarea.scrollHeight + 2;
  textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
  textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}

function composerHasText() {
  return Boolean(elements.handoffPopover.querySelector("textarea")?.value.trim() || elements.handoffPopover.querySelector(".composer-images img"));
}

// Pasted or dropped images ride along as data URLs; the server saves them where the agent can open them.
async function attachComposerImages(files) {
  const strip = elements.handoffPopover.querySelector(".composer-images");
  const images = [...files].filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
  if (!strip || !images.length) return false;
  for (const file of images) {
    const url = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file); });
    strip.insertAdjacentHTML("beforeend", `<figure><img src="${url}" alt="Attached image"><button type="button" class="composer-image-remove" aria-label="Remove image" title="Remove image">×</button></figure>`);
  }
  strip.hidden = false;
  syncComposerDraftState();
  return true;
}

function syncComposerDraftState() {
  const protectedDraft = composerHasText();
  elements.handoffPopover.classList.toggle("draft-protected", protectedDraft);
  const closeButton = elements.handoffPopover.querySelector(".popover-close");
  if (closeButton) {
    const closeLabel = protectedDraft ? "Draft has text; use Cancel to discard it" : "Close dialog";
    closeButton.title = closeLabel;
    closeButton.setAttribute("aria-label", closeLabel);
  }
  const hint = elements.handoffPopover.querySelector(".composer-hint");
  if (hint) {
    hint.classList.remove("draft-warning");
    hint.innerHTML = protectedDraft
      ? "<kbd>Enter</kbd> to open · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · Cancel discards"
      : "<kbd>Enter</kbd> to open · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · paste images";
  }
}

function requestComposerClose(returnFocus = false) {
  if (composerHasText()) {
    const hint = elements.handoffPopover.querySelector(".composer-hint");
    if (hint) {
      hint.textContent = "Draft kept — open it or click Cancel to discard.";
      hint.classList.add("draft-warning");
    }
    elements.handoffPopover.querySelector("textarea")?.focus();
    return false;
  }
  closeComposer(returnFocus);
  return true;
}

function closeComposer(returnFocus = false) {
  const trigger = handoffTrigger;
  // Backing out of a work item draft (Cancel, Esc, ×) returns to that item's dialog; sending it does not.
  const workItem = returnFocus && state.openComposer?.startsWith("work:") ? state.openComposer.split(":").slice(2).join(":") : "";
  if (elements.handoffPopover.matches(":popover-open")) elements.handoffPopover.hidePopover();
  state.openComposer = null;
  handoffTrigger = null;
  elements.handoffPopover.replaceChildren();
  trigger?.setAttribute("aria-expanded", "false");
  elements.globalHandoff.setAttribute("aria-expanded", "false");
  elements.documentHandoff?.setAttribute("aria-expanded", "false");
  for (const button of elements.chunks.querySelectorAll(".handoff-button, [data-action-key]")) button.setAttribute("aria-expanded", "false");
  if (workItem) openWorkItem(workItem);
  else if (returnFocus) trigger?.focus();
}

// Images in an open overlay (an issue's description) page among themselves; elsewhere among the document's.
function imageViewerItems(trigger) {
  return [...(trigger.closest("dialog") || elements.chunks).querySelectorAll(".markdown-image-trigger:not([hidden])")].map((trigger, index) => {
    const image = trigger.querySelector(".markdown-image");
    return {
      trigger,
      src: image.currentSrc || image.src,
      alt: image.alt || `Image ${index + 1}`,
      diagram: trigger.dataset.diagram || "",
      // On the Diagrams page each card sits under its task's heading; the rail repeats that grouping.
      group: [...(trigger.closest(".diagram-group")?.querySelector(".diagram-group-title")?.children || [])].map((part) => part.textContent.trim()).join(" "),
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  });
}

function resetImageViewerTransform() {
  fitImageViewer();
}

function fitImageViewer() {
  const item = imageViewerState.items[imageViewerState.index];
  const image = elements.imageViewer.querySelector(".image-viewer-main-image");
  const stage = elements.imageViewer.querySelector(".image-viewer-stage");
  const width = item?.width || image?.naturalWidth;
  const height = item?.height || image?.naturalHeight;
  if (!stage || !width || !height) return;
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const styles = getComputedStyle(stage);
  const inlineInset = Number.parseFloat(styles.getPropertyValue("--image-fit-inline")) || 0;
  const blockInset = Number.parseFloat(styles.getPropertyValue("--image-fit-block")) || 0;
  const availableWidth = Math.max(1, rect.width - inlineInset);
  const availableHeight = Math.max(1, rect.height - blockInset);
  // A drawn diagram is vector, so it may grow to fill the stage; raster images stop at their own size.
  imageViewerState.fitScale = Math.max(.01, Math.min(item?.svg ? 2 : 1, availableWidth / width, availableHeight / height));
  imageViewerState.scale = imageViewerState.fitScale;
  imageViewerState.isFitView = true;
  imageViewerState.offset = { x: 0, y: 0 };
  imageViewerState.pan = null;
  updateImageViewerTransform();
}

function updateImageViewerTransform() {
  const image = elements.imageViewer.querySelector(".image-viewer-main-image");
  const zoom = elements.imageViewer.querySelector("[data-image-zoom]");
  // CSS pins the image at the stage center; preserve that exact origin as pan and zoom are composed.
  if (image) image.style.transform = `translate(calc(-50% + ${imageViewerState.offset.x}px), calc(-50% + ${imageViewerState.offset.y}px)) scale(${imageViewerState.scale})`;
  if (zoom) zoom.textContent = `${Math.round(imageViewerState.scale * 100)}%`;
}

function zoomImageViewer(factor, anchor) {
  const stage = elements.imageViewer.querySelector(".image-viewer-stage");
  if (!stage) return;
  const previous = imageViewerState.scale;
  const minimum = Math.min(.1, imageViewerState.fitScale);
  const next = Math.min(8, Math.max(minimum, previous * factor));
  if (next === previous) return;
  const rect = stage.getBoundingClientRect();
  const point = anchor || { x: rect.width / 2, y: rect.height / 2 };
  const center = { x: rect.width / 2, y: rect.height / 2 };
  const ratio = next / previous;
  const relative = {
    x: point.x - center.x - imageViewerState.offset.x,
    y: point.y - center.y - imageViewerState.offset.y,
  };
  imageViewerState.scale = next;
  imageViewerState.isFitView = false;
  imageViewerState.offset = {
    x: point.x - center.x - relative.x * ratio,
    y: point.y - center.y - relative.y * ratio,
  };
  updateImageViewerTransform();
}

function renderImageViewer() {
  const item = imageViewerState.items[imageViewerState.index];
  if (!item) return;
  const count = imageViewerState.items.length;
  const source = item.diagram && imageViewerState.showSource;
  if (item.diagram) {
    setOverlayParams({ diagram: item.diagram });
    if (!item.loaded) loadDiagram(item);
  }
  const dimensions = item.width && item.height ? `${item.width} × ${item.height}` : "Loading dimensions…";
  elements.imageViewer.innerHTML = `<section class="image-viewer-shell">
    <header class="image-viewer-header">
      <div class="image-viewer-heading">
        ${count > 1 ? `<span>${imageViewerState.index + 1} / ${count}</span>` : ""}
        <h2 id="image-viewer-title">${escapeHtml(item.alt)}</h2>
        <p>${item.diagram ? "Scroll to zoom · Drag to pan · Hover a box to find its line" : `<span data-image-dimensions>${dimensions}</span> · Scroll to zoom · Drag to pan`}</p>
      </div>
      <div class="image-viewer-controls" aria-label="Image controls">
        ${item.diagram && isDiffDiagram(item.source) ? panelsToggle(item) : ""}
        ${item.diagram ? `<button class="image-viewer-text" type="button" data-image-action="toggle-source" aria-pressed="${imageViewerState.showSource}" title="Show the .draft source beside the drawing (S)">Source</button><button class="image-viewer-text" type="button" data-image-action="copy-png" title="Copy the drawing as a PNG that carries its source (C)">Copy PNG</button><button class="image-viewer-text image-viewer-edit" type="button" data-image-action="edit-diagram" title="Open ${escapeHtml(item.diagram.split("/").pop())} in the draftably editor; saves redraw here (E)">Edit</button>` : ""}
        <button type="button" data-image-action="zoom-out" aria-label="Zoom out">−</button>
        <button class="image-viewer-reset" type="button" data-image-action="reset" aria-label="Reset image to fit"><span data-image-zoom>Fit</span><span>Reset</span></button>
        <button type="button" data-image-action="zoom-in" aria-label="Zoom in">+</button>
        <button class="image-viewer-close" type="button" data-image-action="close" aria-label="Close image viewer">×</button>
      </div>
    </header>
    <div class="image-viewer-body${count === 1 ? " is-single" : ""}${source ? " has-source" : ""}">
      ${count > 1 ? imageViewerRail() : ""}
      <div class="image-viewer-stage" tabindex="0" aria-label="Zoomable image. Use arrow keys to browse, plus and minus to zoom, and zero to reset.">
        ${item.svg ? `<div class="image-viewer-main-image image-viewer-diagram" role="img" aria-label="${escapeHtml(item.alt)}">${item.svg}</div>` : item.html ? `<div class="image-viewer-main-image image-viewer-graph">${item.html}</div>` : `<img class="image-viewer-main-image" src="${escapeHtml(item.src)}" alt="${escapeHtml(item.alt)}" draggable="false">`}
        ${count > 1 ? `<button class="image-viewer-nav image-viewer-previous" type="button" data-image-action="previous" aria-label="Previous image">←</button><button class="image-viewer-nav image-viewer-next" type="button" data-image-action="next" aria-label="Next image">→</button>` : ""}
      </div>
      ${source ? `<aside class="diagram-source" aria-label="Diagram source">
        <header><span title="${escapeHtml(item.diagram)}">${escapeHtml(item.diagram.split("/").pop())}</span><button type="button" data-image-action="copy-source" title="Copy the source">${glyph("copy")}<span>Copy</span></button></header>
        <pre>${item.source === undefined ? `<span class="draft-loading">Loading…</span>` : sourceHtml(item.source)}</pre>
        <form class="diagram-ask" data-diagram-ask>
          <textarea rows="1" aria-label="Ask ${escapeHtml(agentName())} about this diagram" placeholder="Ask ${escapeHtml(agentName())} to change this diagram (D)…">${escapeHtml(diagramDrafts.get(item.diagram) || "")}</textarea>
          <footer><span class="code-spacer"></span><button type="button" data-image-action="copy-prompt">Copy prompt</button><button class="is-primary" type="submit">Open in ${escapeHtml(agentName())}</button></footer>
        </form>
      </aside>` : ""}
    </div>
  </section>`;
  const mainImage = elements.imageViewer.querySelector(".image-viewer-main-image");
  const syncLoadedImage = () => {
    item.width = mainImage.naturalWidth;
    item.height = mainImage.naturalHeight;
    const label = elements.imageViewer.querySelector("[data-image-dimensions]");
    if (label) label.textContent = `${item.width} × ${item.height}`;
    if (imageViewerState.isFitView) fitImageViewer();
  };
  if (mainImage.tagName === "IMG") {
    mainImage.addEventListener("load", syncLoadedImage);
    if (mainImage.complete && mainImage.naturalWidth) syncLoadedImage();
  }
  imageViewerResizeObserver?.disconnect();
  imageViewerResizeObserver = new ResizeObserver(() => {
    if (imageViewerState.isFitView) fitImageViewer();
  });
  imageViewerResizeObserver.observe(elements.imageViewer.querySelector(".image-viewer-stage"));
  const activeThumbnail = elements.imageViewer.querySelector('.image-viewer-thumbnail[aria-current="true"]');
  window.requestAnimationFrame(() => activeThumbnail?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  updateImageViewerTransform();
  autosizeDiagramAsk();
  filterImageViewerRail();
}

function showImageViewer(trigger) {
  const items = imageViewerItems(trigger);
  openImageViewerAt(items, items.findIndex((item) => item.trigger === trigger), trigger);
}

// A `.draft` named by a link or the URL opens among the document's images, at its embed when it has one.
function openDiagram(path, trigger = null) {
  const items = imageViewerItems(trigger || elements.chunks);
  let index = items.findIndex((item) => item.diagram === path);
  if (index < 0) index = items.push({ trigger, diagram: path, src: diagramHref(path), alt: state.diagrams?.find((diagram) => diagram.path === path)?.title || path.split("/").pop().replace(/\.draft$/, "") }) - 1;
  openImageViewerAt(items, index, trigger);
}

function openImageViewerAt(items, index, trigger) {
  if (index < 0) return;
  imageViewerState.railQuery = "";
  if (elements.imageViewer.open) closeImageViewer(false);
  imageViewerState.items = items;
  imageViewerState.index = index;
  imageViewerState.trigger = trigger;
  imageViewerState.scale = 1;
  imageViewerState.fitScale = 1;
  imageViewerState.isFitView = true;
  imageViewerState.offset = { x: 0, y: 0 };
  renderImageViewer();
  elements.imageViewer.showModal();
  fitImageViewer();
  window.requestAnimationFrame(() => elements.imageViewer.querySelector(".image-viewer-stage")?.focus());
}

// The dependency graph reuses the image viewer's fit, zoom and pan; the item carries a copy of the visible graph instead of an image.
function showGraphViewer(trigger) {
  const graph = [...trigger.closest(".work-graph-disclosure").querySelectorAll(".work-graph")].find(g => getComputedStyle(g).display !== "none");
  if (!graph) return;
  imageViewerState.items = [{ trigger, alt: "Dependency graph", width: parseFloat(graph.style.width) + 24, height: parseFloat(graph.style.height) + 24, html: graph.outerHTML }];
  imageViewerState.index = 0;
  imageViewerState.trigger = trigger;
  renderImageViewer();
  elements.imageViewer.showModal();
  fitImageViewer();
  window.requestAnimationFrame(() => elements.imageViewer.querySelector(".image-viewer-stage")?.focus());
}

function closeImageViewer(returnFocus = true) {
  const trigger = imageViewerState.trigger;
  if (new URLSearchParams(location.search).get("diagram")) {
    announceClosed();
    setOverlayParams({ diagram: "" });
  }
  imageViewerState.pan = null;
  imageViewerResizeObserver?.disconnect();
  imageViewerResizeObserver = null;
  if (elements.imageViewer.open) elements.imageViewer.close();
  imageViewerState.items = [];
  imageViewerState.trigger = null;
  elements.imageViewer.replaceChildren();
  // A live refresh may have redrawn the page behind the viewer, so the original trigger can be gone.
  const target = trigger?.isConnected ? trigger : trigger?.dataset?.diagram && document.querySelector(`[data-diagram="${CSS.escape(trigger.dataset.diagram)}"]`);
  if (returnFocus) target?.focus();
}

// The rail lists every image as a small thumbnail with its title, under its task's heading when the set has groups,
// with a filter once the set is long. Titles, not pictures, are how one diagram is found among dozens.
const RAIL_FILTER_AT = 12;
function imageViewerRail() {
  const { items, index: current } = imageViewerState;
  let group = null;
  const rows = items.map((item, index) => {
    const heading = item.group && item.group !== group ? `<div class="image-viewer-rail-group" data-rail-group="${escapeHtml(item.group)}">${escapeHtml(item.group)}</div>` : "";
    group = item.group;
    return `${heading}<button class="image-viewer-thumbnail${item.diagram ? " is-diagram" : ""}" type="button" data-image-index="${index}" data-rail-text="${escapeHtml(`${item.alt} ${item.group || ""} ${item.diagram || ""}`.toLowerCase())}" data-rail-of="${escapeHtml(item.group || "")}" aria-current="${index === current}" aria-label="View image ${index + 1}: ${escapeHtml(item.alt)}"><span class="image-viewer-thumb"><img src="${escapeHtml(item.src)}" alt="" loading="lazy" decoding="async"></span><span class="image-viewer-thumb-title">${escapeHtml(item.alt)}</span></button>`;
  }).join("");
  const filter = items.length > RAIL_FILTER_AT ? `<input class="image-viewer-rail-filter" type="search" placeholder="Filter ${items.length} ${items.some((item) => item.diagram) ? "diagrams" : "images"}" aria-label="Filter the images" value="${escapeHtml(imageViewerState.railQuery || "")}" spellcheck="false">` : "";
  return `<aside class="image-viewer-rail${filter ? " has-filter" : ""}" aria-label="Images">${filter}<div class="image-viewer-rail-list">${rows}<p class="image-viewer-rail-none" hidden>No match.</p></div></aside>`;
}

function filterImageViewerRail() {
  const rail = elements.imageViewer.querySelector(".image-viewer-rail");
  if (!rail) return;
  const words = (imageViewerState.railQuery || "").toLowerCase().split(/\s+/).filter(Boolean);
  const shownGroups = new Set();
  let shown = 0;
  for (const row of rail.querySelectorAll("[data-image-index]")) {
    const match = words.every((word) => row.dataset.railText.includes(word));
    row.hidden = !match;
    if (match) { shown += 1; shownGroups.add(row.dataset.railOf); }
  }
  for (const heading of rail.querySelectorAll("[data-rail-group]")) heading.hidden = !shownGroups.has(heading.dataset.railGroup);
  rail.querySelector(".image-viewer-rail-none").hidden = shown > 0;
}

function selectImageViewerItem(index) {
  const count = imageViewerState.items.length;
  if (!count) return;
  imageViewerState.index = ((index % count) + count) % count;
  if (!imageViewerState.items[imageViewerState.index].diagram) setOverlayParams({ diagram: "" });
  imageViewerState.scale = 1;
  imageViewerState.fitScale = 1;
  imageViewerState.isFitView = true;
  imageViewerState.offset = { x: 0, y: 0 };
  renderImageViewer();
  fitImageViewer();
  elements.imageViewer.querySelector(".image-viewer-stage")?.focus();
}

function openComposer(target, trigger) {
  if (state.openComposer === target.key && elements.handoffPopover.matches(":popover-open")) {
    requestComposerClose(true);
    return;
  }
  if (state.openComposer && elements.handoffPopover.matches(":popover-open") && !requestComposerClose()) return;
  handoffTrigger?.setAttribute("aria-expanded", "false");
  state.openComposer = target.key;
  handoffTrigger = trigger;
  elements.handoffPopover.innerHTML = composerTemplate(target);
  trigger?.setAttribute("aria-expanded", "true");
  if (!elements.handoffPopover.matches(":popover-open")) elements.handoffPopover.showPopover();
  const textarea = elements.handoffPopover.querySelector("textarea");
  resizeComposerTextarea(textarea);
  syncComposerDraftState();
  const contextBody = elements.handoffPopover.querySelector(".composer-context-body");
  if (contextBody && contextBody.scrollHeight > contextBody.clientHeight + 1) {
    contextBody.parentElement.classList.add("is-clamped");
    elements.handoffPopover.querySelector(".context-toggle").hidden = false;
  }
  textarea?.focus();
}

function flattenOutline(nodes, parents = [], output = []) {
  for (const node of nodes) {
    const path = [...parents, node.key];
    output.push({ ...node, path });
    flattenOutline(node.children, path, output);
  }
  return output;
}

function prepareChunkOutlines(doc) {
  chunkOutlines.clear();
  for (const chunk of doc.chunks) {
    let sequence = 0;
    const decorate = (nodes) => nodes.map((node) => {
      const decorated = { ...node, key: `${chunk.id}-heading-${sequence += 1}` };
      decorated.children = decorate(node.children);
      return decorated;
    });
    const roots = decorate(markdownOutline(chunk.markdown, chunk.level));
    const flat = flattenOutline(roots);
    chunkOutlines.set(chunk.id, { roots, flat, paths: new Map(flat.map((node) => [node.key, node.path])) });
  }
}

function navigationColumn(title, label, body, className = "") {
  return `<section class="chunk-nav-column ${className}">
    <div class="chunk-nav-heading" title="${escapeHtml(title)}">
      ${label ? `<span>${escapeHtml(label)}</span>` : ""}
      <h2>${escapeHtml(title)}</h2>
    </div>
    <div class="chunk-map">${body}</div>
  </section>`;
}

function renderChunkNavigation() {
  const doc = state.document;
  if (!doc) return;
  const activeChunk = doc.chunks.find((chunk) => chunk.id === state.activeChunkId) || doc.chunks[0];
  const outline = chunkOutlines.get(activeChunk?.id);
  const hasNavigation = doc.chunks.length > 1 || outline?.roots.length;
  elements.chunkNav.hidden = !hasNavigation;
  if (!hasNavigation) {
    elements.chunkNav.replaceChildren();
    return;
  }

  const focusedKey = elements.chunkNav.contains(document.activeElement) ? document.activeElement.dataset.outlineKey : null;
  const selectedKeys = new Set(state.activeOutlinePath || []);
  const chunkLinks = doc.chunks.map((chunk, index) => `
    <a class="chunk-jump" href="#${chunk.id}" data-chunk-id="${chunk.id}" ${chunk.id === activeChunk.id ? 'aria-current="location"' : ""} aria-label="Jump to ${escapeHtml(chunk.title)}">
      <span class="chunk-jump-index">${String(index + 1).padStart(2, "0")}</span>
      <strong>${escapeHtml(chunk.title)}</strong>
      ${chunkOutlines.get(chunk.id)?.roots.length ? '<span class="chunk-jump-more" aria-hidden="true">›</span>' : ""}
    </a>`).join("");
  const columns = [navigationColumn(doc.kind === "Plan" ? "Milestones" : "Contents", "", chunkLinks, "chunk-nav-root")];

  let nodes = outline?.roots || [];
  let parentTitle = activeChunk.title;
  let depth = 1;
  while (nodes.length && columns.length < 3) {
    const canRevealChildren = columns.length < 2;
    const links = nodes.map((node) => `
      <a class="outline-jump" href="#${escapeHtml(node.anchor)}" data-outline-key="${node.key}" data-selected="${selectedKeys.has(node.key)}" aria-label="Jump to ${escapeHtml(node.title)}">
        <strong>${escapeHtml(node.title)}</strong>
        ${canRevealChildren && node.children.length ? '<span aria-hidden="true">›</span>' : ""}
      </a>`).join("");
    columns.push(navigationColumn(parentTitle, "", links, `chunk-nav-depth-${depth}`));
    const selected = nodes.find((node) => selectedKeys.has(node.key));
    if (!selected?.children.length) break;
    nodes = selected.children;
    parentTitle = selected.title;
    depth += 1;
  }

  elements.chunkNav.innerHTML = `<div class="chunk-nav-columns">${columns.join("")}</div>`;
  const focusTarget = focusedKey ? elements.chunkNav.querySelector(`[data-outline-key="${focusedKey}"]`) : null;
  focusTarget?.focus({ preventScroll: true });
  for (const link of elements.chunkNav.querySelectorAll('.chunk-jump[aria-current="location"], .outline-jump[data-selected="true"]')) scrollNavigationLinkIntoView(link);
  alignProgressiveColumns();
}

function scrollNavigationLinkIntoView(link) {
  const map = link?.closest(".chunk-map");
  if (!map || map.scrollHeight <= map.clientHeight) return;
  const top = link.offsetTop;
  const bottom = top + link.offsetHeight;
  if (top < map.scrollTop) map.scrollTop = top;
  else if (bottom > map.scrollTop + map.clientHeight) map.scrollTop = bottom - map.clientHeight;
}

function alignProgressiveColumns() {
  const columns = [...elements.chunkNav.querySelectorAll(".chunk-nav-column")].filter((column) => getComputedStyle(column).display !== "none");
  for (let index = 1; index < columns.length; index += 1) {
    const previous = columns[index - 1];
    const selected = previous.querySelector('.chunk-jump[aria-current="location"], .outline-jump[data-selected="true"]');
    const column = columns[index];
    const heading = column.querySelector(".chunk-nav-heading");
    const map = column.querySelector(".chunk-map");
    column.style.paddingTop = "0px";
    if (!selected || !heading || !map) continue;
    const columnRect = column.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    const items = [...map.children];
    const mapStyles = getComputedStyle(map);
    const mapPadding = Number.parseFloat(mapStyles.paddingTop) + Number.parseFloat(mapStyles.paddingBottom);
    const itemsHeight = items.length ? items.at(-1).offsetTop + items.at(-1).offsetHeight - items[0].offsetTop : 0;
    const contentHeight = Math.min(column.clientHeight, heading.offsetHeight + mapPadding + itemsHeight);
    const selectedCenter = selectedRect.top + selectedRect.height / 2 - columnRect.top;
    const desiredTop = selectedCenter - contentHeight / 2;
    const offset = Math.max(0, Math.min(column.clientHeight - contentHeight, desiredTop));
    column.style.paddingTop = `${Math.round(offset)}px`;
  }
}

function releaseNavigationScrollLock() {
  window.clearTimeout(navigationScrollTimer);
  navigationScrollTimer = 0;
  if (!navigationScrollLock) return;
  const readingLine = Math.min(window.innerHeight * .28, 260);
  const targetTop = navigationScrollLock.target?.getBoundingClientRect().top;
  if (targetTop > readingLine && navigationScrollLock.retries < 3) {
    navigationScrollLock.retries += 1;
    navigationScrollLock.target.scrollIntoView({ block: "start", behavior: "smooth" });
    navigationScrollTimer = window.setTimeout(releaseNavigationScrollLock, 1000);
    return;
  }
  navigationScrollLock = false;
  syncActiveChunk();
}

function holdNavigationSelection(target) {
  navigationScrollLock = { target, retries: 0 };
  window.clearTimeout(navigationScrollTimer);
  navigationScrollTimer = window.setTimeout(releaseNavigationScrollLock, 1400);
}

// An update whose bold title names a work item, as in `- **2026-10-23 — Delete list (W2.3):** …`, belongs to that item, nested lines included.
function workUpdates(doc) {
  const updates = doc?.chunks.find(c => /^updates$/i.test(c.title))?.markdown || "";
  const byItem = new Map();
  for (const entry of updates.split(/\n(?=[-*]\s)/)) {
    const ids = entry.match(/^[-*]\s+\*\*(.+?)\*\*/)?.[1]?.match(/[\w.-]+/g)?.map(token => token.replace(/\.$/, "")) || [];
    for (const id of new Set(ids)) byItem.set(id, [...(byItem.get(id) || []), entry.trim()]);
  }
  return byItem;
}

const workItemDialog = document.querySelector("#work-item-dialog");
// "item" reads one item; "graph" shows the whole work stream with the item outlined. Sticky across opens; `&graph=1`.
let workItemView = new URLSearchParams(location.search).get("graph") === "1" ? "graph" : "item";
const glyph = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS[name]}</svg>`;

// A dated update reads as a titled note; its nested bullets become the note's own list.
function workItemNote(entry) {
  const [, date = "", title = "", rest = ""] = entry.match(/^[-*]\s+\*\*(?:(\d{4}-\d{2}-\d{2})\s*[—–-]\s*)?(.+?):?\*\*:?\s*([\s\S]*)$/) || [];
  if (!title) return `<article class="work-item-note"><div class="markdown">${renderMarkdownSource(entry, state.selectedPath)}</div></article>`;
  const [first, ...nested] = rest.split("\n");
  const body = [first, "", ...nested.map(line => line.replace(/^ {2}/, ""))].join("\n");
  const when = date ? `<time datetime="${date}">${escapeHtml(formatDate(date))} · ${escapeHtml(relativeDate(date))}</time>` : "";
  return `<article class="work-item-note"><header><h4>${inlineMarkdown(title, state.selectedPath)}</h4>${when}</header><div class="markdown">${renderMarkdownSource(body, state.selectedPath)}</div></article>`;
}

// Lines elsewhere in the task that mention a work item without being filed under it (an update about something else, a
// finding), as the sentences that name it, grouped by where they appear. Fenced prompts and `Work item:` lines are skipped.
function workMentions(doc, id, own) {
  const token = new RegExp(`(?<![\\w.])${id.replace(/\./g, "\\.")}(?![\\w]|\\.\\w)`);
  const mentions = [];
  for (const chunk of doc.chunks) {
    if (/^work breakdown$/i.test(chunk.title)) continue;
    const updates = /^updates$/i.test(chunk.title);
    let source = chunk.title, skip = false, fenced = false;
    for (const line of chunk.markdown.split("\n")) {
      if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      const entry = updates && line.match(/^[-*]\s+\*\*(?:(\d{4}-\d{2}-\d{2})\s*[—–-]\s*)?(.+?):?\*\*/);
      if (entry) { source = entry[2]; skip = own.some((note) => note.startsWith(line.trim())); }
      if (skip || !token.test(line) || /^\s*Work item:/i.test(line)) continue;
      const text = line.replace(/^\s*(?:[-*]|\d+\.|#{1,6})\s+/, "").replace(/^\*\*[^*]+\*\*:?\s*/, "");
      const sentences = text.split(/(?<=[.;!?])\s+(?=[A-Z(`])/).filter((sentence) => token.test(sentence));
      const group = mentions.find((m) => m.source === source && m.chunkId === chunk.id) || mentions[mentions.push({ source, chunkId: chunk.id, date: entry?.[1] || mentions.at(-1)?.date || "", lines: [] }) - 1];
      group.lines.push(...sentences);
    }
  }
  return mentions.filter((m) => m.lines.length);
}

const markId = (html, id) => html.replace(new RegExp(`(?<![\\w.])(${id.replace(/\./g, "\\.")})(?![\\w]|\\.\\w)(?![^<]*>)`, "g"), "<mark>$1</mark>");

// The same dependency graph as the task's Work breakdown section (honoring its completed toggle unless the item itself is
// hidden there), with the open item outlined.
function workItemGraph(doc, id, noteCount) {
  const template = document.createElement("template");
  template.innerHTML = renderWorkBreakdown(doc.work, doc.nextActions, "dialog", "", noteCount);
  const graphs = template.content.querySelectorAll(".work-graph");
  const live = template.content.querySelector(".work-graph.is-live");
  const showDone = new URLSearchParams(location.search).get("done") === "1";
  const graph = !showDone && live?.querySelector(`[data-work-item="${CSS.escape(id)}"]`) ? live : graphs[graphs.length - 1];
  graph?.querySelector(`[data-work-item="${CSS.escape(id)}"]`)?.closest(".work-node, .work-group")?.classList.add("is-current");
  return graph?.outerHTML || '<p class="work-item-empty">No graph for this task.</p>';
}

// The work item dialog reads like a small inspector for one item: the task it belongs to on top, the whole breakdown as a
// rail on the left, and on the right the item's prerequisites, next action, updates filed under it, and other mentions.
// It stays open until Esc or ×; J/K walk every item, ← → the ones with updates, and ?item= reopens it on refresh.
function openWorkItem(id) {
  const doc = state.document, nodes = doc?.work?.nodes || [];
  const node = nodes.find(n => n.id === id);
  if (!node) return void (workItemDialog.open && workItemDialog.close());
  if (!openViewerDialog(workItemDialog)) return;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const updates = workUpdates(doc), notes = updates.get(id) || [];
  const mentions = workMentions(doc, id, notes);
  const kids = (parent) => nodes.filter(n => n.parent === parent);
  const depthOf = (n) => { let d = 0; for (let p = byId.get(n.parent); p; p = byId.get(p.parent)) d++; return d; };
  const leaves = nodes.filter(n => !kids(n.id).length);
  const doneLeaves = leaves.filter(n => n.status === "completed").length;
  const stepper = nodes.filter(n => updates.has(n.id)), at = stepper.indexOf(node), position = nodes.indexOf(node);
  // From an item without updates, ← → still go to the nearest items that have them.
  const neighbors = { prev: [...stepper].reverse().find(n => nodes.indexOf(n) < position), next: stepper.find(n => nodes.indexOf(n) > position) };
  const noteCount = (n) => updates.get(n.id)?.length ? `<span class="work-item-notes-count">${glyph("message-square")}${updates.get(n.id).length}</span>` : "";
  const ref = (n) => `<button type="button" class="work-item-ref" data-work-item="${escapeHtml(n.id)}"><code>${escapeHtml(n.id)}</code>${workStatusIcon(n, nodes)}<span>${escapeHtml(n.title)}</span>${noteCount(n)}</button>`;
  const rail = nodes.map(n => `<li><button type="button" class="work-item-rail-row${n === node ? " is-current" : ""}${isSettled(n.status) ? " is-settled" : ""}${kids(n.id).length ? " is-parent" : ""}" style="--depth:${depthOf(n)}" data-work-item="${escapeHtml(n.id)}"${n === node ? ' aria-current="true"' : ' tabindex="-1"'}><code>${escapeHtml(n.id)}</code>${workStatusIcon(n, nodes)}<span>${escapeHtml(n.title)}</span>${noteCount(n)}</button></li>`).join("");
  const relation = (label, list) => list.length ? `<dt>${label}</dt><dd>${list.map(ref).join("")}</dd>` : "";
  const relations = relation("After", node.deps.map(dep => byId.get(dep)).filter(Boolean)) + relation("Unblocks", nodes.filter(n => n.deps.includes(id))) + relation("Contains", kids(id));
  const actionIndex = doc.nextActions.findIndex(a => a.workItem === id);
  const action = doc.nextActions[actionIndex];
  const task = doc.task;
  const label = workStatusLabel(node, nodes);
  const frontier = node.ready ? "" : " is-off-frontier";
  const offFrontier = node.ready ? "" : ` title="${escapeHtml(`${id} is ${label.toLowerCase()}, not ready: the draft says what it still waits on`)}"`;
  const parent = byId.get(node.parent);
  const mentionHtml = mentions.map(m => `<li><button type="button" class="work-item-mention-source" data-work-jump="${escapeHtml(m.chunkId)}">${escapeHtml(m.source)}</button>${m.date ? `<time datetime="${m.date}">${escapeHtml(formatDate(m.date))}</time>` : ""}${m.lines.map(line => `<p>${markId(inlineMarkdown(line, state.selectedPath), id)}</p>`).join("")}</li>`).join("");
  workItemDialog.dataset.item = id;
  workItemDialog.innerHTML = `<header class="work-item-task">
      ${task ? `<button type="button" class="work-item-task-link" data-dialog-close title="${escapeHtml(`${task.id} · ${task.title} — back to the task`)}"><code>${escapeHtml(task.id)}</code><span>${escapeHtml(task.title)}</span></button><span class="work-item-task-status">${escapeHtml(TASK_STATUS_LABELS[task.status] || task.status)}</span>` : `<span class="work-item-task-link"><span>${escapeHtml(doc.title)}</span></span>`}
      <span class="work-item-progress" title="${doneLeaves} of ${leaves.length} work items completed"><span style="--done:${leaves.length ? doneLeaves / leaves.length : 0}"></span>${doneLeaves}/${leaves.length} done</span>
      <span class="work-item-views" role="tablist" aria-label="View">${[["item", "Item"], ["graph", "Graph"]].map(([view, label]) => `<button type="button" role="tab" data-work-view="${view}" aria-selected="${workItemView === view}" title="${label} (G)">${label}</button>`).join("")}</span>
      <span class="work-item-step"><span class="work-item-step-count">${at >= 0 ? `${at + 1} of ${stepper.length} with updates` : stepper.length ? `${stepper.length} with updates` : ""}</span>${["prev", "next"].map(dir => { const n = neighbors[dir]; return `<button type="button" class="work-item-icon-button" ${n ? `data-work-item="${escapeHtml(n.id)}" data-work-step="${dir}" title="${escapeHtml(`${n.id} · ${n.title}`)}"` : "disabled"} aria-label="${dir === "prev" ? "Previous" : "Next"} item with updates${n ? `: ${escapeHtml(n.id)}` : ""}" aria-keyshortcuts="${dir === "prev" ? "ArrowLeft" : "ArrowRight"}">${glyph("arrow-right")}</button>`; }).join("")}</span>
      <button type="button" class="work-item-icon-button" data-dialog-close aria-label="Close">${glyph("x")}</button>
    </header>
    <nav class="work-item-rail" aria-label="Work breakdown"><ol>${rail}</ol><p><span><kbd>J</kbd><kbd>K</kbd> items</span><span><kbd>←</kbd><kbd>→</kbd> updates</span><span><kbd>G</kbd> graph</span></p></nav>
    ${workItemView === "graph" ? `<div class="work-item-main is-graph" tabindex="-1"><div class="work-item-graph" tabindex="0" aria-label="Work stream graph">${workItemGraph(doc, id, (key) => updates.get(key)?.length || 0)}</div>${workGraphTools}</div>` : `<div class="work-item-main" tabindex="-1">
      <header class="work-item-heading">
        <p class="work-item-kicker"><code>${escapeHtml(node.id)}</code>${workStatusIcon(node, nodes)}<span>${escapeHtml(label)}</span>${parent ? `<span class="work-item-in">in</span><button type="button" class="work-item-parent" data-work-item="${escapeHtml(parent.id)}" title="${escapeHtml(`${parent.id} · ${parent.title}`)}">${escapeHtml(parent.id)} ${escapeHtml(parent.title)}</button>` : ""}</p>
        <h2 id="work-item-title">${escapeHtml(node.title)}</h2>
        <div class="work-item-agent">
          <button type="button" class="work-item-agent-button${frontier}" data-work-agent="run"${offFrontier}>${glyph("play")}Send to agent</button>
          <button type="button" class="work-item-agent-button is-secondary${frontier}" data-work-agent="update"${offFrontier}>${glyph("pen-line")}Update with agent</button>
        </div>
      </header>
      ${relations ? `<dl class="work-item-relations">${relations}</dl>` : ""}
      ${action ? `<section class="work-item-section"><h3>Next action</h3><div class="work-item-action"><p class="work-item-action-title">${escapeHtml(action.title)}</p><p class="work-item-action-prompt">${inlineMarkdown(action.prompt.replace(/\s+/g, " "), state.selectedPath)}</p></div></section>` : ""}
      <section class="work-item-section"><h3>Updates <span>${notes.length}</span></h3>${notes.length ? notes.map(workItemNote).join("") : `<p class="work-item-empty">None filed yet. An update titled “… (${escapeHtml(id)}):” lands here.</p>`}</section>
      ${mentions.length ? `<section class="work-item-section"><h3>Also mentioned <span>${mentions.reduce((sum, m) => sum + m.lines.length, 0)}</span></h3><ul class="work-item-mentions">${mentionHtml}</ul></section>` : ""}
    </div>`}`;
  const main = workItemDialog.querySelector(".work-item-main");
  main.scrollTop = 0;
  // Keys (J/K, ← →, G, space to scroll) need focus inside; after the composer closes it would otherwise sit on the page.
  if (!workItemDialog.contains(document.activeElement)) main.focus({ preventScroll: true });
  // Scroll only the rail and graph panes; scrollIntoView would also nudge the page under the modal.
  const centerIn = (pane, target) => { if (!pane || !target) return; const p = pane.getBoundingClientRect(), t = target.getBoundingClientRect(); pane.scrollTop += t.top - p.top - (p.height - t.height) / 2; pane.scrollLeft += t.left - p.left - (p.width - t.width) / 2; };
  centerIn(workItemDialog.querySelector(".work-item-rail ol"), workItemDialog.querySelector(".work-item-rail-row.is-current"));
  showWorkGraph(workItemDialog.querySelector(".work-item-graph"));
  const url = new URL(location.href);
  url.searchParams.set("item", id);
  if (workItemView === "graph") url.searchParams.set("graph", "1"); else url.searchParams.delete("graph");
  history.replaceState(null, "", url);
}

// Graph view pans by drag and zooms by wheel around the cursor, or by the corner toolbar and its keys (− + 0 F C).
// Overpan keeps only a sliver of the graph on screen, so either edge can sit at the far side of the pane.
const workGraphView = { scale: 1, x: 0, y: 0 };
let workGraphDrag = null;
function applyWorkGraphView(pane) {
  const graph = pane?.querySelector(".work-graph");
  if (!graph) return;
  const keep = 60, s = workGraphView.scale;
  workGraphView.x = Math.min(pane.clientWidth - keep, Math.max(keep - graph.offsetWidth * s, workGraphView.x));
  workGraphView.y = Math.min(pane.clientHeight - keep, Math.max(keep - graph.offsetHeight * s, workGraphView.y));
  graph.style.transform = `translate(${workGraphView.x}px, ${workGraphView.y}px) scale(${s})`;
  const zoom = pane.parentElement.querySelector("[data-graph-zoom]");
  if (zoom) zoom.textContent = `${Math.round(s * 100)}%`;
}
// Each render keeps the zoom: a graph that fits at it is centered whole (the open item is outlined); a larger one centers the item.
function showWorkGraph(pane) {
  const graph = pane?.querySelector(".work-graph");
  if (!graph) return;
  const s = workGraphView.scale, w = graph.offsetWidth * s, h = graph.offsetHeight * s;
  if (w > pane.clientWidth || h > pane.clientHeight) return centerWorkGraph(pane);
  Object.assign(workGraphView, { x: (pane.clientWidth - w) / 2, y: (pane.clientHeight - h) / 2 });
  applyWorkGraphView(pane);
}
// Zooms by `factor` keeping the pane point (x, y) still; the pane center when no point is given.
function zoomWorkGraph(pane, factor, x = pane.clientWidth / 2, y = pane.clientHeight / 2) {
  const next = Math.min(2.5, Math.max(.1, workGraphView.scale * factor)), ratio = next / workGraphView.scale;
  Object.assign(workGraphView, { scale: next, x: x - (x - workGraphView.x) * ratio, y: y - (y - workGraphView.y) * ratio });
  applyWorkGraphView(pane);
}
// Fit shows the whole graph, never above 100%, so small graphs stay at reading size.
function fitWorkGraph(pane) {
  const graph = pane?.querySelector(".work-graph");
  if (!graph) return;
  const pad = 24, s = Math.max(.1, Math.min(1, (pane.clientWidth - pad * 2) / graph.offsetWidth, (pane.clientHeight - pad * 2) / graph.offsetHeight));
  Object.assign(workGraphView, { scale: s, x: (pane.clientWidth - graph.offsetWidth * s) / 2, y: (pane.clientHeight - graph.offsetHeight * s) / 2 });
  applyWorkGraphView(pane);
}
const workGraphActions = {
  "zoom-out": (pane) => zoomWorkGraph(pane, 1 / 1.25),
  "zoom-in": (pane) => zoomWorkGraph(pane, 1.25),
  actual: (pane) => zoomWorkGraph(pane, 1 / workGraphView.scale),
  fit: fitWorkGraph,
  item: centerWorkGraph,
};
const workGraphKeys = { "-": "zoom-out", "_": "zoom-out", "=": "zoom-in", "+": "zoom-in", "0": "actual", f: "fit", c: "item" };
const workGraphTools = `<div class="work-graph-tools" role="toolbar" aria-label="Graph zoom">
  <button type="button" data-graph-action="zoom-out" title="Zoom out (−)" aria-label="Zoom out">−</button>
  <button type="button" class="work-graph-zoom" data-graph-action="actual" title="Reset to 100% (0)" aria-label="Reset zoom to 100%"><span data-graph-zoom>100%</span></button>
  <button type="button" data-graph-action="zoom-in" title="Zoom in (+)" aria-label="Zoom in">+</button>
  <button type="button" data-graph-action="fit" title="Fit the whole graph (F)">Fit</button>
  <button type="button" data-graph-action="item" title="Center the open item (C)">Item</button>
</div>`;
function centerWorkGraph(pane) {
  const graph = pane?.querySelector(".work-graph"), current = graph?.querySelector(".is-current");
  if (!current) return applyWorkGraphView(pane);
  const g = graph.getBoundingClientRect(), c = current.getBoundingClientRect();
  // Both rects are already scaled, so their difference is the on-screen offset the translate must cancel.
  workGraphView.x = pane.clientWidth / 2 - (c.left - g.left + c.width / 2);
  workGraphView.y = pane.clientHeight / 2 - (c.top - g.top + c.height / 2);
  applyWorkGraphView(pane);
}
workItemDialog.addEventListener("wheel", (event) => {
  const pane = event.target.closest(".work-item-graph");
  if (!pane) return;
  event.preventDefault();
  const p = pane.getBoundingClientRect();
  zoomWorkGraph(pane, Math.exp(-event.deltaY * (event.ctrlKey ? .01 : .002)), event.clientX - p.left, event.clientY - p.top);
}, { passive: false });
workItemDialog.addEventListener("dblclick", (event) => {
  const pane = event.target.closest(".work-item-graph");
  if (pane && !event.target.closest("[data-work-item]")) fitWorkGraph(pane);
});
workItemDialog.addEventListener("pointerdown", (event) => {
  const pane = event.target.closest(".work-item-graph");
  if (!pane || event.button !== 0) return;
  workGraphDrag = { pane, id: event.pointerId, startX: event.clientX, startY: event.clientY, x: workGraphView.x, y: workGraphView.y, moved: false };
});
workItemDialog.addEventListener("pointermove", (event) => {
  const drag = workGraphDrag;
  if (!drag || event.pointerId !== drag.id) return;
  const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) { drag.moved = true; drag.pane.setPointerCapture(drag.id); drag.pane.classList.add("is-panning"); }
  Object.assign(workGraphView, { x: drag.x + dx, y: drag.y + dy });
  applyWorkGraphView(drag.pane);
});
const endWorkGraphDrag = (event) => {
  if (!workGraphDrag || event.pointerId !== workGraphDrag.id) return;
  workGraphDrag.pane.classList.remove("is-panning");
  // A drag that ends over a node must not open it. Chrome may send no click after a captured drag, so the guard lasts one task.
  if (workGraphDrag.moved) {
    const swallow = (e) => e.stopPropagation();
    workItemDialog.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => workItemDialog.removeEventListener("click", swallow, { capture: true }));
  }
  workGraphDrag = null;
};
workItemDialog.addEventListener("pointerup", endWorkGraphDrag);
workItemDialog.addEventListener("pointercancel", endWorkGraphDrag);

// Send and Update open the composer for the item; the dialog closes first so the composer is not inert behind it.
function openWorkComposer(id, mode) {
  const nodes = state.document?.work?.nodes || [];
  const node = nodes.find(n => n.id === id);
  if (!node) return;
  workItemDialog.close();
  const trigger = elements.chunks.querySelector(`.work-tree [data-work-item="${CSS.escape(id)}"]`);
  openComposer({ key: `work:${mode}:${id}`, scope: "work", mode, node, nodes, action: state.document.nextActions.find(a => a.workItem === id), title: `${mode === "update" ? "Update" : "Advance"} ${id}: ${node.title}` }, trigger);
}

workItemDialog.addEventListener("click", (event) => {
  const agent = event.target.closest("[data-work-agent]");
  if (agent) {
    event.stopPropagation(); // the document's outside-click handler would close the composer this click opens
    return openWorkComposer(workItemDialog.dataset.item, agent.dataset.workAgent);
  }
  const graphAction = event.target.closest("[data-graph-action]");
  if (graphAction) return workGraphActions[graphAction.dataset.graphAction](workItemDialog.querySelector(".work-item-graph"));
  const view = event.target.closest("[data-work-view]");
  if (view) {
    workItemView = view.dataset.workView;
    return openWorkItem(workItemDialog.dataset.item);
  }
  const item = event.target.closest("[data-work-item]");
  // Picking a node in the graph reads that item; the rail and stepper keep the current view.
  if (item?.closest(".work-item-graph")) workItemView = "item";
  if (item) return openWorkItem(item.dataset.workItem);
  const jump = event.target.closest("[data-work-jump]");
  const documentLink = event.target.closest(".markdown-document-link");
  // A link that opens a new tab leaves the dialog where it was; one that navigates here closes it.
  if (!jump && !documentLink && !event.target.closest("[data-dialog-close], a[href]:not([target=_blank])")) return;
  workItemDialog.close();
  if (jump) document.getElementById(jump.dataset.workJump)?.scrollIntoView({ block: "start", behavior: "instant" });
  if (documentLink) {
    event.preventDefault();
    selectDocument(documentLink.dataset.documentPath, { historyMode: "push", anchor: documentLink.dataset.documentAnchor });
  }
});
workItemDialog.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.target.closest("input, textarea")) return;
  if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    workItemDialog.querySelector(`[data-work-step="${event.key === "ArrowLeft" ? "prev" : "next"}"]`)?.click();
  }
  if (event.key.toLowerCase() === "g") {
    event.preventDefault();
    workItemView = workItemView === "graph" ? "item" : "graph";
    return openWorkItem(workItemDialog.dataset.item);
  }
  const graphKey = workItemView === "graph" && workGraphKeys[event.key.toLowerCase()];
  if (graphKey) {
    event.preventDefault();
    return workGraphActions[graphKey](workItemDialog.querySelector(".work-item-graph"));
  }
  const walk = { j: 1, k: -1 }[event.key.toLowerCase()];
  if (!walk) return;
  event.preventDefault();
  const nodes = state.document?.work?.nodes || [];
  const next = nodes[nodes.findIndex(n => n.id === workItemDialog.dataset.item) + walk];
  if (next) openWorkItem(next.id);
});
workItemDialog.addEventListener("close", () => {
  const url = new URL(location.href);
  url.searchParams.delete("item");
  url.searchParams.delete("graph");
  history.replaceState(null, "", url);
  const previous = dialogReturnFocus.get(workItemDialog);
  if (previous?.isConnected && previous.getClientRects().length) previous.focus();
});

function chunkBody(doc, chunk) {
  return actionGroups.has(chunk.id)
    ? `${(doc.actionWarnings || []).map(w => `<p class="work-warning">${escapeHtml(w)}</p>`).join("")}${renderActions(actionGroups.get(chunk.id), chunk.id)}`
    : /^work breakdown$/i.test(chunk.title)
    ? renderWorkBreakdown(doc.work, doc.nextActions, doc.chunks.find(c => /^next actions$/i.test(c.title))?.id || "work", chunk.id, (id) => workUpdates(doc).get(id)?.length || 0, new URLSearchParams(location.search).get("done") === "1")
    : doc.format === "text"
    ? `<pre class="plain-text">${escapeHtml(chunk.markdown)}</pre>`
    : (/^updates$/i.test(chunk.title) && renderUpdates(chunk.markdown, state.selectedPath))
      || `<div class="markdown">${renderMarkdownSource(chunk.markdown, state.selectedPath)}</div>`;
}

// The diagrams the page embeds, in page order, then the task's other `.draft` files (which the list from /api/diagrams knows).
function dockDiagrams(doc) {
  const known = new Map((state.diagrams || []).map((diagram) => [diagram.path, diagram]));
  const embedded = [...new Set([...elements.chunks.querySelectorAll(".chunk-card [data-diagram]")].map((trigger) => trigger.dataset.diagram))];
  const taskId = doc.task?.id || doc.path.match(/^tasks\/(TASK-\d{4})-assets\//)?.[1];
  const rest = taskId ? (state.diagrams || []).filter((diagram) => diagram.task === taskId && !embedded.includes(diagram.path)).map((diagram) => diagram.path) : [];
  return [...embedded.map((path) => ({ path, embedded: true })), ...rest.map((path) => ({ path, embedded: false }))]
    .map((item) => ({ ...item, title: known.get(item.path)?.title || elements.chunks.querySelector(`[data-diagram="${CSS.escape(item.path)}"] img`)?.alt || item.path.split("/").pop().replace(/\.draft$/, "") }));
}

// Panels repeat chunk content, so their copies drop ids (SVG markers excepted) to keep anchors and jumps unique.
function renderDocumentDock(doc) {
  if (doc.format === "text") return;
  const links = collectLinks(elements.chunks, state.documents, doc.path);
  elements.chunks.insertAdjacentHTML("afterbegin", renderDock({ doc, documents: state.documents, links, body: chunk => chunkBody(doc, chunk), diagrams: dockDiagrams(doc) }));
  for (const node of elements.chunks.querySelectorAll(".doc-dock-panel-body [id]")) if (node.localName !== "marker") node.removeAttribute("id");
  syncDockStuck();
  loadLinkMetadata(doc);
}

// Titles and states for GitHub, Linear and Jira links arrive after render; rows keep their fallback text until then.
async function loadLinkMetadata(doc) {
  const keys = [...new Set([...elements.chunks.querySelectorAll("a[href]")].map(link => link.dataset.metaKey || metadataKey(link.href)).filter(Boolean))];
  if (!keys.length) return;
  try {
    const response = await fetch("/api/link-metadata", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys }) });
    if (!response.ok || state.document !== doc) return;
    applyLinkMetadata(elements.chunks, (await response.json()).metadata || {});
  } catch {
    // Offline or unauthenticated sources leave the plain IDs in place.
  }
}

function syncDockStuck() {
  const dock = elements.chunks.querySelector("[data-doc-dock]");
  dock?.classList.toggle("is-stuck", dock.getBoundingClientRect().top <= 0.5 && window.scrollY > 0);
}

const dirname = (path) => path.slice(0, path.lastIndexOf("/"));

// The object a nested file belongs to: a task's assets folder → the task, a day's folder → that day's plan,
// a topic folder → its README. Walks up so deeper files (`linear-review/source-session.md`) still find it.
function parentDocument(path) {
  const task = path.match(/^tasks\/(TASK-\d{4})-assets\//);
  const candidates = task ? [`tasks/${task[1]}.md`] : [];
  for (let dir = dirname(path); dir.includes("/"); dir = dirname(dir)) candidates.push(`${dir}/plan.md`, `${dir}/README.md`);
  return candidates.filter((candidate) => candidate !== path).map((candidate) => state.documents.find((doc) => doc.path === candidate)).find(Boolean);
}

// Every crumb goes somewhere: a view, a parent document, a sibling, or the clipboard. The current file is the copy target.
const crumbSeparator = `<span class="crumb-sep" aria-hidden="true">/</span>`;
const viewCrumb = (view, label) => `<a class="crumb" href="?view=${view}" data-crumb-view="${view}">${escapeHtml(label)}</a>`;
const docCrumb = (path, label, current = false) => current
  ? `<a class="crumb is-current" href="${escapeHtml(documentHref(path, ""))}" aria-current="page">${escapeHtml(label)}</a>`
  : `<a class="crumb" href="${escapeHtml(documentHref(path, ""))}" data-crumb-path="${escapeHtml(path)}">${escapeHtml(label)}</a>`;
const copyCrumb = (value, label = value) => `<button class="crumb crumb-copy" type="button" data-copy-value="${escapeHtml(value)}" title="Copy ${escapeHtml(value)}">${escapeHtml(label)}</button>`;

const dailyRank = (path) => /^daily\/\d{4}\/\d{2}\/\d{2}\/plan\.md$/.test(path) ? 0 : 1;

function documentBreadcrumb(doc) {
  if (doc.task) return [viewCrumb("tasks", "Tasks"), copyCrumb(doc.task.id)].join(crumbSeparator) + statusPill(doc.task, doc.path);
  const daily = doc.path.match(/^daily\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (daily) {
    const key = `${daily[1]}-${daily[2]}-${daily[3]}`;
    const siblings = state.documents.filter((candidate) => candidate.path.startsWith(daily[0]))
      .sort((a, b) => dailyRank(a.path) - dailyRank(b.path) || a.path.localeCompare(b.path));
    const label = parseDateKey(key)?.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) || key;
    // The plan is a tab; the day's other files sit behind one "+N" menu so long days never crowd the crumb row.
    const pinned = siblings.filter((sibling) => dailyRank(sibling.path) === 0);
    const extra = siblings.filter((sibling) => dailyRank(sibling.path) === 1);
    const extraCurrent = extra.some((sibling) => sibling.path === doc.path);
    const menu = extra.length
      ? `<button class="crumb${extraCurrent ? " is-current" : ""}" type="button" popovertarget="day-files" style="anchor-name: --day-files">${extraCurrent ? escapeHtml(dailyDocumentLabel(doc)) : `+${extra.length} ${extra.length === 1 ? "file" : "files"}`} <span aria-hidden="true">⌄</span></button>
        <div id="day-files" class="day-files-menu" popover style="position-anchor: --day-files">${extra.map((sibling) => docCrumb(sibling.path, dailyDocumentLabel(sibling), sibling.path === doc.path)).join("")}</div>`
      : "";
    const tabs = siblings.length > 1 ? `<span class="crumb-siblings">${pinned.map((sibling) => docCrumb(sibling.path, sibling.kind.toLowerCase(), sibling.path === doc.path)).join("")}${menu}</span>` : "";
    const plan = siblings.find((sibling) => sibling.path.endsWith("/plan.md"));
    return (plan ? docCrumb(plan.path, label, plan.path === doc.path) : `<span class="crumb">${escapeHtml(label)}</span>`) + tabs;
  }
  const parent = parentDocument(doc.path);
  if (parent) {
    const parentLabel = parent.task ? parent.task.id : parent.date ? `${parent.kind} · ${parent.date}` : parent.title;
    return [docCrumb(parent.path, parentLabel), copyCrumb(doc.path, doc.path.slice(dirname(parent.path).length + 1).replace(/^TASK-\d{4}-assets\//, ""))].join(crumbSeparator);
  }
  const root = doc.path.startsWith("plans/") ? viewCrumb("topics", "Topics") : doc.path.startsWith("reference/") ? viewCrumb("reference", "Reference") : "";
  return [root, copyCrumb(doc.path, doc.path.replace(/^(plans|reference)\//, ""))].filter(Boolean).join(crumbSeparator);
}

// A task and its documents read in order: ‹ 3 of 14 › beside the crumbs, and P / N, wrapping from the last to the first.
function documentStepper(doc) {
  const sequence = taskDocumentSequence(doc.path, state.documents);
  const index = sequence.findIndex((candidate) => candidate.path === doc.path);
  if (sequence.length < 2 || index < 0) return "";
  const step = (direction, glyph, label, key) => {
    const target = sequence.at((index + direction) % sequence.length);
    return `<button class="crumb doc-step" type="button" data-doc-step="${direction}" aria-label="${label} (${key}): ${escapeHtml(target.title)}">${glyph}</button>`;
  };
  return `<span class="doc-stepper">${step(-1, "‹", "Previous document", "P")}<span>${index + 1} of ${sequence.length}</span>${step(1, "›", "Next document", "N")}</span>`;
}
function stepTaskDocument(direction) {
  const path = state.view === "document" && state.selectedPath;
  const sequence = path ? taskDocumentSequence(path, state.documents) : [];
  const index = sequence.findIndex((candidate) => candidate.path === path);
  if (index < 0) return showNotice("N and P step through a task's documents; open a task or one of its documents first.");
  selectDocument(sequence.at((index + direction) % sequence.length).path);
}

function renderDocument() {
  const doc = state.document;
  if (!doc) return;
  state.view = "document";
  resetPageNavigation();
  elements.title.textContent = doc.title;
  elements.meta.innerHTML = documentBreadcrumb(doc) + documentStepper(doc);
  elements.taskPathValue.textContent = doc.path;
  elements.copyTaskPath.dataset.copyPath = doc.absolutePath || doc.path;
  elements.copyTaskPath.title = `Copy ${doc.absolutePath || doc.path}`;
  elements.taskDocumentPath.hidden = false;
  elements.count.textContent = doc.format === "text" ? "Plain text" : "";
  prepareChunkOutlines(doc);
  actionGroups.clear();
  for (const chunk of doc.chunks) {
    if (/^(next actions|next steps)$/i.test(chunk.title)) {
      actionGroups.set(chunk.id, /^next steps$/i.test(chunk.title) ? [...doc.nextActions, ...doc.scheduledActions] : doc.nextActions);
    }
  }
  elements.chunks.innerHTML = doc.chunks.map((chunk, index) => `<article class="chunk-card" id="${chunk.id}" data-source-anchor="${escapeHtml(chunk.anchor)}">
    <div class="chunk-heading">
      <span class="chunk-index">${String(index + 1).padStart(2, "0")}</span>
      <h2>${escapeHtml(chunk.title)}</h2>
      <span class="chunk-actions"><button class="handoff-button" type="button" data-chunk-copy="${chunk.id}" aria-label="Copy section as Markdown">Copy</button><button class="handoff-button" type="button" data-chunk-copy="${chunk.id}" data-copy-as="prompt" aria-label="Copy the ${escapeHtml(agentName())} prompt for this section">Copy prompt</button><button class="handoff-button" type="button" data-chunk-id="${chunk.id}" aria-haspopup="dialog" aria-controls="handoff-popover" aria-expanded="${state.openComposer === `chunk:${chunk.id}`}">Open in ${agentName()}</button></span>
    </div>
    ${chunkBody(doc, chunk)}
  </article>`).join("");
  markDocumentChanges();
  renderDocumentDock(doc);
  enhanceTaskReferences();
  state.activeChunkId = doc.chunks[0]?.id || "";
  state.activeOutlinePath = [];
  for (const chunk of doc.chunks) {
    const headings = elements.chunks.querySelectorAll(`#${chunk.id} .markdown h3, #${chunk.id} .markdown h4`);
    const outline = chunkOutlines.get(chunk.id);
    headings.forEach((heading, index) => {
      const node = outline?.flat[index];
      if (node) heading.dataset.outlineKey = node.key;
    });
  }
  renderChunkNavigation();
  syncGlobalHandoff();
  if (state.openComposer === "global") {
    handoffTrigger = elements.globalHandoff;
    handoffTrigger.setAttribute("aria-expanded", "true");
  } else if (state.openComposer === "document") {
    handoffTrigger = elements.documentHandoff;
    handoffTrigger?.setAttribute("aria-expanded", "true");
  } else if (state.openComposer?.startsWith("action:")) {
    const [, key, index] = state.openComposer.split(":");
    handoffTrigger = elements.chunks.querySelector(`[data-action-key="${key}"][data-action-index="${index}"]`);
    handoffTrigger?.setAttribute("aria-expanded", "true");
  } else if (state.openComposer?.startsWith("chunk:")) {
    const chunkId = state.openComposer.slice("chunk:".length);
    handoffTrigger = elements.chunks.querySelector(`.handoff-button[data-chunk-id="${chunkId}"]`);
    handoffTrigger?.setAttribute("aria-expanded", "true");
  }
  syncActiveChunk();
}

function enhanceTaskReferences() {
  for (const link of elements.chunks.querySelectorAll('.markdown-document-link[data-document-path^="tasks/"]:not(.daily-action-more, .dock-link)')) {
    const doc = state.documents.find((candidate) => candidate.path === link.dataset.documentPath);
    if (!doc?.task) continue;
    const before = link.previousSibling;
    const leadsItem = link.parentElement.matches("li, header") && (!before || (before.nodeType === Node.TEXT_NODE && !before.textContent.trim()));
    const taskNumber = doc.task.id.replace(/^TASK-/i, "");
    link.classList.add("task-reference", `task-reference-status-${doc.task.status}`, leadsItem ? "task-reference-item" : "task-reference-inline");
    link.setAttribute("aria-label", `Open ${doc.task.id}: ${doc.task.title}. ${doc.task.summary}`);
    link.removeAttribute("data-tip");
    link.innerHTML = `${SERVICE_ICONS.task}&#8288;<span class="task-reference-id">${escapeHtml(leadsItem ? taskNumber : doc.task.id)}</span>${leadsItem ? `<span class="task-reference-description">${escapeHtml(doc.task.title)}</span>` : ""}`;
    // Chats live on the task page; in lists, the trailing "— note" becomes a quiet second line.
    if (leadsItem && link.parentElement.matches("li") && !link.nextElementSibling?.matches(".task-reference-note")) {
      const note = document.createElement("span");
      note.className = "task-reference-note";
      while (link.nextSibling && !(link.nextSibling.nodeType === Node.ELEMENT_NODE && link.nextSibling.matches("ul, ol"))) note.append(link.nextSibling);
      if (note.firstChild?.nodeType === Node.TEXT_NODE) note.firstChild.textContent = note.firstChild.textContent.replace(/^[\s\u2060]*[—–-]\s*/, "");
      if (note.textContent.trim()) link.after(note);
    }
  }
}

function setActiveChunk(chunkId, outlinePath = null) {
  const chunkChanged = state.activeChunkId !== chunkId;
  const nextPath = outlinePath || (chunkChanged ? [] : state.activeOutlinePath || []);
  const pathChanged = nextPath.join("/") !== (state.activeOutlinePath || []).join("/");
  state.activeChunkId = chunkId;
  state.activeOutlinePath = nextPath;
  syncGlobalHandoff();
  if (chunkChanged || pathChanged) renderChunkNavigation();
}

function syncGlobalHandoff() {
  elements.globalHandoff.disabled = false;
  elements.globalHandoff.title = `Open a new ${agentName()} draft, about the open file if any (C)`;
  elements.globalHandoff.setAttribute("aria-label", `Open a new ${agentName()} draft, about the open file if any, C`);
}

function openGlobalComposer() {
  if (state.openComposer === "global" && elements.handoffPopover.matches(":popover-open")) {
    elements.handoffPopover.querySelector("textarea")?.focus();
    return;
  }
  openComposer({ key: "global", scope: "global", title: `New ${agentName()} task` }, elements.globalHandoff);
}

function openDocumentComposer() {
  if (!state.document) return;
  openComposer({ key: "document", scope: "document", title: state.document.title }, elements.documentHandoff);
}

let scrollSpyFrame = 0;
function syncActiveChunk() {
  if (navigationScrollLock) return;
  window.cancelAnimationFrame(scrollSpyFrame);
  scrollSpyFrame = window.requestAnimationFrame(() => {
    const cards = [...elements.chunks.querySelectorAll(".chunk-card")];
    if (!cards.length) return;
    const readingLine = Math.min(window.innerHeight * .28, 260);
    let active = cards[0];
    for (const card of cards) {
      if (card.getBoundingClientRect().top <= readingLine) active = card;
      else break;
    }
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) active = cards.at(-1);
    const activeHeading = [...active.querySelectorAll("[data-outline-key]")].reduce((current, heading) => (
      heading.getBoundingClientRect().top <= readingLine ? heading : current
    ), null);
    const outline = chunkOutlines.get(active.id);
    setActiveChunk(active.id, activeHeading ? outline?.paths.get(activeHeading.dataset.outlineKey) || [] : []);
  });
}

function updateViewerUrl(path, anchor, historyMode) {
  if (historyMode === "none") return;
  const url = new URL(location.href);
  // Showing completed work carries from document to document until it is unchecked.
  url.search = new URLSearchParams({ path, ...(url.searchParams.get("done") === "1" ? { done: "1" } : {}) });
  url.hash = anchor || "";
  history[historyMode === "push" ? "pushState" : "replaceState"](null, "", url);
}

function locationAnchor() {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return location.hash.slice(1);
  }
}

function scrollToDocumentAnchor(anchor, behavior = "instant") {
  for (const card of elements.chunks.querySelectorAll(".link-target")) card.classList.remove("link-target");
  if (!anchor) {
    window.scrollTo({ top: 0, behavior });
    return;
  }

  const target = document.getElementById(anchor)
    || [...elements.chunks.querySelectorAll(".chunk-card")].find((card) => card.dataset.sourceAnchor === anchor);
  if (!target) {
    window.scrollTo({ top: 0, behavior });
    showNotice(`Opened the document, but could not find “${anchor}”.`, true);
    return;
  }

  const card = target.closest(".chunk-card") || target;
  card.classList.add("link-target");
  target.scrollIntoView({ block: "start", behavior });
  setActiveChunk(card.id);
}

async function selectDocument(path, { historyMode = "push", anchor = "" } = {}) {
  if (state.openComposer && elements.handoffPopover.matches(":popover-open") && !requestComposerClose()) return;
  try {
    elements.chunks.setAttribute("aria-busy", "true");
    const response = await fetch(`/api/document?path=${encodeURIComponent(path)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not open that document.");
    if (state.selectedPath !== path) changeMarks.delete(state.selectedPath); // you've seen what changed there
    state.selectedPath = path;
    state.document = body;
    closeComposer();
    // Opening a document closes an open image viewer; a live refresh of the same document (refreshFromMarkdown) leaves it open.
    if (elements.imageViewer.open) closeImageViewer(false);
    renderLibrary();
    elements.chunks.classList.remove("is-live-refresh");
    renderDocument();
    updateViewerUrl(path, anchor, historyMode);
    window.requestAnimationFrame(() => scrollToDocumentAnchor(anchor));
    const item = new URLSearchParams(location.search).get("item");
    if (item) openWorkItem(item);
    else if (workItemDialog.open) workItemDialog.close();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    elements.chunks.removeAttribute("aria-busy");
  }
}

async function refreshFromMarkdown(changedPaths) {
  const currentPath = state.selectedPath;
  const currentChanged = changedPaths.has(currentPath);
  // Live refreshes keep the reader where they are: pin the first card still on screen to its current offset.
  const scrollY = window.scrollY;
  const pinned = [...elements.chunks.querySelectorAll(".chunk-card")].find((card) => card.getBoundingClientRect().bottom > 0);
  const pinnedId = pinned?.id;
  const pinnedTop = pinned?.getBoundingClientRect().top;
  const openPanel = elements.chunks.querySelector(".doc-dock-panel:popover-open")?.id;
  const openSource = elements.chunks.querySelector('.dock-source[aria-selected="true"]')?.dataset.dockSource;
  const keepScroll = (render) => { render(); window.scrollTo({ top: scrollY, behavior: "instant" }); };

  try {
    const libraryResponse = await fetch("/api/documents");
    const libraryBody = await libraryResponse.json();
    if (!libraryResponse.ok) throw new Error(libraryBody.error || "Could not refresh the document list.");
    state.documents = libraryBody.documents;
    updateNavCounts();
    loadWaiting();

    if (state.view in LIBRARY_VIEWS) {
      renderLibrary();
      keepScroll(() => renderLibraryPage(state.view));
      return;
    }

    if (state.view === "tasks") {
      renderLibrary();
      keepScroll(renderTasksPage);
      return;
    }

    if (state.view === "code" || state.view === "issues" || state.view === "slack") {
      renderLibrary();
      return;
    }

    if (state.view === "activity") {
      renderLibrary();
      renderActivity();
      return;
    }

    const taskChanged = [...changedPaths].some((path) => path.startsWith("tasks/"));
    if (!currentChanged && !taskChanged) {
      renderLibrary();
      return;
    }

    const documentResponse = await fetch(`/api/document?path=${encodeURIComponent(currentPath)}`);
    const documentBody = await documentResponse.json();
    if (!documentResponse.ok) {
      const fallback = state.documents.find((doc) => doc.path === libraryBody.defaultPath)?.path || state.documents[0]?.path;
      if (fallback) await selectDocument(fallback, { historyMode: "replace" });
      return;
    }

    state.document = documentBody;
    if (state.openComposer?.startsWith("chunk:") && !documentBody.chunks.some((chunk) => `chunk:${chunk.id}` === state.openComposer)) state.openComposer = null;
    renderLibrary();
    elements.chunks.classList.add("is-live-refresh");
    renderDocument();
    const newPinned = pinnedId ? document.getElementById(pinnedId) : null;
    if (newPinned && pinnedTop != null) window.scrollBy({ top: newPinned.getBoundingClientRect().top - pinnedTop, behavior: "instant" });
    else window.scrollTo({ top: scrollY, behavior: "instant" });
    if (workItemDialog.open) openWorkItem(workItemDialog.dataset.item);
    if (openPanel) {
      document.getElementById(openPanel)?.showPopover();
      elements.chunks.querySelector(`[data-dock-source="${openSource}"]`)?.click();
    }

    window.requestAnimationFrame(syncActiveChunk);
  } catch (error) {
    showNotice(`Live refresh failed: ${error.message}`, true);
  }
}

let liveRefreshTimer = 0;
const pendingMarkdownPaths = new Set();
function scheduleMarkdownRefresh(path) {
  pendingMarkdownPaths.add(path);
  window.clearTimeout(liveRefreshTimer);
  liveRefreshTimer = window.setTimeout(() => {
    const changedPaths = new Set(pendingMarkdownPaths);
    pendingMarkdownPaths.clear();
    refreshFromMarkdown(changedPaths);
  }, 120);
}

// The viewer's own version: a corner button appears when origin has new commits (pull and restart), the server predates
// the checkout (restart), or this page predates the server (reload). Checked on load and every five minutes.
const updateButton = document.querySelector("#viewer-update");
let pageHead = "";
async function checkViewerVersion() {
  const version = await fetch("/api/version").then((response) => response.json()).catch(() => null);
  if (!version?.head || updateButton.disabled) return;
  pageHead ||= version.running;
  const [label, title] = version.behind ? [`Update viewer · ${version.behind} new`, "Pull the latest viewer and restart it"]
    : version.running !== version.head ? ["Restart viewer", "The server is running an older commit than the checkout"]
    : pageHead !== version.running ? ["Reload viewer", "This page loaded an older version than the server runs"] : [];
  updateButton.hidden = !label;
  if (!label) return;
  updateButton.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS["refresh-cw"]}</svg><span></span>`;
  updateButton.querySelector("span").textContent = label;
  updateButton.title = title;
  updateButton.dataset.action = version.behind || version.running !== version.head ? "update" : "reload";
}
updateButton.addEventListener("click", async () => {
  if (updateButton.dataset.action === "reload") return location.reload();
  updateButton.disabled = true;
  updateButton.querySelector("span").textContent = "Updating…";
  const result = await fetch("/api/version/update", { method: "POST" }).then((response) => response.json()).catch((error) => ({ error: error.message }));
  if (result.error || !result.watched) {
    updateButton.disabled = false;
    showNotice(result.error ? "Couldn't update the viewer" : "Pulled the latest viewer; restart it to run it", Boolean(result.error), { description: result.error || "This server isn't running under plan-viewer serve, which restarts itself." });
    return checkViewerVersion();
  }
  // Wait for the restarted server to report the new commit, then load the new client.
  for (let tries = 0; tries < 60; tries++) {
    await new Promise((done) => setTimeout(done, 500));
    const version = await fetch("/api/version").then((response) => response.json()).catch(() => null);
    if (version?.running === result.head) return location.reload();
  }
  updateButton.disabled = false;
  showNotice("The viewer didn't come back on the new version", true, { description: "Check the terminal running plan-viewer serve." });
});
checkViewerVersion();
setInterval(checkViewerVersion, 5 * 60_000);

// Every document an agent (or an editor outside the viewer) changed since the server started, newest first.
let documentChanges = [];
fetch("/api/changes").then((response) => response.json()).then((body) => { documentChanges = body.changes || []; }).catch(() => {});
const changeSummary = (change) => [change.sections.map((section) => section.title).join(", "), change.kind === "changed" ? `+${change.added}\u00a0−${change.removed}` : change.kind].filter(Boolean).join(" · ");
const changeHref = (change) => documentHref(change.path, change.sections[0]?.anchor || "");
// What agents changed in each document, marked whenever it renders: lines keep a quiet tint until you leave the
// document, and the first render after a change (or Show/Open from its toast) flashes them and their sections.
const changeMarks = new Map();
// A Markdown source line reduced to the text it renders as, for matching against the page.
const plainLine = (line) => line
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s?)/, "")
  .replace(/[`*_~|↗]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();
// ponytail: matches rendered blocks by text, so a line rewritten by enhancement (task references) goes unmarked.
function markDocumentChanges() {
  const marks = changeMarks.get(state.selectedPath);
  if (!marks) return;
  const flash = marks.flash ? " is-changed-flash" : "";
  marks.flash = false;
  for (const element of elements.chunks.querySelectorAll(".markdown li, .markdown p, .markdown tr, .markdown h3, .markdown h4, .markdown pre")) {
    // Read it as the source would: no nested lists, screen-reader-only text, or word joiners around links.
    const copy = element.cloneNode(true);
    copy.querySelectorAll(":scope > ul, :scope > ol, .sr-only").forEach((extra) => extra.remove());
    const text = plainLine((copy.matches("tr") ? [...copy.cells].map((cell) => cell.textContent).join(" ") : copy.textContent).replaceAll("\u2060", ""));
    if (!text || element.closest(".is-changed-line")) continue;
    if ([...marks.lines].some((line) => line && (line === text || (line.length >= 12 && text.includes(line))))) element.className += ` is-changed-line${flash}`;
  }
  if (!flash) return;
  for (const anchor of marks.sections) {
    const card = (document.getElementById(anchor) || elements.chunks.querySelector(`[data-source-anchor="${CSS.escape(anchor)}"]`))?.closest(".chunk-card");
    card?.classList.add("is-changed-flash");
  }
}
// One toast per document: a burst of writes to the same file replaces its toast instead of stacking.
const changeToasts = new Map();
function announceChange(change) {
  documentChanges = [change, ...documentChanges].slice(0, 50);
  if (change.source !== "agent") return;
  const marks = changeMarks.get(change.path) || { sections: new Set(), lines: new Set() };
  change.sections.forEach((section) => marks.sections.add(section.anchor));
  change.lines.forEach((line) => marks.lines.add(plainLine(line)));
  marks.flash = true;
  changeMarks.set(change.path, marks);
  dismissToast(changeToasts.get(change.path));
  const verb = { created: "Created", changed: "Updated", deleted: "Deleted" }[change.kind];
  const open = change.kind === "deleted" ? null : { label: change.path === state.selectedPath ? "Show" : "Open", run: () => { marks.flash = true; selectDocument(change.path, { historyMode: change.path === state.selectedPath ? "replace" : "push", anchor: change.sections[0]?.anchor || "" }); } };
  changeToasts.set(change.path, showNotice(`${verb} “${change.title}”`, false, { kind: "info", description: changeSummary(change), action: open }));
}

let diagramListTimer = 0;
let pendingDiagram = "";
function connectLiveUpdates() {
  const events = new EventSource("/api/events");
  events.addEventListener("diagram", (event) => {
    try { refreshDiagram(JSON.parse(event.data).path); } catch { /* malformed event */ }
    clearTimeout(diagramListTimer);
    diagramListTimer = setTimeout(loadDiagrams, 300);
  });
  events.addEventListener("markdown", (event) => {
    try {
      const update = JSON.parse(event.data);
      if (update.change) announceChange(update.change);
      if (update.path) scheduleMarkdownRefresh(update.path);
    } catch {
      // Ignore malformed live events; EventSource will keep the connection alive.
    }
  });
}

// `copy` asks for the prompt instead of an opened draft (Copy prompt).
async function requestDispatch(body, copy = false) {
  const response = await fetch("/api/dispatch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: agentApp(), ...body, copy }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `${agentName()} could not open the draft.`);
  return result;
}
function composerRequest(form) {
  const commentary = new FormData(form).get("commentary");
  return { path: form.dataset.sourcePath || (form.dataset.scope !== "global" || state.view === "document" ? state.selectedPath : ""), scope: form.dataset.scope, chunkId: form.dataset.chunkId, actionId: form.dataset.actionId, expectedPrompt: form.dataset.expectedPrompt, workItem: form.dataset.workItem, mode: form.dataset.workMode, selection: form.dataset.selection, section: form.dataset.section, commentary, images: [...form.querySelectorAll(".composer-images img")].map((img) => img.src) };
}
// The composer closes once copied, as it does once a draft opens; the prompt carries anything typed into it.
async function copyComposerPrompt(form) {
  try {
    await copyPrompt(requestDispatch(composerRequest(form), true));
    closeComposer();
    showNotice(`Copied the ${agentName()} prompt. Paste it into an open chat.`);
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function dispatch(form) {
  const button = form.querySelector(".send-button");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Opening draft…";
  try {
    await requestDispatch(composerRequest(form));
    const chunkId = form.dataset.chunkId;
    const scope = form.dataset.scope;
    closeComposer();
    if (state.view === "document") renderDocument();
    if (scope === "chunk") document.querySelector(`#${chunkId}`)?.classList.add("card-drafted");
    showNotice(`Draft loaded in ${agentName()}. Review or edit it there, then send it.`);
  } catch (error) {
    button.disabled = false;
    button.textContent = ["action", "work"].includes(form.dataset.scope) ? `Open in ${agentName()}` : `Open draft in ${agentName()}`;
    showNotice(error.message, true);
  }
}

elements.searchButton.addEventListener("click", openSearch);
elements.globalHandoff.addEventListener("click", openGlobalComposer);
function renderAgentPicker() {
  elements.agentPicker.innerHTML = Object.entries(AGENTS).map(([id, label]) => `<button type="button" data-agent="${id}" aria-pressed="${agentApp() === id}">${label}</button>`).join("");
  syncGlobalHandoff();
}
// Pages build their agent labels while rendering, so re-run the current route to pick up the new name.
elements.agentPicker.addEventListener("click", (event) => {
  const app = event.target.closest("[data-agent]")?.dataset.agent;
  if (!app || app === agentApp()) return;
  setAgentApp(app);
  renderAgentPicker();
  dispatchEvent(new PopStateEvent("popstate"));
});
renderAgentPicker();
elements.copyTaskPath.addEventListener("click", async () => {
  const path = elements.copyTaskPath.dataset.copyPath;
  if (!path) return;
  elements.copyTaskPath.classList.remove("is-copied", "copy-error");
  elements.taskPathStatus.textContent = "";
  try {
    await navigator.clipboard.writeText(path);
    if (elements.copyTaskPath.dataset.copyPath !== path) return;
    // Restart feedback on repeated clicks without adding or resizing any content.
    void elements.copyTaskPath.offsetWidth;
    elements.copyTaskPath.classList.add("is-copied");
    elements.taskPathStatus.textContent = "Copied.";
  } catch {
    if (elements.copyTaskPath.dataset.copyPath !== path) return;
    elements.copyTaskPath.classList.add("copy-error");
    elements.copyTaskPath.title = "Could not copy. Select the path and copy it manually.";
    elements.taskPathStatus.textContent = elements.copyTaskPath.title;
  }
});
elements.copyTaskPath.addEventListener("animationend", () => {
  elements.copyTaskPath.classList.remove("is-copied");
});
elements.tasksButton.addEventListener("click", () => showTasks());
elements.topicsButton.addEventListener("click", () => showLibrary("topics"));
elements.referenceButton.addEventListener("click", () => showLibrary("reference"));
elements.diagramsButton.addEventListener("click", () => showDiagrams());
elements.activityButton.addEventListener("click", () => showActivity());
elements.codeButton.addEventListener("click", () => showCode());
elements.issuesButton.addEventListener("click", () => showIssues());
elements.slackButton.addEventListener("click", () => showSlack());
connectPlanning({ documents: () => state.documents, open: (path) => selectDocument(path, { historyMode: "push" }), peek: peekDocument });

// A document read in place over whatever opened it (the Slack page and thread overlay), so a click on a task or plan
// doesn't leave that context. Links to other documents peek those; Enter or Open goes to the document itself.
let peekDialog = null;
async function peekDocument(path) {
  if (!peekDialog) {
    peekDialog = createOverlay("issue-overview doc-peek");
    peekDialog.innerHTML = `<header class="code-diff-head" data-o="head"></header><div class="issue-overview-main" data-o="main"></div>`;
    peekDialog.addEventListener("close", () => {
      if (peekDialog.open) return;
      if (peekDialog.dataset.path) announceClosed(); // not when Open took you to the document
      setOverlayParams({ peek: "" });
    });
    peekDialog.addEventListener("click", (event) => {
      if (event.target === peekDialog) return;
      const plain = !(event.metaKey || event.ctrlKey || event.shiftKey);
      const other = event.target.closest("a[data-document-path], a[data-planning-path]");
      if (other && plain) { event.preventDefault(); return peekDocument(other.dataset.documentPath || other.dataset.planningPath); }
      if (event.target.closest("[data-peek-close]")) peekDialog.close();
      else if (event.target.closest("[data-peek-open]")) openPeeked();
    });
    peekDialog.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.target.closest("a, button, input, textarea") && !(event.metaKey || event.ctrlKey || event.altKey)) { event.preventDefault(); openPeeked(); }
    });
  }
  const summary = state.documents.find((doc) => doc.path === path) || { path, title: path };
  peekDialog.dataset.path = path;
  setOverlayParams({ peek: path });
  peekDialog.querySelector('[data-o="head"]').innerHTML = `<span class="slack-overview-mark">${summary.task ? SERVICE_ICONS.task : icon("doc")}</span><div class="issue-overview-title"><h3>${summary.task ? `<code>${escapeHtml(summary.task.id)}</code>` : ""}${escapeHtml(summary.task?.title || summary.title)}</h3><p class="code-muted">${[summary.task?.status, summary.date && formatDate(summary.date), path].filter(Boolean).map(escapeHtml).join(" · ")}</p></div><span class="code-spacer"></span><a class="code-bar-button is-primary" href="${escapeHtml(documentHref(path, ""))}" data-peek-open>Open <kbd>Enter</kbd></a><button type="button" class="code-icon-button" data-peek-close aria-label="Close (Esc)">${icon("fail")}</button>`;
  const main = peekDialog.querySelector('[data-o="main"]');
  main.innerHTML = `<p class="code-muted doc-peek-loading">Loading…</p>`;
  if (!peekDialog.open) { peekDialog.showModal(); peekDialog.focus({ preventScroll: true }); }
  try {
    const response = await fetch(`/api/document?path=${encodeURIComponent(path)}`);
    const doc = await response.json();
    if (!response.ok) throw new Error(doc.error || "Could not open that document.");
    if (peekDialog.dataset.path !== path) return;
    main.innerHTML = `<article class="issue-overview-text doc-peek-text">${doc.chunks.map((chunk, index) => doc.format === "text" ? `<pre class="plain-text">${escapeHtml(chunk.markdown)}</pre>`
      : `${index || chunk.kind !== "overview" ? `<h${Math.min(chunk.level + 1, 4)} id="peek-${escapeHtml(chunk.anchor)}">${escapeHtml(chunk.title)}</h${Math.min(chunk.level + 1, 4)}>` : ""}<div class="markdown">${renderMarkdownSource(chunk.markdown, path)}</div>`).join("")}</article>`;
    main.scrollTop = 0;
  } catch (error) {
    main.innerHTML = `<p class="work-warning doc-peek-loading">${escapeHtml(error.message)}</p>`;
  }
}
function openPeeked() {
  const path = peekDialog.dataset.path;
  peekDialog.dataset.path = "";
  closeOverview();
  selectDocument(path, { historyMode: "push" });
}
elements.meta.addEventListener("click", async (event) => {
  const plainClick = !(event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  const view = event.target.closest("[data-crumb-view]");
  if (view && plainClick) {
    event.preventDefault();
    if (view.dataset.crumbView === "tasks") showTasks();
    else if (view.dataset.crumbView in LIBRARY_VIEWS) showLibrary(view.dataset.crumbView);
    return;
  }
  const doc = event.target.closest("[data-crumb-path]");
  if (doc && plainClick) {
    event.preventDefault();
    doc.closest("[popover]")?.hidePopover();
    selectDocument(doc.dataset.crumbPath);
    return;
  }
  if (event.target.closest(".crumb.is-current") && plainClick) {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    return;
  }
  const copy = event.target.closest("[data-copy-value]");
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copyValue);
      copy.classList.remove("is-copied");
      void copy.offsetWidth;
      copy.classList.add("is-copied");
      elements.taskPathStatus.textContent = `Copied ${copy.dataset.copyValue}.`;
    } catch {
      elements.taskPathStatus.textContent = "Could not copy.";
    }
  }
});
// Clipped labels and links with cached metadata get a quick, quiet hover card: full label, fetched title, state, person, destination.
const linkTip = Object.assign(document.createElement("div"), { className: "hover-card", hidden: true });
linkTip.setAttribute("role", "tooltip");
document.body.append(linkTip);
let linkTipTimer = 0;
function hideLinkTip() {
  clearTimeout(linkTipTimer);
  linkTip.hidden = true;
}
const REVIEW = { APPROVED: ["Approved", "good", "approved"], CHANGES_REQUESTED: ["Changes requested", "bad", "fail"], REVIEW_REQUIRED: ["Needs review", "wait", "review"] };
const CHECKS = { SUCCESS: ["Checks pass", "good", "pass"], FAILURE: ["Checks failing", "bad", "fail"], ERROR: ["Checks failing", "bad", "fail"], PENDING: ["Checks running", "wait", "pending"], EXPECTED: ["Checks running", "wait", "pending"] };
const tipFact = ([text, tone, glyph]) => `<span class="hover-card-fact" data-tone="${tone}">${icon(glyph)}${escapeHtml(text)}</span>`;
const SITES = { github: "GitHub", linear: "Linear", jira: "Jira", slack: "Slack" };
// Where a PR sits in its stack, read from the other PR links on this page: the PR its base branch belongs to, and the ones built on its head.
function stackPlace(slug, pr) {
  const below = [], above = [];
  for (const other of elements.chunks.querySelectorAll("a[data-meta]")) {
    const [, otherSlug, number] = metadataKey(other.href).match(/^github:(.+)#(\d+)$/) || [];
    const facts = otherSlug === slug && JSON.parse(other.dataset.meta).pr;
    if (!facts) continue;
    if (facts.head === pr.base && !below.includes(number)) below.push(number);
    if (facts.base === pr.head && !above.includes(number)) above.push(number);
  }
  return [below.length ? `on #${below.join(", #")}` : `into ${pr.base}`, above.length ? `#${above.join(", #")} on top` : ""].filter(Boolean);
}
// Header (source and state), title, then the facts that decide the next move; for a PR that is whether it can land.
function linkTipHtml(link, meta) {
  const key = metadataKey(link.href);
  const source = key.split(":")[0];
  const github = key.match(/^github:(.+)#(\d+)$/);
  // Slack keys are channel/timestamp IDs, so a Slack card leads with its channel name instead.
  const name = github ? `${github[1]} #${github[2]}` : source === "slack" ? meta.state || "Slack message" : key.replace(/^\w+:/, "") || link.dataset.tip;
  // A commit's state is its date, which the age already says.
  const commit = key.includes("@");
  const state = meta.state && source !== "slack" ? `<span class="hover-card-state" data-tone="${commit ? "" : escapeHtml(meta.tone || "")}">${escapeHtml(commit ? "Committed" : meta.state)}${meta.when ? ` <span>${ago(meta.when)} ago</span>` : ""}</span>` : "";
  const sourceIcon = link.querySelector(".service-icon")?.outerHTML || "";
  const lines = [];
  const pr = meta.pr;
  if (pr) {
    const live = meta.tone === "open" || meta.tone === "draft";
    const gate = live ? [REVIEW[pr.review], CHECKS[pr.checks], pr.mergeable === "CONFLICTING" ? ["Conflicts", "bad", "conflict"] : null].filter(Boolean).map(tipFact) : [];
    if (gate.length) lines.push(gate.join(""));
    lines.push([meta.person, ...stackPlace(github[1], pr)].filter(Boolean).map(escapeHtml).join(" · "));
    lines.push(diffSize(pr) + (live ? ` · <code>${escapeHtml(pr.head)}</code>` : "")); // the head branch only matters while it can still change
  } else {
    const facts = [meta.person || (meta.state && source !== "slack" ? "Unassigned" : ""), meta.priority && `${meta.priority} priority`].filter(Boolean);
    if (facts.length) lines.push(facts.map(escapeHtml).join(" · "));
  }
  const target = inAppTarget(link);
  const hint = target ? `Click for overview · ${modKey}-click opens ${target.site}` : SITES[source] ? `Click opens ${SITES[source]}` : link.dataset.documentPath || "";
  return `<div class="hover-card-head">${sourceIcon}<span class="hover-card-name">${escapeHtml(name)}</span>${state}</div>`
    + (meta.title ? `<div class="hover-card-title">${escapeHtml(meta.title)}</div>` : "")
    + lines.map(line => `<div class="hover-card-line">${line}</div>`).join("")
    + (hint ? `<div class="hover-card-hint">${escapeHtml(hint)}</div>` : "");
}
function showLinkTip(link) {
  const meta = link.dataset.meta ? JSON.parse(link.dataset.meta) : null;
  if (meta) linkTip.innerHTML = linkTipHtml(link, meta);
  else linkTip.innerHTML = `<div class="hover-card-title">${escapeHtml(link.dataset.tip)}</div>${link.dataset.documentPath ? `<div class="hover-card-hint">${escapeHtml(link.dataset.documentPath)}</div>` : ""}`;
  linkTip.hidden = false;
  const box = link.getBoundingClientRect();
  const left = Math.max(12, Math.min(box.left, innerWidth - linkTip.offsetWidth - 12));
  const top = box.bottom + 6 + linkTip.offsetHeight > innerHeight ? box.top - 6 - linkTip.offsetHeight : box.bottom + 6;
  linkTip.style.left = `${left}px`;
  linkTip.style.top = `${top}px`;
}
for (const [on, off] of [["pointerover", "pointerout"], ["focusin", "focusout"]]) {
  elements.chunks.addEventListener(on, (event) => {
    const link = event.target.closest?.("a[data-tip]");
    if (!link || link.closest(".code-page")) return; // the Code, Issues, Slack and Activity pages show their own tips
    clearTimeout(linkTipTimer);
    linkTipTimer = setTimeout(() => showLinkTip(link), 200);
  });
  elements.chunks.addEventListener(off, (event) => {
    const link = event.target.closest?.("a[data-tip]");
    if (link && !link.contains(event.relatedTarget)) hideLinkTip();
  });
}
// Day rows and page links in the rail get a card to their right: the whole plan, or what sits behind the page. The
// pointer can move onto it (it waits a moment before closing), and each row opens its item in an overlay over the
// current page: documents in the peek, PRs, issues and Slack threads in their own overviews. Keyboard focus shows it
// too, and → moves into it. Beside a side-by-side rail only; stacked above the page on narrow screens it would cover it.
const railCard = Object.assign(document.createElement("div"), { className: "hover-card rail-card", hidden: true });
railCard.setAttribute("role", "dialog");
document.body.append(railCard);
let railTimer = 0;
let railAnchor = null;
const railTarget = (node) => innerWidth > 820 && node?.closest?.(".library .day-row, .library .view-navigation-link[data-view]");
function openRailCard(row) {
  clearTimeout(railTimer);
  railAnchor = row;
  railCard.innerHTML = row.dataset.day ? dayTipHtml(row.dataset.day) : navSummary(row.dataset.view).card;
  railCard.setAttribute("aria-label", row.dataset.day ? formatDate(row.dataset.day, true) : row.textContent.trim());
  railCard.hidden = false;
  const box = row.getBoundingClientRect();
  railCard.style.left = `${box.right + 6}px`;
  railCard.style.top = `${Math.max(12, Math.min(box.top - 6, innerHeight - railCard.offsetHeight - 12))}px`;
}
function closeRailCard() {
  clearTimeout(railTimer);
  railCard.hidden = true;
  railAnchor = null;
}
const closeRailCardSoon = () => { clearTimeout(railTimer); railTimer = setTimeout(closeRailCard, 220); };
function openRailItem(target) {
  const [kind, ...rest] = target.split(":");
  const value = rest.join(":");
  closeRailCard();
  if (kind === "doc") peekDocument(value);
  else if (kind === "pr") { const [slug, number] = value.split("#"); openPrOverlay(slug, Number(number)); }
  else if (kind === "issue") openIssue(value);
  else if (kind === "slack") openSlackThread(value);
  else if (kind === "diagram") openDiagram(value);
}
elements.library.addEventListener("pointerover", (event) => {
  const row = railTarget(event.target);
  if (!row) return;
  clearTimeout(railTimer);
  if (row === railAnchor && !railCard.hidden) return;
  // Once a card is showing, moving down the rail swaps it at once.
  railTimer = setTimeout(() => openRailCard(row), railCard.hidden ? 250 : 40);
});
elements.library.addEventListener("pointerout", (event) => {
  const row = railTarget(event.target);
  if (row && !row.contains(event.relatedTarget) && !railCard.contains(event.relatedTarget)) {
    if (railCard.hidden) clearTimeout(railTimer); else closeRailCardSoon();
  }
});
elements.library.addEventListener("focusin", (event) => {
  const row = railTarget(event.target);
  if (row?.matches(":focus-visible")) openRailCard(row);
});
elements.library.addEventListener("focusout", (event) => {
  if (railAnchor && !railCard.contains(event.relatedTarget) && !railAnchor.contains(event.relatedTarget)) closeRailCard();
});
elements.library.addEventListener("click", closeRailCard);
elements.library.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowRight" || railCard.hidden || !railAnchor?.contains(event.target)) return;
  event.preventDefault();
  railCard.querySelector("[data-open]")?.focus();
});
railCard.addEventListener("pointerenter", () => clearTimeout(railTimer));
railCard.addEventListener("pointerleave", (event) => { if (!railAnchor?.contains(event.relatedTarget)) closeRailCardSoon(); });
railCard.addEventListener("focusout", (event) => { if (!railCard.contains(event.relatedTarget) && !railAnchor?.contains(event.relatedTarget)) closeRailCard(); });
railCard.addEventListener("click", (event) => {
  const item = event.target.closest("[data-open]");
  if (item) openRailItem(item.dataset.open);
});
railCard.addEventListener("keydown", (event) => {
  const items = [...railCard.querySelectorAll("[data-open]")];
  const at = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[Math.max(0, Math.min(items.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus(); }
  else if (event.key === "Escape" || event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); const anchor = railAnchor; closeRailCard(); anchor?.focus(); }
});
addEventListener("scroll", (event) => { if (!railCard.contains(event.target)) closeRailCard(); }, { capture: true, passive: true });
addEventListener("scroll", hideLinkTip, { capture: true, passive: true });
addEventListener("keydown", (event) => { if (event.key === "Escape") hideLinkTip(); });
elements.documents.addEventListener("click", (event) => {
  const button = event.target.closest("[data-path]");
  if (button) selectDocument(button.dataset.path);
});
elements.chunkNav.addEventListener("click", (event) => {
  const outlineLink = event.target.closest(".outline-jump");
  if (outlineLink) {
    event.preventDefault();
    const outline = chunkOutlines.get(state.activeChunkId);
    const path = outline?.paths.get(outlineLink.dataset.outlineKey) || [];
    const target = elements.chunks.querySelector(`[data-outline-key="${outlineLink.dataset.outlineKey}"]`);
    setActiveChunk(state.activeChunkId, path);
    holdNavigationSelection(target);
    if (target) {
      const url = new URL(location.href);
      url.hash = target.id;
      history.replaceState(null, "", url);
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    return;
  }
  const chunkLink = event.target.closest(".chunk-jump");
  if (chunkLink) {
    event.preventDefault();
    const target = document.getElementById(chunkLink.dataset.chunkId);
    setActiveChunk(chunkLink.dataset.chunkId);
    holdNavigationSelection(target);
    if (target) {
      const url = new URL(location.href);
      url.hash = target.dataset.sourceAnchor || target.id;
      history.replaceState(null, "", url);
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }
});
// Plain clicks on Slack permalinks hand off to the desktop app (unless `slack.codex` gives them a thread preview);
// modified clicks keep normal browser behaviour.
document.addEventListener("click", (event) => {
  const link = event.target.closest("a.slack-link");
  if (!link || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (inAppTarget(link)) return; // the thread preview, opened by the handler below
  event.preventDefault();
  fetch("/api/open-slack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: link.href }) })
    .then(response => { if (!response.ok) throw new Error(); })
    .catch(() => window.open(link.href, "_blank", "noreferrer"));
}, true);
// The in-app overview a written link opens on a plain click, or null when it goes out: PRs and commits always, issues once synced.
function inAppTarget(link) {
  const commit = commitLinkMatch(link.href);
  if (commit) return { open: () => openCommit(commit[1], commit[2]), site: "GitHub" };
  const [, kind, ref] = metadataKey(link.href).match(/^(github|linear|jira):(.+)$/) || [];
  if (kind === "github" && /\/pull\//.test(link.href)) {
    const [slug, number] = ref.split("#");
    return { open: () => openPrOverlay(slug, Number(number)), site: "GitHub" };
  }
  if (/^https:\/\/[\w-]+\.slack\.com\/archives\//.test(link.href) && config().slack.codex?.length) return { open: () => openSlackThread(link.href, link.dataset.meta ? JSON.parse(link.dataset.meta).state || "" : ""), site: "Slack" };
  if (kind !== "linear" && kind !== "jira") return null;
  const key = kind === "linear" ? `linear:${ref}` : ref;
  if (cachedIssues()?.issues?.some(issue => issue.key === key)) return { open: () => openIssue(key), site: kind === "linear" ? "Linear" : "Jira" };
  // Jira keys outside the synced scope are read on click; if Jira can't answer, the link goes out after all.
  if (kind === "jira" && cachedIssues()?.sources?.includes("jira")) return { open: () => openIssue(key).then(opened => opened || window.open(link.href, "_blank", "noreferrer")), site: "Jira" };
  return null;
}
// Plain clicks on PR and issue links in written content open the in-app overview first; modified clicks still go out.
document.addEventListener("click", (event) => {
  const link = event.target.closest(".markdown a[href], a.dock-link");
  if (!link || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = inAppTarget(link);
  if (!target) return;
  event.preventDefault();
  hideLinkTip();
  target.open();
}, true);
elements.meta.addEventListener("click", (event) => {
  const step = event.target.closest("[data-doc-step]");
  if (step) stepTaskDocument(Number(step.dataset.docStep));
});
// Images inside an overlay (an issue's description) open the same viewer, stacked above the overlay.
document.addEventListener("click", (event) => {
  const imageTrigger = event.target.closest("dialog .markdown-image-trigger");
  if (imageTrigger) showImageViewer(imageTrigger);
});
elements.chunks.addEventListener("click", (event) => {
  if (event.target.closest("[data-dock-draft]")) {
    openDocumentComposer();
    return;
  }
  const jump = event.target.closest("[data-dock-jump]");
  if (jump) {
    jump.closest("[popover]")?.hidePopover();
    document.getElementById(jump.dataset.dockJump)?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    return;
  }
  const source = event.target.closest("[data-dock-source]");
  if (source) return selectDockSource(source);
  const documentSort = event.target.closest("[data-doc-sort]");
  if (documentSort) {
    selectDocumentSort(documentSort);
    if (state.document) elements.meta.innerHTML = documentBreadcrumb(state.document) + documentStepper(state.document);
    return;
  }
  const dockPanel = event.target.closest(".doc-dock-panel");
  if (dockPanel && event.target.closest("a[href], [data-action-key], [data-work-item], .handoff-button")) queueMicrotask(() => dockPanel.matches(":popover-open") && dockPanel.hidePopover());
  const imageTrigger = event.target.closest(".markdown-image-trigger");
  if (imageTrigger) {
    showImageViewer(imageTrigger);
    return;
  }
  const diagramLink = event.target.closest("a[data-diagram-link]");
  if (diagramLink && !(event.metaKey || event.ctrlKey || event.shiftKey)) {
    event.preventDefault();
    openDiagram(diagramLink.dataset.diagramLink, diagramLink);
    return;
  }
  const graphExpand = event.target.closest("[data-graph-expand]");
  if (graphExpand) {
    event.preventDefault();
    showGraphViewer(graphExpand);
    return;
  }
  const sort = event.target.closest("[data-task-sort]");
  if (sort) {
    taskSort.dir = taskSort.key === sort.dataset.taskSort ? -taskSort.dir : sort.dataset.taskSort === "refs" || sort.dataset.taskSort === "updated" ? -1 : 1;
    taskSort.key = sort.dataset.taskSort;
    renderTasksPage();
    return;
  }
  const selectTask = !event.target.closest("[data-task-path], a, [data-action-key], [data-status-path]") && event.target.closest("[data-select-task]");
  if (selectTask) {
    if (!taskPaneVisible()) { selectDocument(selectTask.dataset.selectTask); return; }
    selectedTaskPath = selectTask.dataset.selectTask;
    updateTasksUrl("replace");
    for (const row of elements.chunks.querySelectorAll("tr[data-select-task]")) row.setAttribute("aria-selected", row.dataset.selectTask === selectedTaskPath);
    renderTaskDetail();
    return;
  }
  const task = event.target.closest("[data-task-path]");
  if (task) {
    selectDocument(task.dataset.taskPath);
    return;
  }
  const documentLink = event.target.closest(".markdown-document-link");
  if (documentLink) {
    event.preventDefault();
    selectDocument(documentLink.dataset.documentPath, { historyMode: "push", anchor: documentLink.dataset.documentAnchor });
    return;
  }
  const workItem = event.target.closest("[data-work-item]");
  if (workItem) {
    openWorkItem(workItem.dataset.workItem);
    return;
  }
  const actionButton = event.target.closest("[data-action-key]");
  if (actionButton) {
    const action = actionGroups.get(actionButton.dataset.actionKey)?.[Number(actionButton.dataset.actionIndex)];
    if (action) openComposer({ key: `action:${actionButton.dataset.actionKey}:${actionButton.dataset.actionIndex}`, scope: "action", title: action.title, action }, actionButton);
    return;
  }
  const handoff = event.target.closest(".handoff-button");
  if (handoff) {
    const chunk = state.document?.chunks.find((candidate) => candidate.id === handoff.dataset.chunkId);
    if (chunk) {
      const commentary = handoff.hasAttribute("data-repair-work")
        ? `Repair the Work breakdown in ${state.selectedPath}. Read the repository instructions and the task's context and updates. Resolve these viewer diagnostics:\n\n${state.document.work.warnings.map(w => `- ${w}`).join('\n')}\n\nUse the supported statuses: open, active, waiting, deferred, completed. Preserve recorded outcomes, IDs, hierarchy, and intended prerequisites. Change [done] to [completed] when the task records completion; do not mark unfinished work completed or remove dependencies just to suppress a warning. If intent is unclear, report the unresolved issue. Verify the task parses without warnings and that action availability matches the corrected prerequisites. Keep edits scoped to this task; do not send messages or execute its next actions.`
        : '';
      openComposer({ key: `chunk:${chunk.id}`, scope: "chunk", title: chunk.title, chunk, commentary }, handoff);
    }
  }
});
elements.chunks.addEventListener("toggle", (event) => {
  if (!event.target.matches?.(".doc-dock-panel")) return;
  elements.chunks.querySelector(`[popovertarget="${event.target.id}"]`)?.setAttribute("aria-expanded", String(event.newState === "open"));
}, true);
elements.handoffPopover.addEventListener("click", (event) => {
  const toggle = event.target.closest(".context-toggle");
  if (toggle) {
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded ? "Show less" : "Show full chunk";
    toggle.closest(".composer-context").classList.toggle("is-expanded", expanded);
  } else if (event.target.closest(".cancel-button")) closeComposer(true);
  else if (event.target.closest(".copy-prompt-button")) copyComposerPrompt(event.target.closest("form"));
  else if (event.target.closest(".popover-close")) requestComposerClose(true);
});
elements.imageViewer.addEventListener("click", (event) => {
  if (event.target === elements.imageViewer) {
    if (elements.imageViewer.querySelector("[data-diagram-ask] textarea")?.value.trim()) return; // typed text stays put
    closeImageViewer();
    return;
  }
  const thumbnail = event.target.closest("[data-image-index]");
  if (thumbnail) {
    selectImageViewerItem(Number(thumbnail.dataset.imageIndex));
    return;
  }
  const action = event.target.closest("[data-image-action]")?.dataset.imageAction;
  if (action === "close") closeImageViewer();
  else if (action === "previous") selectImageViewerItem(imageViewerState.index - 1);
  else if (action === "next") selectImageViewerItem(imageViewerState.index + 1);
  else if (action === "zoom-in") zoomImageViewer(1.25);
  else if (action === "zoom-out") zoomImageViewer(.8);
  else if (action === "reset") resetImageViewerTransform();
  else if (action === "edit-diagram") openDiagramEditor(imageViewerState.items[imageViewerState.index]?.diagram);
  else if (action === "toggle-source") toggleDiagramSource();
  else if (action === "copy-source") copyDiagramSource(event.target.closest("button"));
  else if (action === "copy-prompt") askAboutDiagram(true);
  else if (action === "copy-png") copyDiagramPng();
  else if (action === "panels") setDiagramPanels(event.target.closest("[data-panels]").dataset.panels);
  else if (!imageViewerState.moved) {
    // A click (not a drag) on a drawn object scrolls its statement into view.
    const id = event.target.closest(".image-viewer-diagram [data-id]")?.dataset.id;
    const line = id && elements.imageViewer.querySelector(`.draft-line[data-id="${CSS.escape(id)}"]`);
    if (line) {
      line.scrollIntoView({ block: "center", behavior: "smooth" });
      line.classList.remove("is-flashed");
      void line.offsetWidth;
      line.classList.add("is-flashed");
    }
  }
});

// Side by side or stacked, for a diff diagram's before and after panels. The pressed one is what is drawn.
function panelsToggle(item) {
  const panels = imageViewerState.panels || comparePanels(item.source);
  return `<span class="image-viewer-segmented" role="group" aria-label="Arrange the before and after panels">${[["right", "Side by side"], ["down", "Stacked"]].map(([value, label]) => `<button class="image-viewer-text" type="button" data-image-action="panels" data-panels="${value}" aria-pressed="${panels === value}" title="Draw the before and after panels ${value === "right" ? "side by side" : "one above the other"} (L)">${label}</button>`).join("")}</span>`;
}

function setDiagramPanels(panels) {
  const item = currentDiagram();
  if (!item || !isDiffDiagram(item.source)) return;
  imageViewerState.panels = panels;
  try { localStorage.setItem("plan-viewer:diagram-panels", panels); } catch {}
  for (const button of elements.imageViewer.querySelectorAll("[data-panels]")) button.setAttribute("aria-pressed", String(button.dataset.panels === panels));
  imageViewerState.isFitView = true;
  loadDiagram(item);
}

function currentDiagram() {
  const item = imageViewerState.items[imageViewerState.index];
  return item?.diagram ? item : null;
}

function toggleDiagramSource() {
  if (!currentDiagram()) return;
  imageViewerState.showSource = !imageViewerState.showSource;
  storeFlag("plan-viewer:diagram-source", imageViewerState.showSource);
  renderImageViewer();
  if (imageViewerState.isFitView) fitImageViewer();
}

// What's typed for each diagram stays until it is sent, across closing and reopening the viewer.
const diagramDrafts = new Map();

// Opens a draft in the agent app about the diagram (or copies its prompt), naming the document it sits in.
async function askAboutDiagram(copy = false) {
  const item = currentDiagram();
  const form = elements.imageViewer.querySelector("[data-diagram-ask]");
  if (!item || !form) return;
  const commentary = form.querySelector("textarea").value.trim();
  if (!commentary && !copy) { form.querySelector("textarea").focus(); return; }
  const button = form.querySelector(copy ? '[data-image-action="copy-prompt"]' : '[type="submit"]');
  button.disabled = true;
  try {
    const result = await requestDispatch({ scope: "diagram", diagram: item.diagram, path: state.view === "document" ? state.selectedPath || "" : "", commentary }, copy);
    if (copy) {
      await navigator.clipboard.writeText(result.prompt);
      button.classList.remove("is-copied");
      void button.offsetWidth;
      button.classList.add("is-copied");
    } else {
      diagramDrafts.delete(item.diagram);
      form.querySelector("textarea").value = "";
      autosizeDiagramAsk();
      showNotice(`Draft loaded in ${agentName()}. Review or edit it there, then send it.`);
    }
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function autosizeDiagramAsk() {
  const textarea = elements.imageViewer.querySelector("[data-diagram-ask] textarea");
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
}

elements.imageViewer.addEventListener("submit", (event) => {
  if (!event.target.closest("[data-diagram-ask]")) return;
  event.preventDefault();
  askAboutDiagram();
});
elements.imageViewer.addEventListener("input", (event) => {
  if (event.target.matches(".image-viewer-rail-filter")) {
    imageViewerState.railQuery = event.target.value;
    filterImageViewerRail();
    return;
  }
  const textarea = event.target.closest("[data-diagram-ask] textarea");
  const item = currentDiagram();
  if (!textarea || !item) return;
  diagramDrafts.set(item.diagram, textarea.value);
  autosizeDiagramAsk();
});

function focusDiagramAsk() {
  if (!currentDiagram()) return;
  if (!imageViewerState.showSource) toggleDiagramSource();
  const textarea = elements.imageViewer.querySelector("[data-diagram-ask] textarea");
  textarea?.focus();
  textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
}

async function copyDiagramPng() {
  const item = currentDiagram();
  const button = elements.imageViewer.querySelector('[data-image-action="copy-png"]');
  if (!item || button?.getAttribute("aria-busy") === "true") return;
  button?.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/api/diagram/copy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: item.diagram, panels: imageViewerState.panels }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not copy the drawing.");
    const now = elements.imageViewer.querySelector('[data-image-action="copy-png"]');
    now?.classList.remove("is-copied");
    void now?.offsetWidth;
    now?.classList.add("is-copied");
    showNotice(`Copied “${item.alt}” as a PNG. draftably extract recovers its source.`);
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    elements.imageViewer.querySelector('[data-image-action="copy-png"]')?.removeAttribute("aria-busy");
  }
}

async function copyDiagramSource(button) {
  const item = currentDiagram();
  if (item?.source === undefined) return;
  await navigator.clipboard.writeText(item.source);
  button.classList.remove("is-copied");
  void button.offsetWidth;
  button.classList.add("is-copied");
}

// Draws the item inline from the server's SVG and reads its source; re-renders the viewer if it is still showing it.
async function loadDiagram(item) {
  item.loaded = true;
  const [svg, source] = await Promise.all([
    fetch(`${diagramHref(item.diagram)}&panels=${imageViewerState.panels}&v=${Date.now()}`).then((response) => response.text()).catch(() => ""),
    fetch(`/api/asset?${new URLSearchParams({ path: item.diagram })}`).then((response) => response.ok ? response.text() : "").catch(() => ""),
  ]);
  const drawn = inlineSvg(svg);
  if (drawn) Object.assign(item, { svg: drawn.html, width: drawn.width, height: drawn.height });
  const wasDiff = isDiffDiagram(item.source);
  item.source = source;
  if (elements.imageViewer.open && imageViewerState.items[imageViewerState.index] === item) {
    // A redraw swaps the drawing and source in place, so zoom, pan, scroll and a half-typed request stay put.
    const drawing = elements.imageViewer.querySelector(".image-viewer-diagram");
    const pre = elements.imageViewer.querySelector(".diagram-source pre");
    if (drawing && item.svg && wasDiff === isDiffDiagram(source)) {
      drawing.innerHTML = item.svg;
      if (pre) { const scroll = pre.scrollTop; pre.innerHTML = sourceHtml(item.source); pre.scrollTop = scroll; }
    } else {
      const scroll = pre?.scrollTop || 0;
      renderImageViewer();
      const next = elements.imageViewer.querySelector(".diagram-source pre");
      if (next) next.scrollTop = scroll;
    }
    if (imageViewerState.isFitView) fitImageViewer();
  }
}

// Hovering a drawn object marks its statement, and hovering a statement marks what it draws.
elements.imageViewer.addEventListener("mouseover", (event) => {
  const from = event.target.closest(".image-viewer-diagram [data-id], .draft-line[data-id]");
  for (const marked of elements.imageViewer.querySelectorAll(".is-linked")) marked.classList.remove("is-linked");
  if (!from || imageViewerState.pan) return;
  // A box brings its connections with it, in the drawing and the source.
  const id = CSS.escape(from.dataset.id);
  const ids = [id, ...[...elements.imageViewer.querySelectorAll(`.draft-line[data-ends~="${id}"], .draft-line[data-in="${id}"]`)].map((line) => CSS.escape(line.dataset.id))];
  for (const each of ids) for (const target of elements.imageViewer.querySelectorAll(`.image-viewer-diagram [data-id="${each}"], .draft-line[data-id="${each}"]`)) target.classList.add("is-linked");
});

async function openDiagramEditor(path) {
  if (!path) return;
  const response = await fetch("/api/diagram/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
  const result = await response.json().catch(() => ({}));
  showNotice(response.ok ? "Opening the draftably editor. Saves redraw the diagram here." : result.error || "Could not open the draftably editor.", !response.ok);
}

// A saved `.draft` redraws every embed of it, the image viewer's included.
function refreshDiagram(path) {
  const src = `${diagramHref(path)}&v=${Date.now()}`;
  for (const trigger of document.querySelectorAll(`[data-diagram="${CSS.escape(path)}"]`)) trigger.querySelector("img").src = src;
  for (const item of imageViewerState.items) {
    if (item.diagram !== path) continue;
    item.src = src;
    if (item === currentDiagram() && elements.imageViewer.open) loadDiagram(item);
    else item.loaded = false;
  }
}
elements.imageViewer.addEventListener("wheel", (event) => {
  const stage = event.target.closest(".image-viewer-stage");
  if (!stage) return;
  event.preventDefault();
  const rect = stage.getBoundingClientRect();
  zoomImageViewer(Math.exp(-event.deltaY * .0015), { x: event.clientX - rect.left, y: event.clientY - rect.top });
}, { passive: false });
elements.chunks.addEventListener("dblclick", (event) => {
  const row = event.target.closest("tr[data-select-task]");
  if (!row || event.target.closest("[data-task-path], a, [data-action-key], [data-status-path], input, label")) return;
  window.getSelection()?.removeAllRanges();
  selectDocument(row.dataset.selectTask);
});
elements.imageViewer.addEventListener("dblclick", (event) => {
  if (event.target.closest(".image-viewer-stage") && !event.target.closest("button")) resetImageViewerTransform();
});
elements.imageViewer.addEventListener("pointerdown", (event) => {
  const stage = event.target.closest(".image-viewer-stage");
  if (!stage || event.button !== 0 || event.target.closest("button:not(.work-node)")) return;
  stage.setPointerCapture(event.pointerId);
  stage.classList.add("is-panning");
  imageViewerState.isFitView = false;
  imageViewerState.pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY };
  imageViewerState.moved = false;
});
elements.imageViewer.addEventListener("pointermove", (event) => {
  const pan = imageViewerState.pan;
  if (!pan || pan.pointerId !== event.pointerId) return;
  imageViewerState.offset.x += event.clientX - pan.x;
  imageViewerState.offset.y += event.clientY - pan.y;
  pan.x = event.clientX;
  pan.y = event.clientY;
  if (Math.abs(pan.x - pan.startX) + Math.abs(pan.y - pan.startY) > 4) imageViewerState.moved = true;
  updateImageViewerTransform();
});
elements.imageViewer.addEventListener("pointerup", (event) => {
  const pan = imageViewerState.pan;
  if (!pan || pan.pointerId !== event.pointerId) return;
  elements.imageViewer.querySelector(".image-viewer-stage")?.classList.remove("is-panning");
  imageViewerState.pan = null;
});
elements.imageViewer.addEventListener("pointercancel", () => {
  elements.imageViewer.querySelector(".image-viewer-stage")?.classList.remove("is-panning");
  imageViewerState.pan = null;
});
elements.imageViewer.addEventListener("cancel", (event) => {
  event.preventDefault();
  if (document.activeElement?.closest?.("[data-diagram-ask] textarea, .image-viewer-rail-filter")) return; // Esc there leaves the box first
  closeImageViewer();
});
elements.imageViewer.addEventListener("keydown", (event) => {
  if (!elements.imageViewer.open) return;
  const railFilter = event.target.closest(".image-viewer-rail-filter");
  if (railFilter) {
    // Enter shows the first match; Esc clears the filter, then leaves it; arrows still step through the matches.
    const matches = [...elements.imageViewer.querySelectorAll(".image-viewer-rail [data-image-index]:not([hidden])")].map((row) => Number(row.dataset.imageIndex));
    if (event.key === "Enter" && matches.length) { event.preventDefault(); selectImageViewerItem(matches[0]); elements.imageViewer.querySelector(".image-viewer-rail-filter")?.focus(); }
    else if (event.key === "Escape") { event.preventDefault(); if (railFilter.value) { railFilter.value = ""; imageViewerState.railQuery = ""; filterImageViewerRail(); } else elements.imageViewer.querySelector(".image-viewer-stage")?.focus(); }
    else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length) {
      event.preventDefault();
      const at = matches.indexOf(imageViewerState.index);
      selectImageViewerItem(matches[(at + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length]);
      elements.imageViewer.querySelector(".image-viewer-rail-filter")?.focus();
    }
    event.stopPropagation();
    return;
  }
  const typing = event.target.closest("textarea");
  if (typing) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); askAboutDiagram(); }
    else if (event.key === "Escape") { event.preventDefault(); typing.blur(); elements.imageViewer.querySelector(".image-viewer-stage")?.focus(); }
    event.stopPropagation();
    return;
  }
  const key = event.key.toLowerCase();
  if (event.key === "ArrowLeft" && imageViewerState.items.length > 1) selectImageViewerItem(imageViewerState.index - 1);
  else if (event.key === "ArrowRight" && imageViewerState.items.length > 1) selectImageViewerItem(imageViewerState.index + 1);
  else if (event.key === "+" || event.key === "=") zoomImageViewer(1.25);
  else if (event.key === "-") zoomImageViewer(.8);
  else if (key === "0") resetImageViewerTransform();
  else if (key === "s" && currentDiagram() && !(event.metaKey || event.ctrlKey || event.altKey)) toggleDiagramSource();
  else if (key === "e" && currentDiagram() && !(event.metaKey || event.ctrlKey || event.altKey)) openDiagramEditor(currentDiagram().diagram);
  else if (key === "d" && currentDiagram() && !(event.metaKey || event.ctrlKey || event.altKey)) focusDiagramAsk();
  else if (key === "c" && currentDiagram() && !(event.metaKey || event.ctrlKey || event.altKey)) copyDiagramPng();
  else if (key === "l" && isDiffDiagram(currentDiagram()?.source) && !(event.metaKey || event.ctrlKey || event.altKey)) setDiagramPanels((imageViewerState.panels || comparePanels(currentDiagram().source)) === "right" ? "down" : "right");
  else return;
  event.preventDefault();
  event.stopPropagation();
});
document.addEventListener("click", (event) => {
  if (!state.openComposer || elements.handoffPopover.contains(event.target) || event.target.closest(".handoff-button, [data-action-key], .global-handoff, [data-dock-draft]")) return;
  requestComposerClose();
});
// Keep the shortcut guide and bindings together so the documentation stays current. The guide shows them by `group`;
// shortcuts sharing a `row` (J and K) share one line, with the first one's label.
const shortcuts = [
  { group: "Go to", keys: ["T"], label: "Today’s plan", run: goToToday },
  { group: "Go to", keys: ["A"], label: "Tasks", run: () => showTasks() },
  { group: "Go to", keys: ["V"], label: "Activity", hint: "tasks, plans, issues and PRs, newest first", run: () => showActivity() },
  { group: "Go to", keys: ["G"], label: "Code", hint: "worktrees, pull requests, cleanup", run: () => showCode() },
  { group: "Go to", keys: ["I"], label: "Issues", hint: "triage, epics, activity", run: () => issuesOn() && showIssues() },
  { group: "Go to", keys: ["H"], label: "Recently viewed", hint: "type to filter, 1–9 to jump, even over an overview" },
  { group: "Read", row: "section", keys: ["J"], label: "Next / previous section", run: () => jumpSection(1) },
  { group: "Read", row: "section", keys: ["K"], run: () => jumpSection(-1) },
  { group: "Read", row: "document", keys: ["N"], label: "Next / previous task document", hint: "in the Documents panel’s order", run: () => stepTaskDocument(1) },
  { group: "Read", row: "document", keys: ["P"], run: () => stepTaskDocument(-1) },
  { group: "Read", row: "day", keys: ["]"], label: "Next / previous day’s plan", run: () => stepDay(1) },
  { group: "Read", row: "day", keys: ["["], run: () => stepDay(-1) },
  { group: "Find and keep", keys: ["⌘K", "Ctrl+K", "/"], label: "Search", hint: "pages, plans, tasks, topics, reference, PRs", run: openSearch },
  { group: "Find and keep", keys: ["⌘D", "Ctrl+D"], label: "Favorite what’s open", hint: "listed at the top of the sidebar" },
  { group: "Agent drafts", keys: ["C"], label: "Draft the hovered action or section", hint: "or the selected text; elsewhere a blank draft", run: openCursorComposer },
  { group: "Agent drafts", keys: ["D"], label: "Draft about the current file", run: openDocumentComposer },
  { group: "General", keys: ["?"], label: "This guide", run: openShortcutGuide },
  { group: "General", keys: ["Esc"], label: "Close the dialog or popover" },
];

let cursorPosition = null;
document.addEventListener("pointermove", (event) => { cursorPosition = { x: event.clientX, y: event.clientY }; }, { passive: true });
document.documentElement.addEventListener("pointerleave", () => { cursorPosition = null; });
window.addEventListener("blur", () => { cursorPosition = null; });

// Text selected in the document, with the headings above where it starts ("Findings › c4574f89: …").
function documentSelection() {
  const selection = getSelection();
  const text = selection?.toString().trim();
  if (!text || state.view !== "document" || !elements.chunks.contains(selection.anchorNode)) return null;
  const start = selection.getRangeAt(0).startContainer;
  const card = (start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement).closest(".chunk-card");
  const chunk = state.document?.chunks.find((candidate) => candidate.id === card?.id);
  const outline = chunkOutlines.get(card?.id);
  const heading = [...(card?.querySelectorAll("[data-outline-key]") || [])]
    .filter((node) => node.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
  const titles = (outline?.paths.get(heading?.dataset.outlineKey) || []).map((key) => outline.flat.find((node) => node.key === key)?.title);
  const section = [chunk?.title, ...titles].filter((title, index, all) => title && title !== all[index - 1]);
  return { text, section: section.join(" › ") };
}

function openSelectionComposer({ text, section }) {
  openComposer({ key: "selection", scope: "document", title: section.split(" › ").at(-1) || state.document.title, selection: text, section }, elements.documentHandoff);
}

function openCursorComposer() {
  const selected = documentSelection();
  if (selected) return openSelectionComposer(selected);
  const hovered = cursorPosition && document.elementFromPoint(cursorPosition.x, cursorPosition.y);
  const action = hovered?.closest("[data-action-key]")
    || hovered?.closest(".action-row, .work-line")?.querySelector("[data-action-key]");
  if (action) {
    action.click();
    return;
  }
  // The section's Copy button shares the class for its look; C always drafts, never copies.
  const draft = ".handoff-button:not([data-chunk-copy])";
  const trigger = hovered?.closest(`${draft}, [data-dock-draft], .global-handoff`)
    || hovered?.closest(".chunk-card")?.querySelector(draft);
  if (trigger && !trigger.disabled) trigger.click();
  else openGlobalComposer();
}

function goToToday() {
  const todayPath = `daily/${localTodayKey().replaceAll("-", "/")}/plan.md`;
  if (state.documents.some(doc => doc.path === todayPath)) selectDocument(todayPath);
  else showNotice("There is no plan for today yet.");
}

// [ and ] step to the previous or next day with files, from the open daily file or else from today, landing on its plan.
function stepDay(direction) {
  const days = [...new Set(state.documents.map((doc) => doc.date).filter(Boolean))].sort();
  const from = (state.view === "document" && state.documents.find((doc) => doc.path === state.selectedPath)?.date) || localTodayKey();
  const date = direction < 0 ? days.filter((day) => day < from).at(-1) : days.find((day) => day > from);
  if (!date) return showNotice(direction < 0 ? "No earlier day." : "No later day.");
  const docs = state.documents.filter((doc) => doc.date === date);
  selectDocument((docs.find((doc) => doc.kind === "Plan") || docs[0]).path);
}

function jumpSection(direction) {
  const links = [...elements.chunkNav.querySelectorAll(".chunk-jump")];
  if (!links.length || elements.chunkNav.hidden) return;
  const current = links.findIndex(link => link.dataset.chunkId === state.activeChunkId);
  links[Math.max(0, Math.min(links.length - 1, current + direction))]?.click();
}

const dialogReturnFocus = new WeakMap();
// `stack` opens over whatever dialog is already open (⌘K over the PR overview) instead of refusing.
function openViewerDialog(dialog, { stack = false } = {}) {
  if (!stack && document.querySelector("dialog[open]") && !dialog.open) return false;
  if (state.openComposer && !requestComposerClose()) return false;
  if (statusMenu.matches(":popover-open")) statusMenu.hidePopover();
  if (!dialog.open) {
    const focused = document.activeElement;
    const fallback = elements.searchButton;
    dialogReturnFocus.set(dialog, focused !== document.body && focused?.isConnected && focused.getClientRects().length ? focused : fallback);
    dialog.showModal();
  }
  return true;
}

function openShortcutGuide() {
  // Only this platform's modifier: ⌘K on a Mac, Ctrl+K elsewhere.
  const mac = /Mac|iP(hone|ad)/.test(navigator.platform);
  const shown = (keys) => keys.filter((key) => mac ? !key.startsWith("Ctrl+") : !key.startsWith("⌘"));
  const rows = [];
  for (const shortcut of shortcuts) {
    const same = shortcut.row && rows.find((row) => row.row === shortcut.row);
    if (same) same.keys.push(...shown(shortcut.keys));
    else rows.push({ ...shortcut, keys: shown(shortcut.keys) });
  }
  const groups = [...new Set(rows.map((row) => row.group))];
  document.querySelector("#shortcut-list").innerHTML = groups.map((group) => `<section class="shortcut-group"><h3>${escapeHtml(group)}</h3>${rows.filter((row) => row.group === group).map((row) => `<div class="shortcut-row"><span class="shortcut-keys">${row.keys.map((key) => `<kbd>${escapeHtml(key)}</kbd>`).join("")}</span><span class="shortcut-label">${escapeHtml(row.label)}${row.hint ? `<small>${escapeHtml(row.hint)}</small>` : ""}</span></div>`).join("")}</section>`).join("");
  openViewerDialog(elements.shortcutsDialog);
}

let searchMatches = [];
let searchIndex = 0;
const SEARCH_ICONS = {
  pr: GLYPHS["git-pull-request"],
  task: GLYPHS["square-check"],
  plan: GLYPHS["calendar"],
  topic: GLYPHS["folder"],
  reference: GLYPHS["book"],
  file: GLYPHS["file-text"],
  branch: GLYPHS["git-branch"],
  code: GLYPHS["code"],
  list: GLYPHS["list"],
  issue: GLYPHS["circle-dot"],
  initiative: GLYPHS["flag"],
  server: GLYPHS["server"],
  slack: GLYPHS["messages-square"],
};

function searchIconKey(doc) {
  if (doc.kind === "Task") return "task";
  if (doc.kind === "Plan" || doc.kind === "Daily note") return "plan";
  if (doc.kind === "Topic") return "topic";
  if (doc.kind === "Reference") return "reference";
  return "file";
}

// A term that matched only fuzzily marks its runs of two or more characters.
function highlightTerms(text, terms) {
  const lower = text.toLowerCase();
  terms = terms.flatMap((term) => lower.includes(term) || !termMatch(term, lower) ? [term] : fuzzyChunks(term, lower).chunks.filter((chunk) => chunk.length > 1));
  if (!terms.length) return escapeHtml(text);
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).map((part, index) => index % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)).join("");
}

// One row for a document, PR, or page wherever the viewer lists them (⌘K, Recently viewed): icon tile, title,
// a muted detail line, and a right-hand column. `attrs` carries the list's own role and data attributes.
const resultRow = ({ attrs = "", icon, tone = icon, title, detail, side, tag = "div", className = "", marker }) =>
  `<${tag} class="search-result ${className}" ${attrs}>${marker === undefined ? "" : `<span class="result-marker" aria-hidden="true">${marker}</span>`}<span class="search-icon is-${tone}"><svg viewBox="0 0 24 24" aria-hidden="true">${SEARCH_ICONS[icon]}</svg></span><strong>${title}</strong><small>${detail}</small><span class="search-kind">${side}</span></${tag}>`;

function docResult(doc, terms) {
  const icon = searchIconKey(doc);
  const detail = doc.task
    ? `<code>${highlightTerms(doc.task.id, terms)}</code> · ${escapeHtml(TASK_STATUS_LABELS[doc.task.status] || doc.task.status)}${doc.task.summary ? ` · ${highlightTerms(doc.task.summary, terms)}` : ""}`
    : highlightTerms(doc.path, terms);
  const kind = doc.kind.endsWith(" document") ? "Attachment" : doc.kind;
  return { icon, title: highlightTerms(doc.title, terms), detail, side: escapeHtml(kind) };
}

const searchAttrs = (index) => `id="search-result-${index}" role="option" aria-selected="false" data-search-index="${index}"`;
const renderSearchResult = (doc, index, terms) => resultRow({ ...docResult(doc, terms), attrs: searchAttrs(index) });

const PR_STATES = { OPEN: "Open", MERGED: "Merged", CLOSED: "Closed" };
const PR_REVIEW = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested" };
const CI_TEXT = { FAILURE: "checks failing", ERROR: "checks errored", PENDING: "checks running" };
function prResult(pr, terms) {
  const state = pr.requestedOfMe ? "Your review" : PR_REVIEW[pr.reviewDecision] || (pr.draft ? "Draft" : PR_STATES[pr.state] || "PR");
  // Short facts first and the branch (often long) last, so the ellipsis only ever eats the branch.
  const ci = CI_TEXT[pr.ci] ? `<span class="search-ci-${pr.ci === "PENDING" ? "pending" : "fail"}">${CI_TEXT[pr.ci]}</span>` : "";
  const detail = [highlightTerms(pr.slug.split("/")[1], terms), pr.author && highlightTerms(pr.author, terms), pr.updatedAt && `${ago(pr.updatedAt)} ago`, ci, pr.branch && highlightTerms(pr.branch, terms)].filter(Boolean).join(" · ");
  const tone = pr.draft ? "draft" : String(pr.state || "").toLowerCase(); // unknown state (not in the index) stays neutral
  return { icon: "pr", tone: `pr is-${escapeHtml(tone)}`, title: `<span class="search-pr-number">${highlightTerms(`#${pr.number}`, terms)}</span> ${highlightTerms(pr.title || "", terms)}`, detail, side: escapeHtml(state) };
}
const renderPrResult = ({ pr }, index, terms) => resultRow({ ...prResult(pr, terms), attrs: searchAttrs(index) });

function issueResult(issue, terms) {
  const detail = [issue.type, issue.assignee?.name || "Unassigned", issue.updated && `${ago(issue.updated)} ago`].filter(Boolean).map((part) => highlightTerms(part, terms)).join(" · ");
  const label = issue.type === "Project" ? "Project" : issue.label || issue.key;
  return { icon: "issue", tone: `issue is-${escapeHtml(issue.category)}`, title: `<span class="search-pr-number">${highlightTerms(label, terms)}</span> ${highlightTerms(issue.summary, terms)}`, detail: `${{ linear: "Linear · ", github: "GitHub · " }[issue.source] || ""}${detail}`, side: escapeHtml(issue.status) };
}
const renderIssueResult = ({ issue }, index, terms) => resultRow({ ...issueResult(issue, terms), attrs: searchAttrs(index) });

const planResult = (item, terms) => ({
  icon: "initiative", tone: `initiative is-${escapeHtml(item.status)}`, title: highlightTerms(item.title, terms),
  detail: [item.repo.split("/").pop(), item.phase, item.edited && `${ago(item.edited)} ago`, item.summary].filter(Boolean).map((part) => highlightTerms(String(part), terms)).join(" · "),
  side: item.source === "pr" ? "Proposed" : escapeHtml(item.status[0].toUpperCase() + item.status.slice(1)),
});
const renderPlanResult = ({ plan }, index, terms) => resultRow({ ...planResult(plan, terms), attrs: searchAttrs(index) });
const workResult = ({ work, doc }, terms) => ({
  icon: "list", tone: `work is-${escapeHtml(work.status)}`,
  title: `<span class="search-pr-number">${highlightTerms(work.id, terms)}</span> ${highlightTerms(work.title, terms)}`,
  detail: `<code>${escapeHtml(doc.task.id)}</code> · ${escapeHtml(doc.task.title)}`, side: escapeHtml(work.status[0].toUpperCase() + work.status.slice(1)),
});
const renderWorkResult = (hit, index, terms) => resultRow({ ...workResult(hit, terms), attrs: searchAttrs(index) });

// A key (`OPS-12`, or a bare number matching the end of one), an old key it was imported from, or words from the title.
function searchIssues(query, terms) {
  const data = cachedIssues();
  if (!data?.enabled) return [];
  const upper = query.toUpperCase().replace(/^#/, "");
  const alias = data.aliases[upper];
  return data.issues.filter((issue) => !issue.bot && !issue.mirrorOf).map((issue) => {
    const shown = issue.label || issue.key;
    const match = shown === upper || issue.key === alias ? 100 : /^\d+$/.test(upper) && shown.endsWith(`-${upper}`) ? 50 : textScore(terms, issue.summary, "", shown);
    return match && { issue, score: match + contextScore({ live: issue.category === "indeterminate", done: issue.category === "done", updated: issue.updated, mine: Boolean(data.me) && issue.assignee?.email === data.me }) };
  }).filter(Boolean);
}

// Every top-level page and Code tab, so ⌘K jumps straight to e.g. Pull requests.
const PAGES = [
  { title: "Today", detail: "Today’s plan", icon: "plan", run: goToToday },
  { title: "Tasks", detail: "All tasks", icon: "task", run: () => showTasks() },
  { title: "Activity", detail: "Everything that changed, newest first", icon: "plan", run: () => showActivity() },
  ...Object.entries(LIBRARY_VIEWS).map(([view, { title, intro }]) => ({ title, detail: intro, icon: title === "Topics" ? "topic" : "reference", run: () => showLibrary(view) })),
  { title: "Diagrams", detail: "Every diagram in the workspace", icon: "plan", run: () => showDiagrams() },
  { title: "Local servers", detail: "Dev servers the viewer started: URLs, output, restart, stop", icon: "server", run: () => openServers(showNotice) },
  ...Object.entries(CODE_TABS).map(([tab, title]) => ({ title, detail: `Code · ${title}`, icon: tab === "prs" ? "pr" : tab === "commits" ? "branch" : "code", run: () => showCode({ tab: tab === "prs" ? "" : tab }) })),
  ...Object.entries(ISSUE_TABS).map(([tab, title]) => ({ title: tab === "all" ? "Issues" : `${title} issues`, detail: `Issues · ${title}`, icon: "issue", issues: true, run: () => showIssues({ tab: tab === "all" ? "" : tab }) })),
  { title: "Slack", detail: "Slack threads the planning documents link", icon: "slack", slack: true, run: () => showSlack() },
];
const searchPages = (query) => { const terms = query.toLowerCase().split(/\s+/).filter(Boolean); return PAGES.filter((page) => (!page.issues || issuesOn()) && (!page.slack || config().slack.codex?.length) && terms.every((term) => termMatch(term, `${page.title} ${page.detail}`.toLowerCase()))).map((page) => ({ page })); };
const renderPageResult = ({ page }, index) => resultRow({ icon: page.icon, title: escapeHtml(page.title), detail: escapeHtml(page.detail), side: "Page", attrs: searchAttrs(index) });

const LIVE_TASK = new Set(["open", "active"]);
const SETTLED_TASK = new Set(["completed", "deferred"]);
// Every source scored on one scale (textScore + contextScore), so a recent open task outranks an old closed issue.
function rankedMatches(query, prs, me) {
  const terms = query.toLowerCase().replace(/^#/, "").split(/\s+/).filter(Boolean);
  const numeric = /^(?:[a-z][\w.-]*\s*)?#?\d+$/i.test(query);
  const docs = searchDocuments(state.documents, query).map((doc) => {
    const task = doc.task;
    const text = textScore(terms, doc.title, task ? `${doc.path} ${task.summary} ${task.project} ${task.status} ${task.tags.join(" ")}` : doc.path, task?.id) || 1;
    const context = task ? contextScore({ live: LIVE_TASK.has(task.status), done: SETTLED_TASK.has(task.status), updated: task.updated, mine: true }) : contextScore({ updated: doc.date });
    return { doc, group: task ? "Tasks" : "Documents", score: text + context };
  });
  const work = state.documents.flatMap((doc) => (doc.task?.work || []).map((work) => {
    const text = textScore(terms, work.title, "", work.id);
    const done = SETTLED_TASK.has(work.status) || SETTLED_TASK.has(doc.task.status);
    return text && { work, doc, group: "Work items", score: text + contextScore({ live: !done && LIVE_TASK.has(work.status), done, updated: doc.task.updated, mine: true }) };
  })).filter(Boolean);
  return [
    ...searchPages(query).map((item) => ({ ...item, group: "Pages", score: textScore(terms, item.page.title, item.page.detail) })),
    ...docs, ...work,
    ...searchIssues(query, terms).map((item) => ({ ...item, group: "Issues" })),
    ...searchPrs(prs, query).map((pr, index) => ({ pr, group: "Pull requests", score: (numeric ? 80 - index * 5 : textScore(terms, pr.title || "", `${pr.branch} ${pr.author} ${pr.slug}`))
      + contextScore({ live: pr.state === "OPEN", done: pr.state !== "OPEN", updated: pr.updatedAt, mine: pr.requestedOfMe || pr.author === me }) })),
    ...searchPlans(query).map((plan) => ({ plan, group: "Initiatives", score: (textScore(terms, plan.title, `${plan.slug} ${plan.summary}`) || 1)
      + contextScore({ live: plan.status === "active", done: ["completed", "retired"].includes(plan.status), updated: plan.edited }) })),
  ].sort((a, b) => b.score - a.score);
}

const GROUP_CAPS = { "Work items": 8, Issues: 8, "Pull requests": 6, Initiatives: 6 };
// With no query, PRs waiting on you lead. A query puts the best eight matches of any kind on top, then the rest by kind,
// kinds ordered by their best remaining match.
function searchGroups(query) {
  const index = cachedPrIndex();
  const prs = index?.prs || [];
  if (query) {
    const ranked = rankedMatches(query, prs, index?.me);
    const groups = new Map();
    for (const item of ranked.slice(8)) {
      const list = groups.get(item.group) || groups.set(item.group, []).get(item.group);
      if (list.length < (GROUP_CAPS[item.group] || Infinity)) list.push(item);
    }
    return [["Top results", ranked.slice(0, 8)], ...groups];
  }
  const open = prs.filter((pr) => pr.state === "OPEN").sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const wrap = (list) => list.map((pr) => ({ pr }));
  return [["Needs your review", wrap(open.filter((pr) => pr.requestedOfMe).slice(0, 5))], ["Your open PRs", wrap(open.filter((pr) => pr.author === index?.me && !pr.requestedOfMe).slice(0, 5))], ["Pages", searchPages("")], ["Documents", state.documents.map((doc) => ({ doc }))]];
}

const renderMatch = (item, index, terms) => item.pr ? renderPrResult(item, index, terms) : item.issue ? renderIssueResult(item, index, terms) : item.plan ? renderPlanResult(item, index, terms)
  : item.page ? renderPageResult(item, index) : item.work ? renderWorkResult(item, index, terms) : renderSearchResult(item.doc, index, terms);

function renderSearchResults() {
  const query = elements.searchInput.value.trim();
  const terms = query.toLowerCase().replace(/^#/, "").split(/\s+/).filter(Boolean);
  const groups = searchGroups(query).filter(([, items]) => items.length);
  searchMatches = groups.flatMap(([, items]) => items);
  searchIndex = 0;
  const count = (key, one, many) => { const n = searchMatches.filter((item) => item[key]).length; return n ? `${n} ${n === 1 ? one : many}` : ""; };
  elements.searchStatus.textContent = [count("work", "work item", "work items"), count("issue", "issue", "issues"), count("pr", "PR", "PRs"), count("plan", "initiative", "initiatives"), count("doc", "document", "documents")].filter(Boolean).join(" · ");
  let position = 0;
  elements.searchResults.innerHTML = searchMatches.length
    ? groups.map(([label, items]) => `<div class="search-section" role="presentation">${label}</div>${items.map((item) => renderMatch(item, position++, terms)).join("")}`).join("")
    : '<div class="search-empty"><strong>No matches</strong><span>Try a title, path, task ID, work item, PR number or title, project, or tag.</span></div>';
  elements.searchResults.scrollTop = 0;
  syncSearchSelection();
}

function syncSearchSelection() {
  for (const result of elements.searchResults.querySelectorAll("[data-search-index]")) result.setAttribute("aria-selected", Number(result.dataset.searchIndex) === searchIndex ? "true" : "false");
  if (searchMatches.length) {
    elements.searchInput.setAttribute("aria-activedescendant", `search-result-${searchIndex}`);
    const row = document.getElementById(`search-result-${searchIndex}`);
    // The first row of a group scrolls its label into view too.
    (searchIndex && row?.previousElementSibling?.matches(".search-section") ? row.previousElementSibling : row)?.scrollIntoView({ block: "nearest" });
  } else elements.searchInput.removeAttribute("aria-activedescendant");
  const pr = searchMatches[searchIndex]?.pr;
  if (pr) prefetchPr(pr.slug, pr.number); // the overview opens from the server cache by the time Enter is pressed
}

function openSearch() {
  if (!openViewerDialog(elements.searchDialog, { stack: true })) return;
  renderSearchResults();
  elements.searchInput.focus();
  elements.searchInput.select();
  // The index from the last open renders at once; the fresh copy replaces it unless the selection has moved.
  loadPrIndex().then(() => { if (elements.searchDialog.open && searchIndex === 0) renderSearchResults(); }, () => {});
  if (!cachedPlans()) loadPlans().then(() => { if (elements.searchDialog.open && searchIndex === 0) renderSearchResults(); }, () => {});
}

function openSearchResult(index, external = false) {
  const doc = searchMatches[index];
  if (!doc) return;
  if (doc.pr && external) return window.open(doc.pr.url, "_blank", "noreferrer");
  if (doc.issue && external) return window.open(doc.issue.url || `https://${cachedIssues().site}/browse/${doc.issue.key}`, "_blank", "noreferrer");
  elements.searchDialog.close();
  if (doc.page) { closeOverview(); doc.page.run(); }
  else if (doc.pr) openPrOverlay(doc.pr.slug, doc.pr.number);
  else if (doc.issue) openIssue(doc.issue.key);
  else if (doc.plan) openPlan(doc.plan.id);
  else if (doc.work) { closeOverview(); selectDocument(doc.doc.path).then(() => openWorkItem(doc.work.id)); }
  else { closeOverview(); selectDocument(doc.doc.path); }
}

elements.searchInput.addEventListener("input", renderSearchResults);
elements.searchInput.addEventListener("keydown", event => {
  if (event.isComposing) return;
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    if (searchMatches.length) searchIndex = (searchIndex + (event.key === "ArrowDown" ? 1 : -1) + searchMatches.length) % searchMatches.length;
    syncSearchSelection();
  } else if (event.key === "Enter") {
    event.preventDefault();
    openSearchResult(searchIndex, event.metaKey || event.ctrlKey);
  }
});
elements.searchResults.addEventListener("mousemove", event => {
  const result = event.target.closest("[data-search-index]");
  if (!result || Number(result.dataset.searchIndex) === searchIndex) return;
  searchIndex = Number(result.dataset.searchIndex);
  for (const option of elements.searchResults.querySelectorAll("[data-search-index]")) option.setAttribute("aria-selected", option === result ? "true" : "false");
  elements.searchInput.setAttribute("aria-activedescendant", result.id);
  const pr = searchMatches[searchIndex]?.pr;
  if (pr) prefetchPr(pr.slug, pr.number);
});
elements.searchResults.addEventListener("click", event => {
  const result = event.target.closest("[data-search-index]");
  if (result) openSearchResult(Number(result.dataset.searchIndex), event.metaKey || event.ctrlKey);
});
// Tables copy as their Markdown source, as an HTML table (what copying the selection would give), or as CSV/TSV of the visible text.
const tableCellText = (cell) => {
  const clone = cell.cloneNode(true);
  for (const hidden of clone.querySelectorAll(".sr-only, [aria-hidden='true']")) hidden.remove();
  return clone.textContent.replaceAll("\u2060", "").replace(/\s+/g, " ").trim();
};
// Only the rows showing, in their current order: the expanded table's sorting and filtering carry into copies and downloads.
const tableRows = (table) => [...table.rows].filter((row) => !row.hidden && !row.closest("[data-table-ui]")).map((row) => [...row.cells].map(tableCellText));
// Downloads are named for the heading the table sits under, falling back to the page title.
function tableName(wrapper) {
  const heading = [...document.querySelectorAll("main h1, main h2, main h3, main h4, main h5")].filter((h) => h.compareDocumentPosition(wrapper) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
  return (heading?.textContent || document.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table";
}
function downloadTable(button) {
  const host = button.closest("[data-table-source]");
  const csv = new Blob([`\ufeff${delimitedTable(tableRows(host.querySelector("table")), ",")}\n`], { type: "text/csv" });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(csv), download: `${host.dataset.tableName || tableName(host)}.csv` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
async function copyTable(button) {
  const host = button.closest("[data-table-source]");
  const table = host.querySelector("table");
  const format = button.dataset.tableCopy;
  try {
    if (format === "html") {
      const clone = table.cloneNode(true);
      for (const hidden of clone.querySelectorAll(".sr-only, [aria-hidden='true'], [data-table-ui], tr[hidden]")) hidden.remove();
      for (const sort of clone.querySelectorAll(".table-sort")) sort.replaceWith(...sort.firstElementChild.childNodes);
      for (const link of clone.querySelectorAll("a[href]")) link.setAttribute("href", link.href);
      for (const element of [clone, ...clone.querySelectorAll("*")]) for (const { name } of [...element.attributes]) if (name !== "href") element.removeAttribute(name);
      // Like a selection copied off the page: a styled table for rich editors, tab-separated text for plain ones.
      clone.setAttribute("style", "border-collapse: collapse");
      for (const cell of clone.querySelectorAll("th, td")) cell.setAttribute("style", `border: 1px solid #d0d7de; padding: 4px 8px; text-align: left; vertical-align: top${cell.tagName === "TH" ? "; font-weight: bold; background: #f6f8fa" : ""}`);
      const html = `<meta charset="utf-8">${clone.outerHTML.replaceAll("\u2060", "")}`;
      const text = delimitedTable(tableRows(table), "\t");
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
    } else {
      await navigator.clipboard.writeText(format === "markdown" ? host.dataset.tableSource : delimitedTable(tableRows(table), format === "csv" ? "," : "\t"));
    }
    button.classList.remove("is-copied");
    void button.offsetWidth;
    button.classList.add("is-copied");
  } catch {
    showNotice("Could not copy the table.", true);
  }
}
function showTableViewer(wrapper) {
  const dialog = elements.tableViewer;
  const table = wrapper.querySelector("table");
  const tools = wrapper.querySelector(".table-tools").cloneNode(true);
  tools.querySelector("[data-table-expand]").remove();
  dialog.dataset.tableSource = wrapper.dataset.tableSource;
  dialog.dataset.tableName = tableName(wrapper);
  dialog.innerHTML = `<header class="viewer-dialog-heading"><h2 id="table-viewer-title">Table <span>${table.tBodies[0].rows.length} rows × ${table.tHead.rows[0].cells.length} columns</span></h2>${tools.outerHTML}<button type="button" data-dialog-close aria-label="Close table">×</button></header><div class="table-viewer-body markdown" tabindex="0">${table.outerHTML}</div>`;
  if (!openViewerDialog(dialog, { stack: true })) return;
  enhanceTable(dialog, tableCellText);
  dialog.querySelector(".table-viewer-body").focus();
}
// Code blocks copy and download their fenced source verbatim; the file extension follows the fence's language.
const CODE_EXTENSIONS = { javascript: "js", typescript: "ts", python: "py", bash: "sh", shell: "sh", zsh: "sh", markdown: "md", text: "txt", yaml: "yml" };
async function copyCode(button) {
  try {
    await navigator.clipboard.writeText(button.closest("[data-code-source]").dataset.codeSource);
    button.classList.remove("is-copied");
    void button.offsetWidth;
    button.classList.add("is-copied");
  } catch {
    showNotice("Could not copy the code.", true);
  }
}
function downloadCode(button) {
  const host = button.closest("[data-code-source]");
  const language = host.dataset.codeLanguage.toLowerCase();
  const extension = CODE_EXTENSIONS[language] || (/^[a-z0-9]{1,8}$/.test(language) ? language : "txt");
  const file = new Blob([`${host.dataset.codeSource}\n`], { type: "text/plain" });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: `${tableName(host).replace(/^table$/, "code")}.${extension}` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
// A section copies as its own Markdown, under its heading unless it is the untitled overview, or as the prompt
// Open in would draft, for pasting into a chat that is already open.
async function copyChunk(button) {
  const chunk = state.document?.chunks.find((item) => item.id === button.dataset.chunkCopy);
  if (!chunk) return;
  try {
    if (button.dataset.copyAs === "prompt") {
      await copyPrompt(requestDispatch({ path: state.selectedPath, scope: "chunk", chunkId: chunk.id }, true));
    } else await navigator.clipboard.writeText(chunk.kind === "overview" ? chunk.markdown : `${"#".repeat(chunk.level)} ${chunk.title}\n\n${chunk.markdown}`);
    button.classList.remove("is-copied");
    void button.offsetWidth;
    button.classList.add("is-copied");
  } catch {
    showNotice(button.dataset.copyAs === "prompt" ? "Could not copy the prompt." : "Could not copy the section.", true);
  }
}
document.addEventListener("click", (event) => {
  const chunkCopy = event.target.closest("[data-chunk-copy]");
  if (chunkCopy) return void copyChunk(chunkCopy);
  const codeCopy = event.target.closest("[data-code-copy]");
  if (codeCopy) return void copyCode(codeCopy);
  const codeDownload = event.target.closest("[data-code-download]");
  if (codeDownload) return downloadCode(codeDownload);
  const copy = event.target.closest("[data-table-copy]");
  if (copy) return void copyTable(copy);
  const download = event.target.closest("[data-table-download]");
  if (download) return downloadTable(download);
  const expand = event.target.closest("[data-table-expand]");
  if (expand) return showTableViewer(expand.closest(".markdown-table"));
  // A link followed from the overlay lands on the page underneath.
  if (event.target.closest(".table-viewer a[href]")) elements.tableViewer.close();
});

for (const dialog of [elements.searchDialog, elements.shortcutsDialog, elements.tableViewer]) {
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    const previous = dialogReturnFocus.get(dialog);
    const fallback = elements.searchButton;
    (previous?.isConnected && previous.getClientRects().length ? previous : fallback).focus();
  });
  dialog.addEventListener("click", event => {
    if (event.target.closest("[data-dialog-close]")) dialog.close();
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }
  });
}

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing || event.repeat) return;
  const key = event.key.toLowerCase();
  const modal = document.querySelector("dialog[open]");
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === "k") {
    event.preventDefault();
    openSearch(); // over any overlay, so it is always one keystroke away
    return;
  }
  if ((event.metaKey || event.ctrlKey) && key === "d") {
    event.preventDefault(); // instead of the browser's own bookmark
    toggleFavorite();
    return;
  }
  if (isSummonKey(event) && !historyMenu.matches(":popover-open")) {
    event.preventDefault();
    openHistoryMenu();
    return;
  }
  if (modal) return;
  if (event.metaKey || event.ctrlKey || event.altKey || (event.shiftKey && event.key !== "?")) return;
  if (event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return;
  // In the open links panel, 1–9 pick a tab and ← → cycle through them.
  const linkTabs = [...document.querySelectorAll(".doc-dock-panel-links:popover-open [data-dock-source]")];
  const current = linkTabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
  const linkTab = linkTabs.length && (/^[1-9]$/.test(key) ? linkTabs[key - 1]
    : key === "arrowright" ? linkTabs[(current + 1) % linkTabs.length]
    : key === "arrowleft" ? linkTabs[(current - 1 + linkTabs.length) % linkTabs.length] : null);
  if (linkTab) { event.preventDefault(); linkTab.click(); return; }
  // ↑ ↓ step through the rows of an open dock list.
  const rows = (key === "arrowdown" || key === "arrowup") && [...document.querySelectorAll(".doc-dock-panel:popover-open .dock-source-list:not([hidden]) .dock-link")];
  if (rows?.length) {
    event.preventDefault();
    const at = rows.indexOf(document.activeElement);
    rows[at < 0 ? (key === "arrowdown" ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + (key === "arrowdown" ? 1 : -1)))].focus();
    return;
  }
  if (state.openComposer || document.querySelector(":popover-open:not(.code-tip)")) return;
  const shortcut = shortcuts.find(shortcut => shortcut.run && shortcut.keys.some(binding => binding.toLowerCase() === key));
  if (shortcut) { event.preventDefault(); shortcut.run(); }
});
window.addEventListener("scroll", () => {
  syncDockStuck();
  if (navigationScrollLock) {
    window.clearTimeout(navigationScrollTimer);
    navigationScrollTimer = window.setTimeout(releaseNavigationScrollLock, 500);
    return;
  }
  syncActiveChunk();
}, { passive: true });
window.addEventListener("resize", () => {
  syncActiveChunk();
  alignProgressiveColumns();
  resizeComposerTextarea(elements.handoffPopover.querySelector("textarea"));
});
window.addEventListener("popstate", () => {
  const params = new URLSearchParams(location.search);
  if (params.get("view") === "tasks") {
    selectedTaskPath = taskFromUrl() || selectedTaskPath;
    showDoneTasks = params.get("done") === "1";
    showTasks({ historyMode: "none" });
    return;
  }
  if (params.get("view") in LIBRARY_VIEWS) {
    showLibrary(params.get("view"), { historyMode: "none" });
    return;
  }
  if (params.get("view") === "diagrams") {
    showDiagrams({ historyMode: "none" });
    return;
  }
  if (params.get("view") === "code") {
    showCode({ historyMode: "none", tab: params.get("tab") || "" });
    return;
  }
  if (params.get("view") === "issues") {
    showIssues({ historyMode: "none", tab: params.get("tab") || "" });
    return;
  }
  if (params.get("view") === "slack") {
    showSlack({ historyMode: "none" });
    return;
  }
  if (params.get("view") === "activity") {
    showActivity({ historyMode: "none" });
    return;
  }
  const requested = params.get("path");
  const path = state.documents.find((doc) => doc.path === requested)?.path
    || state.documents.find((doc) => doc.path === state.defaultPath)?.path
    || state.documents[0]?.path;
  if (path) selectDocument(path, { historyMode: "none", anchor: locationAnchor() });
});
elements.handoffPopover.addEventListener("submit", (event) => { event.preventDefault(); dispatch(event.target); });
elements.handoffPopover.addEventListener("input", (event) => {
  if (event.target.matches("textarea")) {
    resizeComposerTextarea(event.target);
    syncComposerDraftState();
  }
});
elements.handoffPopover.addEventListener("paste", (event) => {
  if (event.clipboardData?.files.length && [...event.clipboardData.files].some((file) => file.type.startsWith("image/"))) {
    event.preventDefault();
    attachComposerImages(event.clipboardData.files);
  }
});
elements.handoffPopover.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); });
elements.handoffPopover.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  attachComposerImages(event.dataTransfer.files);
});
elements.handoffPopover.addEventListener("click", (event) => {
  const remove = event.target.closest(".composer-image-remove");
  if (!remove) return;
  const strip = remove.closest(".composer-images");
  remove.closest("figure").remove();
  strip.hidden = !strip.querySelector("img");
  syncComposerDraftState();
});
elements.handoffPopover.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    requestComposerClose(true);
    return;
  }
  if (event.target.matches("textarea") && event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    event.target.closest("form").requestSubmit();
  }
  // Dictation apps paste with a synthetic ⌘V right after their Option hotkey. macOS ORs the still-held Option
  // into it, and Chrome has no ⌘⌥V binding, so the paste vanished. Treat it as a plain paste.
  if (event.target.matches("textarea") && event.code === "KeyV" && event.metaKey && event.altKey && !event.shiftKey && !event.ctrlKey) {
    event.preventDefault();
    navigator.clipboard.readText().then((text) => { if (text) document.execCommand("insertText", false, text); }, () => {});
  }
});

// Status menu: click a status pill, or right-click a pill or task row.
const statusMenu = document.querySelector("#status-menu");
function openStatusMenu(path, status, x, y) {
  // Waiting picks when to look again; on a waiting task the same buttons push the check-in out.
  const checkIns = `<div class="status-menu-checkins" role="group" aria-label="Check in after">${[[3, "3d"], [7, "1w"], [14, "2w"], [28, "4w"]].map(([days, label]) => `<button type="button" role="menuitem" data-set-status="waiting" data-days="${days}" data-path="${escapeHtml(path)}" title="Waiting, check in ${escapeHtml(formatDate(dateKey(addDays(parseDateKey(localTodayKey()), days))))}">${label}</button>`).join("")}</div>`;
  statusMenu.innerHTML = Object.entries(TASK_STATUS_LABELS).map(([value, label]) => `<button type="button" role="menuitemradio" aria-checked="${value === status}" data-set-status="${value}" data-path="${escapeHtml(path)}"><span class="task-status task-status-${value}">${label}</span></button>${value === "waiting" ? checkIns : ""}`).join("");
  statusMenu.showPopover();
  statusMenu.style.left = `${Math.min(x, innerWidth - statusMenu.offsetWidth - 8)}px`;
  statusMenu.style.top = `${Math.min(y, innerHeight - statusMenu.offsetHeight - 8)}px`;
  (statusMenu.querySelector('[aria-checked="true"]') || statusMenu.querySelector("button"))?.focus();
}
function statusTarget(target) {
  const pill = target.closest("[data-status-path]");
  if (pill) return { path: pill.dataset.statusPath, status: pill.dataset.status, pill };
  const row = target.closest("tr[data-select-task]");
  const doc = row && state.documents.find((candidate) => candidate.path === row.dataset.selectTask);
  return doc?.task ? { path: doc.path, status: doc.task.status, pill: row.querySelector("[data-status-path]") } : null;
}
document.addEventListener("click", (event) => {
  const pill = event.target.closest("[data-status-path]");
  if (!pill) return;
  const rect = pill.getBoundingClientRect();
  openStatusMenu(pill.dataset.statusPath, pill.dataset.status, rect.left, rect.bottom + 4);
});
document.addEventListener("contextmenu", (event) => {
  const target = statusTarget(event.target);
  if (!target) return;
  event.preventDefault();
  openStatusMenu(target.path, target.status, event.clientX, event.clientY);
});
statusMenu.addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  const items = [...statusMenu.querySelectorAll("button")];
  items[(items.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
});
statusMenu.addEventListener("click", async (event) => {
  const choice = event.target.closest("[data-set-status]");
  if (!choice) return;
  statusMenu.hidePopover();
  if (choice.getAttribute("aria-checked") === "true") return;
  try {
    const days = choice.dataset.days ? Number(choice.dataset.days) : undefined;
    const response = await fetch("/api/task-status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: choice.dataset.path, status: choice.dataset.setStatus, days }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not change the task status.");
    showNotice(body.task.status === "waiting" ? `${body.task.id} is waiting; check in ${formatDate(body.task.checkIn)}.` : `${body.task.id} is now ${TASK_STATUS_LABELS[body.task.status].toLowerCase()}.`);
    await refreshFromMarkdown(new Set([choice.dataset.path]));
  } catch (error) {
    showNotice(error.message, true);
  }
});

// ---------- overlays ----------

// Every overlay keeps what it shows in a URL parameter (overlay.js). This table is the one place that maps a parameter
// back to its opener, its Recently viewed row and its Reopen toast; refreshes, Back/Forward, Favorites and the toast
// all go through it. The document peek comes first because it opens over the others, so it is what the URL is "at".
const OVERLAYS = [
  { param: "peek",
    open: (params) => peekDocument(params.get("peek")),
    result: (params) => { const doc = state.documents.find((candidate) => candidate.path === params.get("peek")); return doc ? docResult(doc, []) : { icon: "file", title: escapeHtml(params.get("peek")), detail: "Document", side: "Document" }; },
    closed: (params) => { const doc = state.documents.find((candidate) => candidate.path === params.get("peek")); return ["document", doc ? `${doc.task ? `${doc.task.id} ` : ""}${doc.task?.title || doc.title}` : params.get("peek")]; } },
  { param: "pr", extra: ["file", "scope"],
    open: (params) => { const pr = params.get("pr").split("#"); if (pr.length === 2) openPrOverlay(pr[0], Number(pr[1]), params.get("file") || "", params.get("scope") || ""); },
    result: (params) => { const [slug, number] = params.get("pr").split("#"); return prResult(findPr(slug, Number(number)) || { slug, number: Number(number) }, []); },
    closed: (params) => { const [slug, number] = params.get("pr").split("#"); return ["PR overview", `${prNumberLabel(slug, number)} ${findPr(slug, Number(number))?.title || ""}`.trim()]; } },
  { param: "wt", extra: ["file", "scope"],
    open: (params) => openWorktreeOverlay(params.get("wt"), params.get("file") || "", params.get("scope") || ""),
    result: (params) => ({ icon: "branch", title: escapeHtml(params.get("wt").split("/").pop()), detail: escapeHtml(params.get("wt").replace(/^\/Users\/[^/]+/, "~")), side: "Worktree" }),
    closed: (params) => ["worktree overview", params.get("wt").split("/").pop()] },
  { param: "issue",
    open: (params) => openIssue(params.get("issue")),
    result: (params) => { const issue = cachedIssues()?.issues?.find((candidate) => candidate.key === params.get("issue")); return issue ? issueResult(issue, []) : { icon: "issue", title: escapeHtml(params.get("issue")), detail: "Jira issue", side: "Issue" }; },
    closed: (params) => { const key = params.get("issue"); const issue = cachedIssues()?.issues?.find((candidate) => candidate.key === key); return [`${issue?.type === "Project" ? "project" : "issue"} overview`, issue ? `${issue.type === "Project" ? "" : issue.label || issue.key} ${issue.summary}`.trim() : key.replace(/^linear:/, "")]; } },
  { param: "slack",
    open: (params) => { if (isSlackLink(params.get("slack")) && config().slack.codex?.length) openSlackThread(params.get("slack")); },
    result: (params) => ({ icon: "slack", title: escapeHtml(slackThreadTitle(params.get("slack"))), detail: "Slack thread", side: "Slack" }),
    closed: (params) => ["Slack thread", slackThreadTitle(params.get("slack"))] },
  { param: "diagram",
    // On the Diagrams page the cards arrive with the list, so the viewer waits for them and opens with all of them.
    open: (params) => { if (state.view === "diagrams" && !state.diagrams) pendingDiagram = params.get("diagram"); else openDiagram(params.get("diagram")); },
    result: (params) => ({ icon: "file", title: escapeHtml(params.get("diagram").split("/").pop()), detail: escapeHtml(params.get("diagram")), side: "Diagram" }),
    closed: (params) => ["diagram", params.get("diagram").split("/").pop()] },
  { param: "plan", extra: ["doc"],
    open: (params) => openPlan(params.get("plan"), params.get("doc") || ""),
    result: (params) => { const plan = params.get("plan"); return { icon: "initiative", title: escapeHtml(planTitle(plan) || plan.split("/").pop()), detail: escapeHtml(`${plan.split(":")[0].split("/").pop()} · ${params.get("doc")?.split("/").pop() || "initiative"}`), side: "Initiative" }; },
    closed: (params) => ["initiative reader", planTitle(params.get("plan")) || params.get("plan").split("/").pop()] },
];
const overlayOf = (params) => OVERLAYS.find((overlay) => params.get(overlay.param));
// Opens the overlays a URL names, bottom first, skipping any already open with the same subject.
function openOverlays(params, open = new URLSearchParams()) {
  for (const overlay of [...OVERLAYS].reverse()) if (params.get(overlay.param) && params.get(overlay.param) !== open.get(overlay.param)) overlay.open(params);
}

// ---------- recently viewed ----------

// Every page and PR/worktree overview this browser has shown, newest first, so a stray Escape is one click from undone.
// Recorded from the URL, which every view and overview already keeps current.
const VISITS_KEY = "viewer-visits";
let visits = [];
try { visits = JSON.parse(localStorage.getItem(VISITS_KEY) || "[]"); } catch {}
const pageKey = (url) => {
  const params = new URLSearchParams(url.search);
  for (const name of ["graph", ...OVERLAYS.flatMap((overlay) => [overlay.param, ...(overlay.extra || [])])]) params.delete(name);
  return params.toString();
};
const visitKey = (url) => { const overlay = overlayOf(url.searchParams); return overlay ? `${overlay.param}:${url.searchParams.get(overlay.param)}` : pageKey(url); };
function recordVisit() {
  const url = new URL(location.href);
  const key = visitKey(url);
  visits = [{ key, href: url.pathname + url.search + url.hash, at: Date.now() }, ...visits.filter((visit) => visit.key !== key)].slice(0, 30);
  try { localStorage.setItem(VISITS_KEY, JSON.stringify(visits)); } catch {}
  if (state.documents.length) renderFavorites(); // before boot loads documents, titles aren't known yet
}
for (const method of ["pushState", "replaceState"]) {
  const original = history[method].bind(history);
  history[method] = (...args) => { original(...args); recordVisit(); };
}
window.addEventListener("popstate", recordVisit);

// Places you return to often, pinned by ⌘D or the star until you press it again, and listed at the top of the
// sidebar. Keyed like visits, so a PR is one favorite whichever file or scope was open, and the href reopens it as you left it.
const FAVORITES_KEY = "viewer-favorites";
let favorites = [];
try { favorites = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"); } catch {}
const isFavorite = (href) => favorites.some((favorite) => favorite.key === visitKey(new URL(href, location.href)));
function toggleFavorite(href = location.href) {
  const url = new URL(href, location.href);
  const key = visitKey(url);
  const removing = isFavorite(href);
  favorites = removing ? favorites.filter((favorite) => favorite.key !== key) : [{ key, href: url.pathname + url.search + url.hash, at: Date.now() }, ...favorites];
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites)); } catch {}
  const title = document.createElement("span");
  title.innerHTML = visitResult(href).title;
  showNotice(removing ? "Removed from favorites" : "Added to favorites", false, { kind: removing ? "info" : "success", description: title.textContent, action: { label: "Undo", run: () => toggleFavorite(href) } });
  renderFavorites();
}
const favoritesNav = document.querySelector("#favorites");
const favoriteStar = document.querySelector("#favorite-star");
favoriteStar.addEventListener("click", () => toggleFavorite());
function renderFavorites() {
  const current = visitKey(new URL(location.href));
  favoritesNav.hidden = !favorites.length;
  favoritesNav.innerHTML = `<h2 class="group-label">Favorites</h2>${favorites.map((favorite) => {
    const { icon, tone, title } = visitResult(favorite.href);
    return `<a class="document-link favorite-link" href="${escapeHtml(favorite.href)}" data-visit-href="${escapeHtml(favorite.href)}" aria-current="${favorite.key === current ? "page" : "false"}"><span class="search-icon is-${tone || icon}"><svg viewBox="0 0 24 24" aria-hidden="true">${SEARCH_ICONS[icon]}</svg></span><strong>${title}</strong></a>`;
  }).join("")}`;
  for (const link of favoritesNav.querySelectorAll("strong")) link.parentElement.title = link.textContent;
  const on = favorites.some((favorite) => favorite.key === current);
  favoriteStar.setAttribute("aria-pressed", String(on));
  favoriteStar.setAttribute("aria-label", `${on ? "Remove from favorites" : "Favorite"} (${modKey}D)`);
  favoriteStar.querySelector("svg").innerHTML = GLYPHS.star;
  refreshSlackPage();
  refreshSlackStars();
}
favoritesNav.addEventListener("click", (event) => {
  const link = event.target.closest("[data-visit-href]");
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return; // modified clicks open a new tab
  event.preventDefault();
  resumeVisit(link.dataset.visitHref);
});
// The star sits in the header of whatever is on top: the open overview (PR, worktree, issue, initiative), else the page.
// Overview headers re-render often, so an observer puts it back before their close button.
// ponytail: observes the whole body; scope it to the dialogs if it ever shows in a profile.
function placeStar() {
  const head = [...document.querySelectorAll("dialog.code-diff[open] .code-diff-head")].at(-1);
  const close = head?.querySelector("[data-diff-close], [data-issue-close], [data-plan-close], [data-slack-close], [data-peek-close]");
  if (close && close.previousElementSibling !== favoriteStar) close.before(favoriteStar);
  else if (!close && favoriteStar.parentElement !== elements.count.parentElement) elements.count.before(favoriteStar);
}
// Hovering a link that opens an overlay mustn't leave its tooltip floating over the overlay.
new MutationObserver((records) => { if (records.some((record) => record.attributeName === "open" && record.target.open)) { hideTip(); hideLinkTip(); closeRailCard(); } }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
new MutationObserver(placeStar).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });

const prNumberLabel = (slug, number) => `${slug === referenceConfig().defaultSlug ? "" : slug.split("/")[1]}#${number}`;
const findPr = (slug, number) => cachedPrIndex()?.prs.find((pr) => pr.slug === slug && pr.number === number);

// A recorded URL as ⌘K would show it: the PR or worktree overview it had open, else the page or document.
function visitResult(href) {
  const params = new URL(href, location.href).searchParams;
  const overlay = overlayOf(params);
  if (overlay) return overlay.result(params);
  const view = params.get("view");
  const doc = (path) => state.documents.find((candidate) => candidate.path === path);
  const page = (icon, title, detail) => ({ icon, title: escapeHtml(title), detail: escapeHtml(detail), side: "Page" });
  if (view === "tasks") return doc(`tasks/${params.get("task")}.md`) ? docResult(doc(`tasks/${params.get("task")}.md`), []) : page("list", "Tasks", "Every task by status");
  if (view === "code") return page("code", "Code", CODE_TABS[params.get("tab") || "prs"] || "Pull requests");
  if (view === "issues") return page("issue", "Issues", ISSUE_TABS[params.get("tab") || "all"] || "All");
  if (view === "slack") return page("slack", "Slack", "Linked threads");
  if (view === "activity") return page("plan", "Activity", "Everything that changed");
  if (view === "diagrams") return page("plan", "Diagrams", "Every diagram in the workspace");
  if (view in LIBRARY_VIEWS) return page(view === "topics" ? "topic" : "reference", LIBRARY_VIEWS[view].title, LIBRARY_VIEWS[view].intro);
  const path = params.get("path") || state.defaultPath;
  // A work item dialog (`?item=`) is its own place, not the task behind it.
  const work = doc(path)?.task?.work?.find((candidate) => candidate.id === params.get("item"));
  if (work) return workResult({ work, doc: doc(path) }, []);
  return doc(path) ? docResult(doc(path), []) : { icon: "file", title: escapeHtml(path), detail: "No longer in the planning folders", side: "Document" };
}

// Goes back to a recorded URL through the same routes as Back/Forward, then reopens its overview if it had one.
function resumeVisit(href) {
  const url = new URL(href, location.href);
  const samePage = pageKey(url) === pageKey(location);
  const open = samePage ? new URLSearchParams(location.search) : undefined;
  if (samePage) history.replaceState(null, "", url);
  else { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); }
  if (overlayOf(url.searchParams)) openOverlays(url.searchParams, open);
  else closeOverview();
}
// Going to a plain page from over the PR/worktree overview closes it (its toast offers Reopen).
const closeOverview = () => { for (const overlay of document.querySelectorAll("dialog.code-diff[open]")) overlay.close(); };

document.addEventListener("overview-closed", (event) => {
  const params = new URL(event.detail).searchParams;
  const overlay = overlayOf(params);
  if (!overlay) return;
  const [noun, description] = overlay.closed(params);
  showNotice(`Closed the ${noun}`, false, { kind: "info", description, action: { label: "Reopen", run: () => resumeVisit(event.detail) } });
});

const historyMenu = document.querySelector("#history-menu");
const historyRows = () => [...historyMenu.querySelectorAll(".search-results:not([hidden]) [data-visit-href]:not([hidden])")];
// Viewed and Changed are separate tabs so a burst of agent edits can't bury where you've been. The row under
// "You are here" names the open one; Tab, or a click anywhere on that row, flips to the other.
function showHistoryTab(tab = historyMenu.querySelector('[data-history-tab][aria-selected="false"]').dataset.historyTab) {
  for (const button of historyMenu.querySelectorAll("[data-history-tab]")) button.setAttribute("aria-selected", String(button.dataset.historyTab === tab));
  for (const list of historyMenu.querySelectorAll("[data-history-list]")) list.hidden = list.dataset.historyList !== tab;
  historyFilter().focus(); // a click on the row shouldn't take typing away from the filter
  filterHistory();
}
const historyFilter = () => historyMenu.querySelector(".history-filter input");
function selectHistoryRow(row) {
  for (const candidate of historyMenu.querySelectorAll("[data-visit-href]")) candidate.setAttribute("aria-selected", String(candidate === row));
  if (document.activeElement !== historyFilter()) row?.focus({ preventScroll: true }); // while typing, focus stays in the filter

  row?.scrollIntoView({ block: "nearest" });
}
historyMenu.addEventListener("beforetoggle", (event) => {
  if (event.newState !== "open") return;
  const current = visitKey(new URL(location.href));
  const shown = visits.filter((visit) => visit.key !== current);
  const changed = documentChanges.filter((change, index) => change.kind !== "deleted" && documentChanges.findIndex((other) => other.path === change.path) === index).slice(0, 8);
  const changeRows = changed.map((change, index) => resultRow({
    ...visitResult(changeHref(change)),
    detail: escapeHtml(changeSummary(change)),
    marker: index < 9 ? index + 1 : "",
    side: Date.now() - change.at < 60_000 ? "just now" : `${ago(change.at)} ago`,
    tag: "button",
    attrs: `type="button" role="option" aria-selected="false" data-visit-href="${escapeHtml(changeHref(change))}"`,
  }));
  const rows = shown.map((visit, index) => resultRow({
    ...visitResult(visit.href),
    marker: index < 9 ? index + 1 : "", // the 1–9 jump key
    side: Date.now() - visit.at < 60_000 ? "just now" : `${ago(visit.at)} ago`,
    tag: "button",
    attrs: `type="button" role="option" aria-selected="false" data-visit-href="${escapeHtml(visit.href)}"`,
  }));
  // The page you're on, pinned above the list, so it's clear what picking a row will replace.
  const here = resultRow({ ...visitResult(location.href), side: "", className: "history-here", marker: "" });
  historyMenu.style.height = "";
  const empty = (title, text) => `<div class="search-empty"><strong>${title}</strong><span>${text}</span></div>`;
  const tabs = [["viewed", "Recently viewed"], ["changed", "Recently changed"]].map(([tab, label]) => `<button type="button" role="tab" tabindex="-1" data-history-tab="${tab}" aria-selected="${tab === "viewed"}">${label}<span class="history-tab-count"></span></button>`).join("");
  historyMenu.innerHTML = `<label class="search-field history-filter"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.search}</svg><span class="sr-only">Filter recent places</span><input type="search" placeholder="Type to filter…" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">Esc</kbd></label><section class="history-here-wrap" aria-label="You are here"><div class="search-section">You are here</div>${here}</section><div class="history-switch" data-history-switch><span role="tablist" aria-label="Recent places">${tabs}</span><span class="history-switch-key"><kbd>Tab</kbd> switch</span></div><div class="search-results" role="listbox" aria-label="Recently viewed" data-history-list="viewed">${rows.join("") || empty("Nothing yet", "Pages, PRs and worktrees you open will appear here.")}</div><div class="search-results" role="listbox" aria-label="Recently changed" data-history-list="changed" hidden>${changeRows.join("") || empty("No changes yet", "Documents edited outside the viewer will appear here.")}</div><footer class="viewer-dialog-footer search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> select <kbd>↵</kbd> open <kbd>1</kbd>–<kbd>9</kbd> jump <kbd>Esc</kbd> close</span></footer>`;
});
// Every word must appear in the row's title or detail; the 1–9 markers renumber over what's left. The filter covers
// both tabs, so each tab's count says whether the other one has matches.
function filterHistory() {
  const words = historyFilter().value.toLowerCase().split(/\s+/).filter(Boolean);
  for (const row of historyMenu.querySelectorAll("[data-history-list] [data-visit-href]")) row.hidden = !words.every((word) => row.textContent.toLowerCase().includes(word));
  for (const list of historyMenu.querySelectorAll("[data-history-list]")) {
    historyMenu.querySelector(`[data-history-tab="${list.dataset.historyList}"] .history-tab-count`).textContent = list.querySelectorAll("[data-visit-href]:not([hidden])").length;
  }
  const all = [...historyMenu.querySelectorAll(".search-results:not([hidden]) [data-visit-href]")];
  const rows = historyRows();
  rows.forEach((row, index) => { row.querySelector(".result-marker").textContent = index < 9 ? index + 1 : ""; });
  historyMenu.querySelector(".history-none")?.remove();
  const other = historyMenu.querySelector('[data-history-tab][aria-selected="false"]');
  const elsewhere = Number(other.querySelector(".history-tab-count").textContent);
  const hint = elsewhere ? `${elsewhere} ${elsewhere === 1 ? "match" : "matches"} in ${other.firstChild.textContent}. Press Tab.` : "Esc clears the filter.";
  if (all.length && !rows.length) historyMenu.querySelector(".search-results:not([hidden])").insertAdjacentHTML("beforeend", `<div class="search-empty history-none"><strong>No matches</strong><span>${hint}</span></div>`);
  selectHistoryRow(rows[0]);
}
historyMenu.addEventListener("input", filterHistory);
historyMenu.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-history-tab]");
  if (tab || event.target.closest("[data-history-switch]")) { showHistoryTab(tab?.dataset.historyTab); return; }
  const row = event.target.closest("[data-visit-href]");
  if (!row) return;
  historyMenu.hidePopover();
  resumeVisit(row.dataset.visitHref);
});
historyMenu.addEventListener("mousemove", (event) => {
  const row = event.target.closest("[data-visit-href]");
  if (row && row.getAttribute("aria-selected") !== "true") selectHistoryRow(row);
});
// However it opens (H or the button), the filter has focus and the newest row is selected, so typing, arrows and Enter work at once. Only Esc closes, so H stays searchable.
const historyButton = document.querySelector("#open-history");
historyButton.addEventListener("click", () => (historyMenu.matches(":popover-open") ? historyMenu.hidePopover() : openHistoryMenu()));
historyMenu.addEventListener("toggle", (event) => historyButton.setAttribute("aria-expanded", String(event.newState === "open")));
historyMenu.addEventListener("toggle", (event) => { if (event.newState === "open" && !historyMenu.contains(document.activeElement)) { historyFilter().focus(); selectHistoryRow(historyRows()[0]); } });
// A modal dialog makes everything outside it inert, so the menu moves into the top open dialog to stay usable above it.
function openHistoryMenu() {
  const host = [...document.querySelectorAll("dialog[open]")].at(-1) || document.body;
  if (historyMenu.parentElement !== host) host.append(historyMenu);
  historyMenu.showPopover();
  // Sized to the taller tab, so flipping between them doesn't resize the menu.
  const lists = [...historyMenu.querySelectorAll("[data-history-list]")];
  const heights = lists.map((shown) => { for (const list of lists) list.hidden = list !== shown; return historyMenu.offsetHeight; });
  lists.forEach((list, index) => { list.hidden = index > 0; });
  historyMenu.style.height = `${Math.max(...heights)}px`;
  historyFilter().focus(); // now, not on the async toggle event, so typing right after H lands in the filter
  filterHistory(); // fills the tab counts and selects the newest row
}
historyMenu.addEventListener("keydown", (event) => {
  event.stopPropagation(); // inside the PR overview, its J/K/arrow keys must not also fire
  const rows = historyRows();
  const filter = historyFilter();
  const typing = !event.metaKey && !event.ctrlKey && !event.altKey;
  if (/^[1-9]$/.test(event.key) && typing && rows[event.key - 1]) { event.preventDefault(); rows[event.key - 1].click(); return; }
  if (event.key === "Tab") { event.preventDefault(); showHistoryTab(); return; }
  if (event.key === "Escape" && filter.value) { event.preventDefault(); filter.value = ""; filterHistory(); return; } // a second Esc closes
  if (event.key === "Enter" && event.target === filter) { event.preventDefault(); historyMenu.querySelector('[data-visit-href][aria-selected="true"]:not([hidden])')?.click(); return; }
  // Letters typed anywhere in the menu go to the filter, so H then "snow" narrows the list.
  if (event.target !== filter && typing && (event.key.length === 1 || (event.key === "Backspace" && filter.value))) {
    event.preventDefault();
    filter.value = event.key === "Backspace" ? filter.value.slice(0, -1) : filter.value + event.key;
    filter.focus();
    filterHistory();
    return;
  }
  if (!["ArrowDown", "ArrowUp"].includes(event.key) || !rows.length) return;
  event.preventDefault();
  selectHistoryRow(rows[(rows.findIndex((row) => row.getAttribute("aria-selected") === "true") +(event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]);
});

async function boot() {
  try {
    const response = await fetch("/api/documents");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load the document list.");
    state.documents = body.documents;
    state.defaultPath = body.defaultPath;
    updateNavCounts();
    loadWaiting();
    const requested = new URLSearchParams(location.search).get("path");
    const requestedView = new URLSearchParams(location.search).get("view");
    const initial = state.documents.find((doc) => doc.path === requested)?.path
      || state.documents.find((doc) => doc.path === body.defaultPath)?.path
      || state.documents[0]?.path;
    renderLibrary();
    if (requestedView === "tasks") {
      selectedTaskPath = taskFromUrl();
      renderTasksPage();
    }
    else if (requestedView in LIBRARY_VIEWS) renderLibraryPage(requestedView);
    else if (requestedView === "diagrams") renderDiagramsPage();
    else if (requestedView === "code") renderCode();
    else if (requestedView === "issues") renderIssues();
    else if (requestedView === "slack") renderSlack();
    else if (requestedView === "activity") renderActivity();
    else if (initial) await selectDocument(initial, { historyMode: "none", anchor: locationAnchor() });
    else showNotice("No supported files were found under daily, tasks, plans, or reference.", true);
    connectLiveUpdates();
    loadDiagrams();
    loadPrIndex().catch(() => {}); // so ⌘K lists PRs on its first paint instead of inserting them a moment later
    openOverlays(new URLSearchParams(location.search));
    if (issuesOn()) loadIssues().then(() => { renderFavorites(); updateNavCounts(); }).catch(() => {}); // ⌘K finds issues by key and title
    loadPrIndex().then(() => { renderFavorites(); updateNavCounts(); }).catch(() => {}); // PR favorites get their titles
    if (config().slack.codex?.length) fetch("/api/slack").then((response) => response.json()).then((data) => { slackThreads = data.threads || []; updateNavCounts(); }).catch(() => {});
    recordVisit();
  } catch (error) {
    showNotice(error.message, true);
  }
}

// viewer.config.json drives reference links and labels, so it loads before anything renders.
try {
  setConfig(await fetch("/api/config").then((response) => response.json()));
  document.title = config().title;
  elements.issuesButton.hidden = !issuesOn();
  elements.slackButton.hidden = !config().slack.codex?.length;
} catch {}
// Before the first render, so every avatar starts with the reconciled picture; answers from the server's cache.
await fetch("/api/people").then((response) => response.json()).then((body) => setPeople(body.people)).catch(() => {});
installCommitCards({ showNotice });
boot();
