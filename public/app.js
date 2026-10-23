import { searchDocuments, searchPrs } from "./search.js";
import { renderActions, renderWorkBreakdown } from "./actions.js";
import { applyLinkMetadata, collectLinks, metadataKey, renderDock } from "./dock.js";
import { GLYPHS } from "./icons.js";
import { delimitedTable, documentHref, escapeHtml, markdownOutline, renderChatLinks, renderMarkdown as renderMarkdownSource, renderUpdates, SERVICE_ICONS } from "./markdown.js";
import { TABS as CODE_TABS, ago, cachedPrIndex, commitLinkMatch, diffSize, icon, modKey, installCommitCards, loadPrIndex, openCommit, openPrOverlay, openWorktreeOverlay, openServers, isSummonKey, prefetchPr, renderCodePage } from "./code.js";
import { TABS as ISSUE_TABS, cachedIssues, connectPlanning, loadIssues, openIssue, renderIssuesPage } from "./issues.js";
import { cachedPlans, loadPlans, openPlan, planTitle, searchPlans, setPlanNotice } from "./plans.js";
import { AGENTS, agentApp, agentName, config, referenceConfig, setConfig, setAgentApp } from "./config.js";
import { addDays, buildWeeks, dateKey, localTodayKey, parseDateKey, startOfWeek } from "./weeks.js";

const state = { documents: [], defaultPath: "", selectedPath: "", document: null, activeChunkId: "", openComposer: null, view: "document", weekAnchor: null };

const elements = {
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
  weeksButton: document.querySelector("#open-weeks"),
  codeButton: document.querySelector("#open-code"),
  issuesButton: document.querySelector("#open-issues"),
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
const imageViewerState = { items: [], index: 0, scale: 1, fitScale: 1, isFitView: true, offset: { x: 0, y: 0 }, pan: null, trigger: null };

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
}
setPlanNotice(showNotice);
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
  if (doc.kind === "Plan" || doc.kind === "Done") return doc.kind;
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
  elements.weeksButton.setAttribute("aria-current", "false");
  elements.codeButton.setAttribute("aria-current", "false");
  elements.issuesButton.setAttribute("aria-current", "false");
  elements.chunks.classList.remove("tasks-page", "weeks-page", "library-page", "code-page", "issues-page");
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

  // One line per day: fixed Plan and Done slots. A day's other files are reached from its plan's breadcrumb switcher.
  const daySlot = (doc, label, current) => doc
    ? `<button class="document-link day-slot" data-path="${escapeHtml(doc.path)}" aria-current="${current ? "page" : "false"}" title="${escapeHtml(doc.title)}"><strong>${label}</strong></button>`
    : `<span class="day-slot is-empty" aria-hidden="true"></span>`;
  const dayRow = (date, docs, isToday = false) => {
    const day = new Date(`${date}T12:00:00`);
    const plan = docs.find((doc) => doc.kind === "Plan");
    const done = docs.find((doc) => doc.kind === "Done");
    const others = docs.filter((doc) => doc !== plan && doc !== done);
    const first = plan || others[0];
    const firstCurrent = first && (first.path === state.selectedPath || others.some((doc) => doc.path === state.selectedPath));
    return `<section class="date-group${isToday ? " is-today" : ""}"><h3><time datetime="${date}" title="${escapeHtml(formatDate(date, true))}"><span>${day.toLocaleDateString("en-US", { weekday: "short" })}</span>${day.getDate()}</time></h3><div class="date-files">${daySlot(first, plan ? "Plan" : "Notes", firstCurrent)}${daySlot(done, "Done", done?.path === state.selectedPath)}</div></section>`;
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
  elements.documents.innerHTML = sections.join("") || `<p class="empty-library">No planning documents found.</p>`;
  if (elements.searchDialog.open) renderSearchResults();
}

const TASK_STATUS_LABELS = { open: "Open", active: "Active", waiting: "Waiting", deferred: "Deferred", completed: "Completed" };
const TASK_STATUS_ORDER = { active: 0, waiting: 1, open: 2, deferred: 3, completed: 4 };

function statusPill(task, path) {
  return `<button type="button" class="task-status task-status-${task.status}" data-status-path="${escapeHtml(path)}" data-status="${task.status}" aria-haspopup="menu" title="Change status">${TASK_STATUS_LABELS[task.status]}</button>`;
}

const TASK_SORTS = {
  id: (a, b) => a.task.id.localeCompare(b.task.id),
  title: (a, b) => a.task.title.localeCompare(b.task.title),
  status: (a, b) => TASK_STATUS_ORDER[a.task.status] - TASK_STATUS_ORDER[b.task.status] || b.task.updated.localeCompare(a.task.updated),
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

function taskDocuments(includeCompleted = false) {
  return state.documents
    .filter((doc) => doc.task && (includeCompleted || doc.task.status !== "completed"))
    .sort((a, b) => taskSort.dir * TASK_SORTS[taskSort.key](a, b) || a.task.id.localeCompare(b.task.id));
}

function updateTasksUrl(historyMode) {
  if (historyMode === "none") return;
  const url = new URL(location.href);
  const task = selectedTaskPath.match(/TASK-\d{4}/)?.[0];
  url.search = new URLSearchParams({ view: "tasks", ...(task ? { task } : {}) });
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
  const tasks = taskDocuments();
  state.view = "tasks";
  resetPageNavigation();
  elements.tasksButton.setAttribute("aria-current", "page");
  for (const file of elements.documents.querySelectorAll('.document-link[aria-current="page"]')) file.setAttribute("aria-current", "false");
  elements.title.textContent = "Tasks";
  elements.meta.textContent = "Repository tasks  /  unfinished";
  elements.count.textContent = `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`;
  elements.chunkNav.hidden = true;
  elements.chunkNav.replaceChildren();
  elements.chunks.classList.add("tasks-page");
  if (!tasks.some((doc) => doc.path === selectedTaskPath)) selectedTaskPath = taskPaneVisible() ? tasks[0]?.path || "" : "";
  elements.chunks.innerHTML = `<section class="task-browser" aria-label="Unfinished tasks">
    <div class="task-index">${tasks.length ? `<table class="task-table">
      <thead><tr>${taskSortHeader("id", "ID")}${taskSortHeader("title", "Task")}${taskSortHeader("status", "Status")}${taskSortHeader("project", "Project")}${taskSortHeader("refs", "Refs")}${taskSortHeader("updated", "Updated")}</tr></thead>
      <tbody>${tasks.map((doc) => `<tr data-select-task="${escapeHtml(doc.path)}" aria-selected="${doc.path === selectedTaskPath}">
        <td class="task-col-id"><button class="task-list-id" type="button" data-task-path="${escapeHtml(doc.path)}" title="Open ${escapeHtml(doc.task.id)}">${escapeHtml(doc.task.id)}</button></td>
        <td class="task-col-title"><button class="task-row-select" type="button" data-select-task="${escapeHtml(doc.path)}">${escapeHtml(doc.task.title)}</button></td>
        <td class="task-col-status">${statusPill(doc.task, doc.path)}</td>
        <td class="task-col-project">${escapeHtml(doc.task.project)}</td>
        <td class="task-col-refs">${doc.task.referencedBy?.length || "—"}</td>
        <td class="task-col-updated"><time datetime="${escapeHtml(doc.task.updated)}" title="${escapeHtml(formatDate(doc.task.updated, true))}">${escapeHtml(new Date(`${doc.task.updated}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</time></td>
      </tr>`).join("")}</tbody>
    </table>` : `<p class="task-empty">No unfinished tasks found.</p>`}</div>
    <aside class="task-detail" id="task-detail" aria-live="polite"></aside>
  </section>`;
  renderTaskDetail();
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
  pane.innerHTML = `${head}<section class="task-detail-section task-detail-actions"><h4>Next actions</h4><p class="task-detail-empty">Loading…</p></section>${refs}${chats}`;
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
  elements.meta.textContent = `Jira  /  ${config().issues.jql}`;
  elements.count.textContent = "";
  elements.chunkNav.hidden = true;
  elements.chunkNav.replaceChildren();
  elements.chunks.classList.add("code-page", "issues-page");
  renderIssuesPage(elements.chunks, { tab, showNotice });
}

function formatCalendarDay(date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function formatCalendarRange(first, last) {
  const sameYear = first.getUTCFullYear() === last.getUTCFullYear();
  const start = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(first);
  const end = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(last);
  return `${start} – ${end}`;
}

function updateWeeksUrl(historyMode) {
  if (historyMode === "none") return;
  const url = new URL(location.href);
  url.search = new URLSearchParams({ view: "weeks", date: dateKey(state.weekAnchor) });
  url.hash = "";
  history[historyMode === "push" ? "pushState" : "replaceState"](null, "", url);
}

const CALENDAR_TASK_LIMIT = 6;

// A day shows what it was about: the plan's scheduled tasks (✓ when that day's done log mentions them), then a
// footer with the outcome count and any extra notes. A done-only day lists the tasks its log touched.
function calendarDayBody(docs) {
  const plan = docs.find((doc) => doc.kind === "Plan");
  const done = docs.find((doc) => doc.kind === "Done");
  const notes = docs.filter((doc) => doc !== plan && doc !== done);
  const planned = (plan || done)?.digest?.tasks || [];
  const finished = new Set(done?.digest?.mentions || []);
  // Work the done log touched that the plan never scheduled shows after the plan, marked as unplanned.
  const unplanned = plan ? [...finished].filter((id) => !planned.some((task) => task.id === id) && state.documents.some((doc) => doc.task?.id === id)).map((id) => ({ id, note: "", unplanned: true })) : [];
  const tasks = [...planned, ...unplanned];
  const taskRow = ({ id, note, unplanned: extra }) => {
    const summary = state.documents.find((doc) => doc.task?.id === id);
    const touched = finished.has(id);
    return `<button class="calendar-task${touched ? " is-touched" : ""}${extra ? " is-unplanned" : ""}" type="button" data-task-id="${id}" data-calendar-path="${escapeHtml(summary?.path || `tasks/${id}.md`)}" title="${escapeHtml(`${id} · ${summary?.task.title || ""}${note ? `\n${note}` : ""}${extra ? "\nNot on the plan; touched in the done log" : touched ? "\nIn this day's done log" : ""}`)}">
      <span class="calendar-task-dot task-dot-${summary?.task.status || "missing"}" aria-hidden="true"></span>
      <span class="calendar-task-title">${escapeHtml(summary?.task.title || id)}</span>
      ${extra ? '<span class="calendar-task-check is-extra" aria-label="unplanned, in done log">+</span>' : touched ? '<span class="calendar-task-check" aria-label="in done log">✓</span>' : ""}
    </button>`;
  };
  const headings = tasks.length ? [] : plan?.digest?.headings || [];
  const headingRow = (heading) => `<button class="calendar-task is-heading" type="button" data-calendar-path="${escapeHtml(plan.path)}" title="${escapeHtml(heading)}"><span class="calendar-task-dot task-dot-heading" aria-hidden="true"></span><span class="calendar-task-title">${escapeHtml(heading)}</span></button>`;
  const rows = tasks.length ? tasks.map(taskRow) : headings.map(headingRow);
  const more = rows.length - CALENDAR_TASK_LIMIT;
  const touchedCount = planned.filter((task) => finished.has(task.id)).length;
  const footer = [
    plan && done && planned.length ? `<span class="calendar-progress" title="Scheduled tasks mentioned in the done log"><span style="--done:${touchedCount / planned.length}"></span>${touchedCount}/${planned.length}</span>` : "",
    done?.digest?.items ? `<button class="calendar-meta" type="button" data-calendar-path="${escapeHtml(done.path)}">${done.digest.items} ${done.digest.items === 1 ? "outcome" : "outcomes"}</button>` : "",
    notes.length ? `<button class="calendar-meta" type="button" data-calendar-path="${escapeHtml(notes[0].path)}" title="${escapeHtml(notes.map((doc) => doc.title).join("\n"))}">+${notes.length} ${notes.length === 1 ? "note" : "notes"}</button>` : "",
  ].filter(Boolean).join("");
  return `${rows.length ? `<div class="calendar-tasks">${rows.slice(0, CALENDAR_TASK_LIMIT).join("")}${more > 0 ? `<button class="calendar-more" type="button" data-calendar-path="${escapeHtml((plan || done).path)}">+${more} more</button>` : ""}</div>` : ""}${footer ? `<div class="calendar-footer">${footer}</div>` : ""}`;
}

function calendarDayLinks(docs) {
  return docs.filter((doc) => doc.kind === "Plan" || doc.kind === "Done").sort((a, b) => dailyRank(a.path) - dailyRank(b.path))
    .map((doc) => `<button class="calendar-doc" type="button" data-calendar-path="${escapeHtml(doc.path)}">${doc.kind}</button>`).join("");
}

// Weeks without files collapse to one thin strip; consecutive quiet weeks share a single strip.
function weekRows(weeks, documentsByDate, today) {
  const rows = [];
  for (const week of weeks) {
    const keys = week.map(dateKey);
    const quiet = !keys.some((key) => documentsByDate.has(key) || key === today);
    if (quiet && rows.at(-1)?.quiet) { rows.at(-1).to = week.at(-1); continue; }
    rows.push({ week, quiet, from: week[0], to: week.at(-1) });
  }
  return rows.map((row) => row.quiet
    ? `<div class="week-quiet">${formatCalendarDay(row.from)} – ${formatCalendarDay(row.to)} · no entries</div>`
    : `<div class="week-row">${row.week.map((date) => {
      const key = dateKey(date);
      const docs = documentsByDate.get(key) || [];
      const isToday = key === today;
      return `<section class="calendar-day${isToday ? " is-today" : ""}${docs.length ? " has-files" : ""}" aria-label="${formatDate(key, true)}${isToday ? ", today" : ""}">
        <div class="calendar-date"><time datetime="${key}">${formatCalendarDay(date)}</time>${isToday ? `<span class="calendar-today">Today</span>` : ""}<span class="calendar-docs">${calendarDayLinks(docs)}</span></div>
        ${docs.length ? calendarDayBody(docs) : ""}
      </section>`;
    }).join("")}</div>`).join("");
}

function renderWeeksPage() {
  const today = localTodayKey();
  const weeks = buildWeeks(state.weekAnchor || parseDateKey(today));
  const first = weeks[0][0];
  const last = weeks.at(-1).at(-1);
  const documentsByDate = new Map();
  for (const doc of state.documents) {
    if (!doc.date) continue;
    if (!documentsByDate.has(doc.date)) documentsByDate.set(doc.date, []);
    documentsByDate.get(doc.date).push(doc);
  }

  state.view = "weeks";
  resetPageNavigation();
  elements.weeksButton.setAttribute("aria-current", "page");
  for (const file of elements.documents.querySelectorAll('.document-link[aria-current="page"]')) file.setAttribute("aria-current", "false");
  elements.title.textContent = "Weeks";
  elements.meta.textContent = "Daily archive  /  read only";
  elements.count.textContent = formatCalendarRange(first, last);
  elements.chunkNav.hidden = true;
  elements.chunkNav.replaceChildren();
  elements.chunks.classList.add("weeks-page");
  elements.chunks.innerHTML = `<section class="weeks-surface" aria-label="Planning archive by week">
    <div class="weeks-toolbar">
      <p class="weeks-key"><span><span class="calendar-task-check">✓</span> in that day’s done log</span><span><span class="calendar-task-check is-extra">+</span> unplanned</span><span>Hover a task to follow it across days</span></p>
      <div class="week-controls" aria-label="Calendar navigation">
        <button type="button" data-week-shift="-28" aria-label="Show earlier weeks">←</button>
        <button type="button" data-week-today>Today</button>
        <button type="button" data-week-shift="28" aria-label="Show later weeks">→</button>
      </div>
    </div>
    <div class="calendar-scroll" tabindex="0" aria-label="Five week calendar">
      <div class="weekday-row" aria-hidden="true">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<span>${day}</span>`).join("")}</div>
      <div class="week-rows">${weekRows(weeks, documentsByDate, today)}</div>
    </div>
  </section>`;
  window.scrollTo({ top: 0, behavior: "instant" });
}

function showWeeks({ historyMode = "push", anchor = null } = {}) {
  if (state.openComposer && elements.handoffPopover.matches(":popover-open") && !requestComposerClose()) return;
  closeComposer();
  state.weekAnchor = anchor || state.weekAnchor || parseDateKey(localTodayKey());
  updateWeeksUrl(historyMode);
  renderWeeksPage();
}

function composerTemplate(target) {
  const hint = `<p class="composer-hint"><kbd>Enter</kbd> to open · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · paste images</p>`;
  const close = `<button class="popover-close" type="button" aria-label="Close dialog">×</button>`;
  const heading = (meta) => `<header class="composer-heading"><div><h3>${escapeHtml(target.title)}</h3>${meta ? `<p class="composer-meta">${meta}</p>` : ""}</div>${close}</header>`;
  if (target.scope === "action") {
    const { action } = target;
    const meta = `<span title="${escapeHtml(action.sourcePath)}">${escapeHtml(action.sourcePath.split("/").pop())}</span>${action.workItem ? ` · ${escapeHtml(action.workItem)}` : ""}`;
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
      <footer class="composer-actions">${hint}<button class="cancel-button" type="button">Cancel</button><button class="send-button" type="submit">Open in ${agentName()}</button></footer>
    </form>`;
  }
  const context = target.scope === "chunk"
    ? `<div class="composer-context"><div class="composer-context-body" id="composer-context-body"><div class="markdown">${renderMarkdownSource(target.chunk.markdown, state.selectedPath)}</div></div><button class="context-toggle" type="button" aria-expanded="false" aria-controls="composer-context-body" hidden>Show full chunk</button></div>`
    : "";
  const meta = target.scope === "document" ? escapeHtml(state.selectedPath) : "";
  const fieldLabel = target.scope === "chunk" ? `What should ${agentName()} do with this chunk?` : `What should ${agentName()} do?`;
  return `<form class="composer" data-composer-key="${escapeHtml(target.key)}" data-scope="${target.scope}" ${target.chunk ? `data-chunk-id="${target.chunk.id}"` : ""}>
    ${heading(meta)}
    <div class="composer-body">
      ${context}
      <div class="composer-field">
        <label for="comment-${target.key}">${fieldLabel}</label>
        <textarea id="comment-${target.key}" name="commentary" placeholder="Add direction, a question, or the outcome you want…" required>${escapeHtml(target.commentary || '')}</textarea>
        <div class="composer-images" hidden></div>
      </div>
    </div>
    <footer class="composer-actions">${hint}<button class="cancel-button" type="button">Cancel</button><button class="send-button" type="submit">Open draft in ${agentName()}</button></footer>
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
  if (elements.handoffPopover.matches(":popover-open")) elements.handoffPopover.hidePopover();
  state.openComposer = null;
  handoffTrigger = null;
  elements.handoffPopover.replaceChildren();
  trigger?.setAttribute("aria-expanded", "false");
  elements.globalHandoff.setAttribute("aria-expanded", "false");
  elements.documentHandoff?.setAttribute("aria-expanded", "false");
  for (const button of elements.chunks.querySelectorAll(".handoff-button, [data-action-key]")) button.setAttribute("aria-expanded", "false");
  if (returnFocus) trigger?.focus();
}

// Images in an open overlay (an issue's description) page among themselves; elsewhere among the document's.
function imageViewerItems(trigger) {
  return [...(trigger.closest("dialog") || elements.chunks).querySelectorAll(".markdown-image-trigger")].map((trigger, index) => {
    const image = trigger.querySelector(".markdown-image");
    return {
      trigger,
      src: image.currentSrc || image.src,
      alt: image.alt || `Image ${index + 1}`,
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
  imageViewerState.fitScale = Math.max(.01, Math.min(1, availableWidth / width, availableHeight / height));
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
  const dimensions = item.width && item.height ? `${item.width} × ${item.height}` : "Loading dimensions…";
  elements.imageViewer.innerHTML = `<section class="image-viewer-shell">
    <header class="image-viewer-header">
      <div class="image-viewer-heading">
        <span>${imageViewerState.index + 1} / ${count}</span>
        <h2 id="image-viewer-title">${escapeHtml(item.alt)}</h2>
        <p><span data-image-dimensions>${dimensions}</span> · Scroll to zoom · Drag to pan</p>
      </div>
      <div class="image-viewer-controls" aria-label="Image controls">
        <button type="button" data-image-action="zoom-out" aria-label="Zoom out">−</button>
        <button class="image-viewer-reset" type="button" data-image-action="reset" aria-label="Reset image to fit"><span data-image-zoom>Fit</span><span>Reset</span></button>
        <button type="button" data-image-action="zoom-in" aria-label="Zoom in">+</button>
        <button class="image-viewer-close" type="button" data-image-action="close" aria-label="Close image viewer">×</button>
      </div>
    </header>
    <div class="image-viewer-body${count === 1 ? " is-single" : ""}">
      ${count > 1 ? `<aside class="image-viewer-rail" aria-label="Images in this document">${imageViewerState.items.map((candidate, index) => `<button class="image-viewer-thumbnail" type="button" data-image-index="${index}" aria-current="${index === imageViewerState.index}" aria-label="View image ${index + 1}: ${escapeHtml(candidate.alt)}"><img src="${escapeHtml(candidate.src)}" alt=""><span>${index + 1}</span></button>`).join("")}</aside>` : ""}
      <div class="image-viewer-stage" tabindex="0" aria-label="Zoomable image. Use arrow keys to browse, plus and minus to zoom, and zero to reset.">
        ${item.html ? `<div class="image-viewer-main-image image-viewer-graph">${item.html}</div>` : `<img class="image-viewer-main-image" src="${escapeHtml(item.src)}" alt="${escapeHtml(item.alt)}" draggable="false">`}
        ${count > 1 ? `<button class="image-viewer-nav image-viewer-previous" type="button" data-image-action="previous" aria-label="Previous image">←</button><button class="image-viewer-nav image-viewer-next" type="button" data-image-action="next" aria-label="Next image">→</button>` : ""}
      </div>
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
  mainImage.addEventListener("load", syncLoadedImage);
  if (mainImage.complete && mainImage.naturalWidth) syncLoadedImage();
  imageViewerResizeObserver?.disconnect();
  imageViewerResizeObserver = new ResizeObserver(() => {
    if (imageViewerState.isFitView) fitImageViewer();
  });
  imageViewerResizeObserver.observe(elements.imageViewer.querySelector(".image-viewer-stage"));
  const activeThumbnail = elements.imageViewer.querySelector('.image-viewer-thumbnail[aria-current="true"]');
  window.requestAnimationFrame(() => activeThumbnail?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  updateImageViewerTransform();
}

function showImageViewer(trigger) {
  const items = imageViewerItems(trigger);
  const index = items.findIndex((item) => item.trigger === trigger);
  if (index < 0) return;
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
  imageViewerState.pan = null;
  imageViewerResizeObserver?.disconnect();
  imageViewerResizeObserver = null;
  if (elements.imageViewer.open) elements.imageViewer.close();
  imageViewerState.items = [];
  imageViewerState.trigger = null;
  elements.imageViewer.replaceChildren();
  if (returnFocus) trigger?.focus();
}

function selectImageViewerItem(index) {
  const count = imageViewerState.items.length;
  if (!count) return;
  imageViewerState.index = ((index % count) + count) % count;
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

function chunkBody(doc, chunk) {
  return actionGroups.has(chunk.id)
    ? `${(doc.actionWarnings || []).map(w => `<p class="work-warning">${escapeHtml(w)}</p>`).join("")}${renderActions(actionGroups.get(chunk.id), chunk.id)}`
    : /^work breakdown$/i.test(chunk.title)
    ? renderWorkBreakdown(doc.work, doc.nextActions, doc.chunks.find(c => /^next actions$/i.test(c.title))?.id || "work", chunk.id)
    : doc.format === "text"
    ? `<pre class="plain-text">${escapeHtml(chunk.markdown)}</pre>`
    : (/^updates$/i.test(chunk.title) && renderUpdates(chunk.markdown, state.selectedPath))
      || `<div class="markdown">${renderMarkdownSource(chunk.markdown, state.selectedPath)}</div>`;
}

// Panels repeat chunk content, so their copies drop ids (SVG markers excepted) to keep anchors and jumps unique.
function renderDocumentDock(doc) {
  if (doc.format === "text") return;
  const links = collectLinks(elements.chunks, state.documents);
  elements.chunks.insertAdjacentHTML("afterbegin", renderDock({ doc, documents: state.documents, links, body: chunk => chunkBody(doc, chunk) }));
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
const viewCrumb = (view, label, params = {}) => `<a class="crumb" href="?${new URLSearchParams({ view, ...params })}" data-crumb-view="${view}"${params.date ? ` data-crumb-date="${params.date}"` : ""}>${escapeHtml(label)}</a>`;
const docCrumb = (path, label, current = false) => current
  ? `<a class="crumb is-current" href="${escapeHtml(documentHref(path, ""))}" aria-current="page">${escapeHtml(label)}</a>`
  : `<a class="crumb" href="${escapeHtml(documentHref(path, ""))}" data-crumb-path="${escapeHtml(path)}">${escapeHtml(label)}</a>`;
const copyCrumb = (value, label = value) => `<button class="crumb crumb-copy" type="button" data-copy-value="${escapeHtml(value)}" title="Copy ${escapeHtml(value)}">${escapeHtml(label)}</button>`;

const dailyRank = (path) => /^daily\/\d{4}\/\d{2}\/\d{2}\/plan\.md$/.test(path) ? 0 : /^daily\/\d{4}\/\d{2}\/\d{2}\/done\.md$/.test(path) ? 1 : 2;

function documentBreadcrumb(doc) {
  if (doc.task) return [viewCrumb("tasks", "Tasks"), copyCrumb(doc.task.id)].join(crumbSeparator) + statusPill(doc.task, doc.path);
  const daily = doc.path.match(/^daily\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (daily) {
    const key = `${daily[1]}-${daily[2]}-${daily[3]}`;
    const siblings = state.documents.filter((candidate) => candidate.path.startsWith(daily[0]))
      .sort((a, b) => dailyRank(a.path) - dailyRank(b.path) || a.path.localeCompare(b.path));
    const label = parseDateKey(key)?.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) || key;
    // Plan and done are tabs; the day's other files sit behind one "+N" menu so long days never crowd the crumb row.
    const pinned = siblings.filter((sibling) => dailyRank(sibling.path) < 2);
    const extra = siblings.filter((sibling) => dailyRank(sibling.path) === 2);
    const extraCurrent = extra.some((sibling) => sibling.path === doc.path);
    const menu = extra.length
      ? `<button class="crumb${extraCurrent ? " is-current" : ""}" type="button" popovertarget="day-files" style="anchor-name: --day-files">${extraCurrent ? escapeHtml(dailyDocumentLabel(doc)) : `+${extra.length} ${extra.length === 1 ? "file" : "files"}`} <span aria-hidden="true">⌄</span></button>
        <div id="day-files" class="day-files-menu" popover style="position-anchor: --day-files">${extra.map((sibling) => docCrumb(sibling.path, dailyDocumentLabel(sibling), sibling.path === doc.path)).join("")}</div>`
      : "";
    const tabs = siblings.length > 1 ? `<span class="crumb-siblings">${pinned.map((sibling) => docCrumb(sibling.path, sibling.kind.toLowerCase(), sibling.path === doc.path)).join("")}${menu}</span>` : "";
    const plan = siblings.find((sibling) => sibling.path.endsWith("/plan.md"));
    const day = plan ? docCrumb(plan.path, label, plan.path === doc.path) : viewCrumb("weeks", label, { date: key });
    return [viewCrumb("weeks", "Weeks", { date: key }), day].join(crumbSeparator) + tabs;
  }
  const parent = parentDocument(doc.path);
  if (parent) {
    const parentLabel = parent.task ? parent.task.id : parent.date ? `${parent.kind} · ${parent.date}` : parent.title;
    return [docCrumb(parent.path, parentLabel), copyCrumb(doc.path, doc.path.slice(dirname(parent.path).length + 1).replace(/^TASK-\d{4}-assets\//, ""))].join(crumbSeparator);
  }
  const root = doc.path.startsWith("plans/") ? viewCrumb("topics", "Topics") : doc.path.startsWith("reference/") ? viewCrumb("reference", "Reference") : "";
  return [root, copyCrumb(doc.path, doc.path.replace(/^(plans|reference)\//, ""))].filter(Boolean).join(crumbSeparator);
}

function renderDocument() {
  const doc = state.document;
  if (!doc) return;
  if (elements.imageViewer.open) closeImageViewer(false);
  state.view = "document";
  resetPageNavigation();
  elements.title.textContent = doc.title;
  elements.meta.innerHTML = documentBreadcrumb(doc);
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
      <span class="chunk-actions"><button class="handoff-button" type="button" data-chunk-copy="${chunk.id}" aria-label="Copy section as Markdown">Copy</button><button class="handoff-button" type="button" data-chunk-id="${chunk.id}" aria-haspopup="dialog" aria-controls="handoff-popover" aria-expanded="${state.openComposer === `chunk:${chunk.id}`}">Open in ${agentName()}</button></span>
    </div>
    ${chunkBody(doc, chunk)}
  </article>`).join("");
  enhanceTaskReferences();
  renderDocumentDock(doc);
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
  for (const link of elements.chunks.querySelectorAll('.markdown-document-link[data-document-path^="tasks/"]:not(.daily-action-more)')) {
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
  elements.globalHandoff.title = `Open a new ${agentName()} draft without context (C)`;
  elements.globalHandoff.setAttribute("aria-label", `Open a new ${agentName()} draft without context, C`);
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
  url.search = new URLSearchParams({ path });
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
    state.selectedPath = path;
    state.document = body;
    closeComposer();
    renderLibrary();
    elements.chunks.classList.remove("is-live-refresh");
    renderDocument();
    updateViewerUrl(path, anchor, historyMode);
    window.requestAnimationFrame(() => scrollToDocumentAnchor(anchor));
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

    if (state.view === "weeks") {
      renderLibrary();
      keepScroll(renderWeeksPage);
      return;
    }

    if (state.view === "code" || state.view === "issues") {
      renderLibrary();
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

function connectLiveUpdates() {
  const events = new EventSource("/api/events");
  events.addEventListener("markdown", (event) => {
    try {
      const update = JSON.parse(event.data);
      if (update.path) scheduleMarkdownRefresh(update.path);
    } catch {
      // Ignore malformed live events; EventSource will keep the connection alive.
    }
  });
}

async function dispatch(form) {
  const button = form.querySelector(".send-button");
  const commentary = new FormData(form).get("commentary");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Opening draft…";
  try {
    const response = await fetch("/api/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: agentApp(), path: form.dataset.sourcePath || state.selectedPath, scope: form.dataset.scope, chunkId: form.dataset.chunkId, actionId: form.dataset.actionId, expectedPrompt: form.dataset.expectedPrompt, commentary, images: [...form.querySelectorAll(".composer-images img")].map((img) => img.src) }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `${agentName()} could not open the draft.`);
    const chunkId = form.dataset.chunkId;
    const scope = form.dataset.scope;
    closeComposer();
    if (state.view === "document") renderDocument();
    if (scope === "chunk") document.querySelector(`#${chunkId}`)?.classList.add("card-drafted");
    showNotice(`Draft loaded in ${agentName()}. Review or edit it there, then send it.`);
  } catch (error) {
    button.disabled = false;
    button.textContent = form.dataset.scope === "action" ? `Open in ${agentName()}` : `Open draft in ${agentName()}`;
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
elements.weeksButton.addEventListener("click", () => showWeeks());
elements.codeButton.addEventListener("click", () => showCode());
elements.issuesButton.addEventListener("click", () => showIssues());
connectPlanning({ documents: () => state.documents, open: (path) => selectDocument(path, { historyMode: "push" }) });
elements.meta.addEventListener("click", async (event) => {
  const plainClick = !(event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  const view = event.target.closest("[data-crumb-view]");
  if (view && plainClick) {
    event.preventDefault();
    if (view.dataset.crumbView === "tasks") showTasks();
    else if (view.dataset.crumbView in LIBRARY_VIEWS) showLibrary(view.dataset.crumbView);
    else showWeeks({ anchor: parseDateKey(view.dataset.crumbDate) });
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
  const state = meta.state && source !== "slack" ? `<span class="hover-card-state" data-tone="${escapeHtml(meta.tone || "")}">${escapeHtml(meta.state)}${meta.when ? ` <span>${ago(meta.when)} ago</span>` : ""}</span>` : "";
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
    if (!link) return;
    clearTimeout(linkTipTimer);
    linkTipTimer = setTimeout(() => showLinkTip(link), 200);
  });
  elements.chunks.addEventListener(off, (event) => {
    const link = event.target.closest?.("a[data-tip]");
    if (link && !link.contains(event.relatedTarget)) hideLinkTip();
  });
}
addEventListener("scroll", hideLinkTip, { capture: true, passive: true });
addEventListener("keydown", (event) => { if (event.key === "Escape") hideLinkTip(); });
// Hovering a task in the Weeks calendar lights up the same task on every other day.
elements.chunks.addEventListener("pointerover", (event) => {
  const row = event.target.closest?.(".calendar-task[data-task-id]");
  const id = row?.dataset.taskId || "";
  const surface = elements.chunks.querySelector(".weeks-surface");
  if (!surface || surface.dataset.linkedTask === id) return;
  surface.dataset.linkedTask = id;
  for (const linked of surface.querySelectorAll(".calendar-task.is-linked")) linked.classList.remove("is-linked");
  if (id) for (const linked of surface.querySelectorAll(`.calendar-task[data-task-id="${id}"]`)) linked.classList.add("is-linked");
});
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
// Plain clicks on Slack permalinks hand off to the desktop app; modified clicks keep normal browser behaviour.
document.addEventListener("click", (event) => {
  const link = event.target.closest("a.slack-link");
  if (!link || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
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
  if (kind !== "linear" && kind !== "jira") return null;
  const key = kind === "linear" ? `linear:${ref}` : ref;
  return cachedIssues()?.issues?.some(issue => issue.key === key) ? { open: () => openIssue(key), site: kind === "linear" ? "Linear" : "Jira" } : null;
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
  if (source) {
    const browser = source.closest(".dock-link-browser");
    for (const tab of browser.querySelectorAll("[data-dock-source]")) tab.setAttribute("aria-selected", String(tab === source));
    for (const list of browser.querySelectorAll("[data-dock-source-list]")) list.hidden = list.dataset.dockSourceList !== source.dataset.dockSource;
    return;
  }
  const dockPanel = event.target.closest(".doc-dock-panel");
  if (dockPanel && event.target.closest("a[href], [data-action-key], .handoff-button")) queueMicrotask(() => dockPanel.matches(":popover-open") && dockPanel.hidePopover());
  const imageTrigger = event.target.closest(".markdown-image-trigger");
  if (imageTrigger) {
    showImageViewer(imageTrigger);
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
  const calendarFile = event.target.closest("[data-calendar-path]");
  if (calendarFile) {
    selectDocument(calendarFile.dataset.calendarPath);
    return;
  }
  const weekShift = event.target.closest("[data-week-shift]");
  if (weekShift) {
    state.weekAnchor = addDays(state.weekAnchor, Number(weekShift.dataset.weekShift));
    updateWeeksUrl("replace");
    renderWeeksPage();
    return;
  }
  if (event.target.closest("[data-week-today]")) {
    state.weekAnchor = parseDateKey(localTodayKey());
    updateWeeksUrl("replace");
    renderWeeksPage();
    return;
  }
  const documentLink = event.target.closest(".markdown-document-link");
  if (documentLink) {
    event.preventDefault();
    selectDocument(documentLink.dataset.documentPath, { historyMode: "push", anchor: documentLink.dataset.documentAnchor });
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
  else if (event.target.closest(".popover-close")) requestComposerClose(true);
});
elements.imageViewer.addEventListener("click", (event) => {
  if (event.target === elements.imageViewer) {
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
});
elements.imageViewer.addEventListener("wheel", (event) => {
  const stage = event.target.closest(".image-viewer-stage");
  if (!stage) return;
  event.preventDefault();
  const rect = stage.getBoundingClientRect();
  zoomImageViewer(Math.exp(-event.deltaY * .0015), { x: event.clientX - rect.left, y: event.clientY - rect.top });
}, { passive: false });
elements.imageViewer.addEventListener("dblclick", (event) => {
  if (event.target.closest(".image-viewer-stage") && !event.target.closest("button")) resetImageViewerTransform();
});
elements.imageViewer.addEventListener("pointerdown", (event) => {
  const stage = event.target.closest(".image-viewer-stage");
  if (!stage || event.button !== 0 || event.target.closest("button:not(.work-node)")) return;
  stage.setPointerCapture(event.pointerId);
  stage.classList.add("is-panning");
  imageViewerState.isFitView = false;
  imageViewerState.pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
});
elements.imageViewer.addEventListener("pointermove", (event) => {
  const pan = imageViewerState.pan;
  if (!pan || pan.pointerId !== event.pointerId) return;
  imageViewerState.offset.x += event.clientX - pan.x;
  imageViewerState.offset.y += event.clientY - pan.y;
  pan.x = event.clientX;
  pan.y = event.clientY;
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
  closeImageViewer();
});
elements.imageViewer.addEventListener("keydown", (event) => {
  if (!elements.imageViewer.open) return;
  const key = event.key.toLowerCase();
  if (event.key === "ArrowLeft" && imageViewerState.items.length > 1) selectImageViewerItem(imageViewerState.index - 1);
  else if (event.key === "ArrowRight" && imageViewerState.items.length > 1) selectImageViewerItem(imageViewerState.index + 1);
  else if (event.key === "+" || event.key === "=") zoomImageViewer(1.25);
  else if (event.key === "-") zoomImageViewer(.8);
  else if (key === "0") resetImageViewerTransform();
  else return;
  event.preventDefault();
  event.stopPropagation();
});
document.addEventListener("click", (event) => {
  if (!state.openComposer || elements.handoffPopover.contains(event.target) || event.target.closest(".handoff-button, [data-action-key], .global-handoff, [data-dock-draft]")) return;
  requestComposerClose();
});
// Keep the shortcut guide and bindings together so the documentation stays current.
const shortcuts = [
  { keys: ["T"], description: "Go to today’s plan", run: goToToday },
  { keys: ["C"], description: "Open hovered action or section in the agent draft; otherwise a global draft", run: openCursorComposer },
  { keys: ["D"], description: "Open an agent draft for the current file", run: openDocumentComposer },
  { keys: ["⌘K", "Ctrl+K", "/"], description: "Search pages, plans, tasks, topics, reference files, and PRs", run: openSearch },
  { keys: ["A"], description: "Open Tasks", run: () => showTasks() },
  { keys: ["W"], description: "Open Weeks", run: () => showWeeks() },
  { keys: ["G"], description: "Open Code: worktrees, pull requests, cleanup", run: () => showCode() },
  { keys: ["I"], description: "Open Issues: Jira triage, epics, activity", run: () => config().issues.jql && showIssues() },
  { keys: ["H"], description: "Recently viewed, from anywhere (even the PR overview): type to filter, ↑↓ to move, Enter to go back, 1–9 to jump, Esc clears the filter" },
  { keys: ["J"], description: "Jump to the next document section", run: () => jumpSection(1) },
  { keys: ["K"], description: "Jump to the previous document section", run: () => jumpSection(-1) },
  { keys: ["?"], description: "Show keyboard shortcuts (Shift + /)", run: openShortcutGuide },
  { keys: ["Esc"], description: "Close the current dialog or popover" },
];

let cursorPosition = null;
document.addEventListener("pointermove", (event) => { cursorPosition = { x: event.clientX, y: event.clientY }; }, { passive: true });
document.documentElement.addEventListener("pointerleave", () => { cursorPosition = null; });
window.addEventListener("blur", () => { cursorPosition = null; });

function openCursorComposer() {
  const hovered = cursorPosition && document.elementFromPoint(cursorPosition.x, cursorPosition.y);
  const action = hovered?.closest("[data-action-key]")
    || hovered?.closest(".action-row")?.querySelector("[data-action-key]");
  if (action) {
    if (action.disabled) { showNotice("This action is blocked. Resolve its prerequisites first."); return; }
    action.click();
    return;
  }
  const trigger = hovered?.closest(".handoff-button, [data-dock-draft], .global-handoff")
    || hovered?.closest(".chunk-card")?.querySelector(".handoff-button");
  if (trigger && !trigger.disabled) trigger.click();
  else openGlobalComposer();
}

function goToToday() {
  const todayPath = `daily/${localTodayKey().replaceAll("-", "/")}/plan.md`;
  if (state.documents.some(doc => doc.path === todayPath)) selectDocument(todayPath);
  else showNotice("There is no plan for today yet.");
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
  document.querySelector("#shortcut-list").innerHTML = shortcuts.map(shortcut => `<div class="shortcut-row"><span>${escapeHtml(shortcut.description)}</span><span>${shortcut.keys.map(key => `<kbd>${escapeHtml(key)}</kbd>`).join(" ")}</span></div>`).join("");
  openViewerDialog(elements.shortcutsDialog);
}

let searchMatches = [];
let searchIndex = 0;
const SEARCH_ICONS = {
  pr: GLYPHS["git-pull-request"],
  task: GLYPHS["square-check"],
  plan: GLYPHS["calendar"],
  done: GLYPHS["circle-check"],
  topic: GLYPHS["folder"],
  reference: GLYPHS["book"],
  file: GLYPHS["file-text"],
  branch: GLYPHS["git-branch"],
  code: GLYPHS["code"],
  list: GLYPHS["list"],
  issue: GLYPHS["circle-dot"],
  initiative: GLYPHS["flag"],
  server: GLYPHS["server"],
};

function searchIconKey(doc) {
  if (doc.kind === "Task") return "task";
  if (doc.kind === "Plan" || doc.kind === "Daily note") return "plan";
  if (doc.kind === "Done") return "done";
  if (doc.kind === "Topic") return "topic";
  if (doc.kind === "Reference") return "reference";
  return "file";
}

function highlightTerms(text, terms) {
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
  return { icon: "issue", tone: `issue is-${escapeHtml(issue.category)}`, title: `<span class="search-pr-number">${highlightTerms(label, terms)}</span> ${highlightTerms(issue.summary, terms)}`, detail: `${issue.source === "linear" ? "Linear · " : ""}${detail}`, side: escapeHtml(issue.status) };
}
const renderIssueResult = ({ issue }, index, terms) => resultRow({ ...issueResult(issue, terms), attrs: searchAttrs(index) });

const planResult = (item, terms) => ({
  icon: "initiative", tone: `initiative is-${escapeHtml(item.status)}`, title: highlightTerms(item.title, terms),
  detail: [item.repo.split("/").pop(), item.phase, item.edited && `${ago(item.edited)} ago`, item.summary].filter(Boolean).map((part) => highlightTerms(String(part), terms)).join(" · "),
  side: item.source === "pr" ? "Proposed" : escapeHtml(item.status[0].toUpperCase() + item.status.slice(1)),
});
const renderPlanResult = ({ plan }, index, terms) => resultRow({ ...planResult(plan, terms), attrs: searchAttrs(index) });
// A key (`OPS-12`, or a bare number matching the end of one), an old key it was imported from, or words from the title.
function searchIssues(query) {
  const data = cachedIssues();
  if (!data?.enabled || !query) return [];
  const upper = query.trim().toUpperCase().replace(/^#/, "");
  const alias = data.aliases[upper];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = data.issues.filter((issue) => !issue.bot && !issue.mirrorOf).map((issue) => {
    const shown = issue.label || issue.key;
    const key = shown === upper || issue.key === alias ? 3 : /^\d+$/.test(upper) && shown.endsWith(`-${upper}`) ? 2 : 0;
    const words = terms.every((term) => `${shown} ${issue.summary}`.toLowerCase().includes(term)) ? 1 : 0;
    return [issue, key || words];
  }).filter(([, score]) => score);
  return scored.sort((a, b) => b[1] - a[1] || b[0].updated.localeCompare(a[0].updated)).slice(0, 8).map(([issue]) => issue);
}

// Every top-level page and Code tab, so ⌘K jumps straight to e.g. Pull requests.
const PAGES = [
  { title: "Today", detail: "Today’s plan", icon: "plan", run: goToToday },
  { title: "Tasks", detail: "All tasks", icon: "task", run: () => showTasks() },
  { title: "Weeks", detail: "Calendar of daily plans", icon: "plan", run: () => showWeeks() },
  ...Object.entries(LIBRARY_VIEWS).map(([view, { title, intro }]) => ({ title, detail: intro, icon: title === "Topics" ? "topic" : "reference", run: () => showLibrary(view) })),
  { title: "Local servers", detail: "Dev servers the viewer started: URLs, output, restart, stop", icon: "server", run: () => openServers(showNotice) },
  ...Object.entries(CODE_TABS).map(([tab, title]) => ({ title, detail: `Code · ${title}`, icon: tab === "prs" ? "pr" : tab === "commits" ? "branch" : "code", run: () => showCode({ tab: tab === "prs" ? "" : tab }) })),
  ...Object.entries(ISSUE_TABS).map(([tab, title]) => ({ title: tab === "all" ? "Issues" : `${title} issues`, detail: `Issues · ${title}`, icon: "issue", issues: true, run: () => showIssues({ tab: tab === "all" ? "" : tab }) })),
];
const searchPages = (query) => { const terms = query.toLowerCase().split(/\s+/).filter(Boolean); return PAGES.filter((page) => (!page.issues || config().issues.jql) && terms.every((term) => `${page.title} ${page.detail}`.toLowerCase().includes(term))).map((page) => ({ page })); };
const renderPageResult = ({ page }, index) => resultRow({ icon: page.icon, title: escapeHtml(page.title), detail: escapeHtml(page.detail), side: "Page", attrs: searchAttrs(index) });

// With no query, PRs waiting on you lead; a query lists matching PRs (number, title, branch, author) above documents.
function searchGroups(query) {
  const index = cachedPrIndex();
  const prs = index?.prs || [];
  const docs = searchDocuments(state.documents, query);
  if (query) return [["Pages", searchPages(query)], ["Issues", searchIssues(query)], ["Pull requests", searchPrs(prs, query)], ["Initiatives", searchPlans(query)], ["Documents", docs]];
  const open = prs.filter((pr) => pr.state === "OPEN").sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return [["Needs your review", open.filter((pr) => pr.requestedOfMe).slice(0, 5)], ["Your open PRs", open.filter((pr) => pr.author === index?.me && !pr.requestedOfMe).slice(0, 5)], ["Pages", searchPages("")], ["Documents", docs]];
}

function renderSearchResults() {
  const query = elements.searchInput.value.trim();
  const terms = query.toLowerCase().replace(/^#/, "").split(/\s+/).filter(Boolean);
  const groups = searchGroups(query).map(([label, items]) => [label, items.map((item) => (label === "Documents" || item.page ? item : label === "Issues" ? { issue: item } : label === "Initiatives" ? { plan: item } : { pr: item }))]).filter(([, items]) => items.length);
  searchMatches = groups.flatMap(([, items]) => items);
  searchIndex = 0;
  const prCount = searchMatches.filter((item) => item.pr).length;
  const docCount = searchMatches.filter((item) => !item.pr && !item.page && !item.issue && !item.plan).length;
  const planCount = searchMatches.filter((item) => item.plan).length;
  elements.searchStatus.textContent = `${prCount ? `${prCount} ${prCount === 1 ? "PR" : "PRs"} · ` : ""}${planCount ? `${planCount} ${planCount === 1 ? "initiative" : "initiatives"} · ` : ""}${docCount} ${docCount === 1 ? "document" : "documents"}`;
  let position = 0;
  elements.searchResults.innerHTML = searchMatches.length
    ? groups.map(([label, items]) => `<div class="search-section" role="presentation">${label}</div>${items.map((item) => { const index = position++; return item.pr ? renderPrResult(item, index, terms) : item.issue ? renderIssueResult(item, index, terms) : item.plan ? renderPlanResult(item, index, terms) : item.page ? renderPageResult(item, index) : renderSearchResult(item, index, terms); }).join("")}`).join("")
    : '<div class="search-empty"><strong>No matches</strong><span>Try a title, path, task ID, PR number or title, project, or tag.</span></div>';
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
  else { closeOverview(); selectDocument(doc.path); }
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
const tableRows = (table) => [...table.rows].map((row) => [...row.cells].map(tableCellText));
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
      for (const hidden of clone.querySelectorAll(".sr-only, [aria-hidden='true']")) hidden.remove();
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
  if (openViewerDialog(dialog, { stack: true })) dialog.querySelector(".table-viewer-body").focus();
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
// A section copies as its own Markdown, under its heading unless it is the untitled overview.
async function copyChunk(button) {
  const chunk = state.document?.chunks.find((item) => item.id === button.dataset.chunkCopy);
  if (!chunk) return;
  try {
    await navigator.clipboard.writeText(chunk.kind === "overview" ? chunk.markdown : `${"#".repeat(chunk.level)} ${chunk.title}\n\n${chunk.markdown}`);
    button.classList.remove("is-copied");
    void button.offsetWidth;
    button.classList.add("is-copied");
  } catch {
    showNotice("Could not copy the section.", true);
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
    showTasks({ historyMode: "none" });
    return;
  }
  if (params.get("view") in LIBRARY_VIEWS) {
    showLibrary(params.get("view"), { historyMode: "none" });
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
  if (params.get("view") === "weeks") {
    showWeeks({ historyMode: "none", anchor: parseDateKey(params.get("date")) || parseDateKey(localTodayKey()) });
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
  statusMenu.innerHTML = Object.entries(TASK_STATUS_LABELS).map(([value, label]) => `<button type="button" role="menuitemradio" aria-checked="${value === status}" data-set-status="${value}" data-path="${escapeHtml(path)}"><span class="task-status task-status-${value}">${label}</span></button>`).join("");
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
    const response = await fetch("/api/task-status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: choice.dataset.path, status: choice.dataset.setStatus }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not change the task status.");
    showNotice(`${body.task.id} is now ${TASK_STATUS_LABELS[body.task.status].toLowerCase()}.`);
    await refreshFromMarkdown(new Set([choice.dataset.path]));
  } catch (error) {
    showNotice(error.message, true);
  }
});

// ---------- recently viewed ----------

// Every page and PR/worktree overview this browser has shown, newest first, so a stray Escape is one click from undone.
// Recorded from the URL, which every view and overview already keeps current.
const VISITS_KEY = "viewer-visits";
let visits = [];
try { visits = JSON.parse(localStorage.getItem(VISITS_KEY) || "[]"); } catch {}
const pageKey = (url) => {
  const params = new URLSearchParams(url.search);
  for (const name of ["pr", "wt", "issue", "file", "scope"]) params.delete(name);
  return params.toString();
};
const visitKey = (url) => (url.searchParams.get("pr") ? `pr:${url.searchParams.get("pr")}` : url.searchParams.get("wt") ? `wt:${url.searchParams.get("wt")}` : url.searchParams.get("issue") ? `issue:${url.searchParams.get("issue")}` : pageKey(url));
function recordVisit() {
  const url = new URL(location.href);
  const key = visitKey(url);
  visits = [{ key, href: url.pathname + url.search + url.hash, at: Date.now() }, ...visits.filter((visit) => visit.key !== key)].slice(0, 30);
  try { localStorage.setItem(VISITS_KEY, JSON.stringify(visits)); } catch {}
}
for (const method of ["pushState", "replaceState"]) {
  const original = history[method].bind(history);
  history[method] = (...args) => { original(...args); recordVisit(); };
}
window.addEventListener("popstate", recordVisit);

const prNumberLabel = (slug, number) => `${slug === referenceConfig().defaultSlug ? "" : slug.split("/")[1]}#${number}`;
const findPr = (slug, number) => cachedPrIndex()?.prs.find((pr) => pr.slug === slug && pr.number === number);

// A recorded URL as ⌘K would show it: the PR or worktree overview it had open, else the page or document.
function visitResult(href) {
  const params = new URL(href, location.href).searchParams;
  const pr = params.get("pr")?.split("#");
  if (pr?.length === 2) return prResult(findPr(pr[0], Number(pr[1])) || { slug: pr[0], number: Number(pr[1]) }, []);
  const plan = params.get("plan");
  if (plan) return { icon: "initiative", title: escapeHtml(planTitle(plan) || plan.split("/").pop()), detail: escapeHtml(`${plan.split(":")[0].split("/").pop()} · ${params.get("doc")?.split("/").pop() || "initiative"}`), side: "Initiative" };
  const issueKey = params.get("issue");
  if (issueKey) { const issue = cachedIssues()?.issues?.find((candidate) => candidate.key === issueKey); return issue ? issueResult(issue, []) : { icon: "issue", title: escapeHtml(issueKey), detail: "Jira issue", side: "Issue" }; }
  const tree = params.get("wt");
  if (tree) return { icon: "branch", title: escapeHtml(tree.split("/").pop()), detail: escapeHtml(tree.replace(/^\/Users\/[^/]+/, "~")), side: "Worktree" };
  const view = params.get("view");
  const doc = (path) => state.documents.find((candidate) => candidate.path === path);
  const page = (icon, title, detail) => ({ icon, title: escapeHtml(title), detail: escapeHtml(detail), side: "Page" });
  if (view === "tasks") return doc(`tasks/${params.get("task")}.md`) ? docResult(doc(`tasks/${params.get("task")}.md`), []) : page("list", "Tasks", "Every task by status");
  if (view === "code") return page("code", "Code", CODE_TABS[params.get("tab") || "prs"] || "Pull requests");
  if (view === "issues") return page("issue", "Issues", ISSUE_TABS[params.get("tab") || "all"] || "All");
  if (view === "weeks") return page("plan", "Weeks", params.get("date") ? `Week of ${formatDate(params.get("date"))}` : "This week");
  if (view in LIBRARY_VIEWS) return page(view === "topics" ? "topic" : "reference", LIBRARY_VIEWS[view].title, LIBRARY_VIEWS[view].intro);
  const path = params.get("path") || state.defaultPath;
  return doc(path) ? docResult(doc(path), []) : { icon: "file", title: escapeHtml(path), detail: "No longer in the planning folders", side: "Document" };
}

// Goes back to a recorded URL through the same routes as Back/Forward, then reopens its overview if it had one.
function resumeVisit(href) {
  const url = new URL(href, location.href);
  if (pageKey(url) === pageKey(location)) history.replaceState(null, "", url);
  else { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); }
  const params = url.searchParams;
  const pr = params.get("pr")?.split("#");
  const [file, scope] = [params.get("file") || "", params.get("scope") || "all"];
  if (pr?.length === 2) openPrOverlay(pr[0], Number(pr[1]), file, scope);
  else if (params.get("wt")) openWorktreeOverlay(params.get("wt"), file, scope);
  else if (params.get("issue")) openIssue(params.get("issue"));
  else if (params.get("plan")) openPlan(params.get("plan"), params.get("doc") || "");
  else closeOverview();
}
// Going to a plain page from over the PR/worktree overview closes it (its toast offers Reopen).
const closeOverview = () => { for (const overlay of document.querySelectorAll("dialog.code-diff[open]")) overlay.close(); };

document.addEventListener("overview-closed", (event) => {
  const params = new URL(event.detail).searchParams;
  const pr = params.get("pr")?.split("#");
  const issueKey = params.get("issue");
  const issue = issueKey && cachedIssues()?.issues?.find((candidate) => candidate.key === issueKey);
  const description = pr?.length === 2
    ? `${prNumberLabel(pr[0], pr[1])} ${findPr(pr[0], Number(pr[1]))?.title || ""}`.trim()
    : issueKey ? (issue ? `${issue.type === "Project" ? "" : issue.label || issue.key} ${issue.summary}`.trim() : issueKey.replace(/^linear:/, ""))
    : params.get("plan") ? planTitle(params.get("plan")) || params.get("plan").split("/").pop()
    : params.get("wt")?.split("/").pop() || "";
  showNotice(`Closed the ${pr ? "PR" : issue?.type === "Project" ? "project" : issueKey ? "issue" : params.get("plan") ? "initiative" : "worktree"} ${params.get("plan") ? "reader" : "overview"}`, false, { kind: "info", description, action: { label: "Reopen", run: () => resumeVisit(event.detail) } });
});

const historyMenu = document.querySelector("#history-menu");
const historyRows = () => [...historyMenu.querySelectorAll("[data-visit-href]:not([hidden])")];
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
  historyMenu.innerHTML = `<label class="search-field history-filter"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.search}</svg><span class="sr-only">Filter recently viewed</span><input type="search" placeholder="Type to filter…" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">Esc</kbd></label><section class="history-here-wrap" aria-label="You are here"><div class="search-section">You are here</div>${here}</section><div class="search-results" role="listbox" aria-label="Recently viewed"><div class="search-section" role="presentation">Recently viewed</div>${rows.join("") || '<div class="search-empty"><strong>Nothing yet</strong><span>Pages, PRs and worktrees you open will appear here.</span></div>'}</div><footer class="viewer-dialog-footer search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> select <kbd>↵</kbd> open <kbd>1</kbd>–<kbd>9</kbd> jump <kbd>H</kbd> close</span><span class="history-count">${shown.length} ${shown.length === 1 ? "place" : "places"}</span></footer>`;
});
// Every word must appear in the row's title or detail; the 1–9 markers renumber over what's left.
function filterHistory() {
  const words = historyFilter().value.toLowerCase().split(/\s+/).filter(Boolean);
  const all = [...historyMenu.querySelectorAll("[data-visit-href]")];
  if (words.length && !historyMenu.style.height) historyMenu.style.height = `${historyMenu.offsetHeight}px`; // hold the size so the field doesn't jump
  for (const row of all) row.hidden = !words.every((word) => row.textContent.toLowerCase().includes(word));
  const rows = historyRows();
  rows.forEach((row, index) => { row.querySelector(".result-marker").textContent = index < 9 ? index + 1 : ""; });
  historyMenu.querySelector(".history-none")?.remove();
  if (all.length && !rows.length) historyMenu.querySelector(".search-results").insertAdjacentHTML("beforeend", '<div class="search-empty history-none"><strong>No matches</strong><span>Esc clears the filter.</span></div>');
  historyMenu.querySelector(".history-count").textContent = words.length ? `${rows.length} of ${all.length}` : `${all.length} ${all.length === 1 ? "place" : "places"}`;
  selectHistoryRow(rows[0]);
}
historyMenu.addEventListener("input", filterHistory);
historyMenu.addEventListener("click", (event) => {
  const row = event.target.closest("[data-visit-href]");
  if (!row) return;
  historyMenu.hidePopover();
  resumeVisit(row.dataset.visitHref);
});
historyMenu.addEventListener("mousemove", (event) => {
  const row = event.target.closest("[data-visit-href]");
  if (row && row.getAttribute("aria-selected") !== "true") selectHistoryRow(row);
});
// However it opens (H or the button), the newest row is selected and focused so arrows and Enter work at once.
const historyButton = document.querySelector("#open-history");
historyButton.addEventListener("click", () => (historyMenu.matches(":popover-open") ? historyMenu.hidePopover() : openHistoryMenu()));
historyMenu.addEventListener("toggle", (event) => historyButton.setAttribute("aria-expanded", String(event.newState === "open")));
historyMenu.addEventListener("toggle", (event) => { if (event.newState === "open" && !historyMenu.contains(document.activeElement)) selectHistoryRow(historyRows()[0]); });
// A modal dialog makes everything outside it inert, so the menu moves into the top open dialog to stay usable above it.
function openHistoryMenu() {
  const host = [...document.querySelectorAll("dialog[open]")].at(-1) || document.body;
  if (historyMenu.parentElement !== host) host.append(historyMenu);
  historyMenu.showPopover();
  selectHistoryRow(historyRows()[0]); // now, not on the async toggle event, so an arrow pressed right after H lands in the list
}
historyMenu.addEventListener("keydown", (event) => {
  event.stopPropagation(); // inside the PR overview, its J/K/arrow keys must not also fire
  const rows = historyRows();
  const filter = historyFilter();
  const typing = !event.metaKey && !event.ctrlKey && !event.altKey;
  if (/^[1-9]$/.test(event.key) && typing && rows[event.key - 1]) { event.preventDefault(); rows[event.key - 1].click(); return; }
  if (event.key === "Escape" && filter.value) { event.preventDefault(); filter.value = ""; filterHistory(); return; } // a second Esc closes
  if (event.key.toLowerCase() === "h" && typing && !filter.value) { event.preventDefault(); historyMenu.hidePopover(); return; }
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
  selectHistoryRow(rows[(rows.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]);
});

async function boot() {
  try {
    const response = await fetch("/api/documents");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load the document list.");
    state.documents = body.documents;
    state.defaultPath = body.defaultPath;
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
    else if (requestedView === "code") renderCode();
    else if (requestedView === "issues") renderIssues();
    else if (requestedView === "weeks") {
      state.weekAnchor = parseDateKey(new URLSearchParams(location.search).get("date")) || parseDateKey(localTodayKey());
      renderWeeksPage();
    }
    else if (initial) await selectDocument(initial, { historyMode: "none", anchor: locationAnchor() });
    else showNotice("No supported files were found under daily, tasks, plans, or reference.", true);
    connectLiveUpdates();
    loadPrIndex().catch(() => {}); // so ⌘K lists PRs on its first paint instead of inserting them a moment later
    const search = new URLSearchParams(location.search);
    const pr = search.get("pr")?.split("#");
    const [file, scope] = [search.get("file") || "", search.get("scope") || "all"];
    if (pr?.length === 2) openPrOverlay(pr[0], Number(pr[1]), file, scope);
    const worktree = search.get("wt");
    if (worktree) openWorktreeOverlay(worktree, file, scope);
    if (search.get("issue")) openIssue(search.get("issue"));
    if (search.get("plan")) openPlan(search.get("plan"), search.get("doc") || "");
    if (config().issues.jql) loadIssues().catch(() => {}); // ⌘K finds issues by key and title
    recordVisit();
  } catch (error) {
    showNotice(error.message, true);
  }
}

// viewer.config.json drives reference links and labels, so it loads before anything renders.
try {
  setConfig(await fetch("/api/config").then((response) => response.json()));
  document.title = config().title;
  elements.issuesButton.hidden = !config().issues.jql;
} catch {}
installCommitCards({ showNotice });
boot();
