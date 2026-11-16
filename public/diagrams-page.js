// The Diagrams page (`?view=diagrams`): every `.draft` in the workspace as cards big enough to read, a Large card, or
// a table. Diagrams group by the day they were last saved (the default), by task, or by project; the groups, like the
// diagrams in them, run newest first. A card opens the image viewer's diagram mode, with every diagram in its rail.
import { diagramHref, documentHref, escapeHtml } from "./markdown.js";

const STATUS = { open: "Open", active: "Active", waiting: "Waiting", deferred: "Deferred", completed: "Completed" };
export const DIAGRAM_GROUPS = [["", "Day"], ["task", "Task"], ["project", "Project"]];
export const DIAGRAM_LAYOUTS = [["", "Cards"], ["large", "Large"], ["list", "List"]];

// The task whose assets hold a diagram, else its folder (a plan topic, a day, reference).
const placeOf = (diagram) => diagram.task || diagram.path.split("/").slice(0, diagram.path.startsWith("plans/") ? 2 : -1).join("/");

function docOf(key, documents) {
  return key.startsWith("TASK-") ? documents.find((doc) => doc.path === `tasks/${key}.md`)
    : documents.find((doc) => doc.path === `${key}/README.md` || doc.path === `${key}/plan.md`);
}

const dayKey = (time) => { const date = new Date(time); return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; };

function dayLabel(time, now) {
  const date = new Date(time);
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 864e5);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const long = { weekday: "long", month: "short", day: "numeric", ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) };
  return date.toLocaleDateString(undefined, days < 7 ? { weekday: "long" } : long);
}

// Groups diagrams by day, task (or folder) or project. Groups are ordered by their newest diagram, and so are the
// diagrams inside them.
export function diagramGroups(diagrams, documents, by = "", now = Date.now()) {
  const groups = new Map();
  for (const diagram of [...diagrams].sort((a, b) => b.modified - a.modified)) {
    const place = placeOf(diagram);
    const doc = docOf(place, documents);
    const key = by === "task" ? place : by === "project" ? doc?.task?.project || "No project" : dayKey(diagram.modified);
    if (!groups.has(key)) groups.set(key, { key, by: by || "day", items: [], doc: by === "task" ? doc : undefined, label: by ? key : dayLabel(diagram.modified, now) });
    groups.get(key).items.push(diagram);
  }
  for (const group of groups.values()) group.newest = Math.max(...group.items.map((item) => item.modified));
  return [...groups.values()].sort((a, b) => b.newest - a.newest);
}

const searchText = (diagram, doc) => [diagram.title, diagram.subtitle, diagram.path, doc?.task?.id || "", doc?.task?.title || doc?.title || "", doc?.task?.project || ""].join(" ").toLowerCase();

function mark(text, query) {
  if (!query) return escapeHtml(text);
  const at = text.toLowerCase().indexOf(query);
  return at < 0 ? escapeHtml(text) : `${escapeHtml(text.slice(0, at))}<mark>${escapeHtml(text.slice(at, at + query.length))}</mark>${escapeHtml(text.slice(at + query.length))}`;
}

const taskLink = (doc, inner) => `<a class="diagram-row-link markdown-document-link" href="${escapeHtml(documentHref(doc.path, ""))}" data-document-path="${escapeHtml(doc.path)}" data-document-anchor="">${inner}</a>`;
const taskName = (task) => `<code>${escapeHtml(task.id)}</code><span>${escapeHtml(task.title)}</span>`;
const statusText = (task) => `<span class="diagram-group-status" data-status="${escapeHtml(task.status)}">${STATUS[task.status] || escapeHtml(task.status)}</span>`;
const frame = (diagram) => `<span class="diagram-thumb-frame"><img class="markdown-image" src="${escapeHtml(diagramHref(diagram.path))}" alt="${escapeHtml(diagram.title)}" loading="lazy" decoding="async"></span>`;
const titleHtml = (diagram, query) => `<strong data-title="${escapeHtml(diagram.title)}">${mark(diagram.title, query)}</strong>`;

// Where a diagram came from, one quiet line: the task (unless the group already names it), and when it was saved.
function metaLine(diagram, doc, group, ago) {
  const where = group.by === "task" ? "" : doc?.task ? doc.task.id : `${placeOf(diagram)}/`;
  const project = group.by === "project" || group.by === "task" ? "" : doc?.task?.project || "";
  return `<span class="diagram-card-meta" title="${escapeHtml(new Date(diagram.modified).toLocaleString())}">${[project && escapeHtml(project), where && `<code>${escapeHtml(where)}</code>`, `${ago(diagram.modified)} ago`].filter(Boolean).join('<span aria-hidden="true"> · </span>')}</span>`;
}

function card(diagram, group, query, ago, documents) {
  const doc = docOf(placeOf(diagram), documents);
  return `<button class="markdown-image-trigger diagram-thumb diagram-card" type="button" data-diagram="${escapeHtml(diagram.path)}" data-search="${escapeHtml(searchText(diagram, doc))}" aria-label="Open the ${escapeHtml(diagram.title)} diagram">
    ${frame(diagram)}
    <span class="diagram-card-text">${titleHtml(diagram, query)}${diagram.subtitle ? `<span>${escapeHtml(diagram.subtitle)}</span>` : ""}${metaLine(diagram, doc, group, ago)}</span>
  </button>`;
}

function listRow(diagram, group, query, ago, documents) {
  const doc = docOf(placeOf(diagram), documents);
  const task = doc?.task;
  const where = task ? taskLink(doc, taskName(task)) : `<span class="diagram-row-folder"><code>${escapeHtml(placeOf(diagram))}/</code></span>`;
  const modified = new Date(diagram.modified);
  return `<div class="diagram-row" role="row" data-search="${escapeHtml(searchText(diagram, doc))}">
    <button class="markdown-image-trigger diagram-thumb diagram-card diagram-row-open" type="button" data-diagram="${escapeHtml(diagram.path)}" aria-label="Open the ${escapeHtml(diagram.title)} diagram">
      ${frame(diagram)}
      <span class="diagram-card-text">${titleHtml(diagram, query)}${diagram.subtitle ? `<span>${escapeHtml(diagram.subtitle)}</span>` : ""}<code>${escapeHtml(diagram.path)}</code></span>
    </button>
    <span class="diagram-row-task">${where}${task ? `<span class="diagram-row-status">${statusText(task)}${task.project ? `<span aria-hidden="true"> · </span>${escapeHtml(task.project)}` : ""}</span>` : ""}</span>
    <time class="diagram-row-time" datetime="${modified.toISOString()}" title="${escapeHtml(modified.toLocaleString())}">${ago(diagram.modified)} ago</time>
  </div>`;
}

function groupHead(group, ago) {
  const { doc } = group;
  const task = doc?.task;
  let name;
  if (group.by === "task") name = task ? `<code>${escapeHtml(task.id)}</code><strong>${escapeHtml(task.title)}</strong>` : `<strong>${escapeHtml(doc?.title || group.key)}</strong>`;
  else name = `<strong>${escapeHtml(group.label)}</strong>`;
  const title = doc ? `<a class="diagram-group-title markdown-document-link" href="${escapeHtml(documentHref(doc.path, ""))}" data-document-path="${escapeHtml(doc.path)}" data-document-anchor="">${name}</a>` : `<span class="diagram-group-title">${name}</span>`;
  const facts = [
    task && group.by === "task" ? statusText(task) : "",
    group.by === "task" ? (task?.project ? escapeHtml(task.project) : doc ? "" : `<code>${escapeHtml(group.key)}/</code>`) : "",
    `${group.items.length} ${group.items.length === 1 ? "diagram" : "diagrams"}`,
    group.by === "day" ? "" : `${ago(group.newest)} ago`,
  ].filter(Boolean).join('<span aria-hidden="true"> · </span>');
  return `<header class="diagram-group-head"><button class="diagram-fold" type="button" data-diagram-fold aria-label="Collapse or expand ${escapeHtml(group.label || group.key)}"></button>${title}<span class="diagram-group-meta">${facts}</span></header>`;
}

const segment = (label, options, current, attribute) => `<span class="diagram-control"><span class="diagram-control-label">${label}</span><span class="code-segment" role="group" aria-label="${label}">${options.map(([value, text]) => `<button type="button" ${attribute}="${value}" aria-pressed="${value === current}">${text}</button>`).join("")}</span></span>`;

const NO_PROJECT = "No project";
const projectOf = (diagram, documents) => docOf(placeOf(diagram), documents)?.task?.project || NO_PROJECT;

export function diagramsPageHtml(diagrams, documents, query, ago, { by = "", as = "", project = "", fold = "" } = {}) {
  by = DIAGRAM_GROUPS.some(([value]) => value === by) ? by : "";
  as = DIAGRAM_LAYOUTS.some(([value]) => value === as) ? as : "";
  const projects = new Map();
  for (const diagram of diagrams) projects.set(projectOf(diagram, documents), (projects.get(projectOf(diagram, documents)) || 0) + 1);
  if (!projects.has(project)) project = "";
  const all = diagrams;
  if (project) diagrams = diagrams.filter((diagram) => projectOf(diagram, documents) === project);
  const groups = diagramGroups(diagrams, documents, by);
  const intro = all.length
    ? `${diagrams.length === all.length ? "" : `${diagrams.length} of `}${all.length} ${all.length === 1 ? "diagram" : "diagrams"}`
    : "No diagrams yet. Write a <code>.draft</code> beside a task and embed it with <code>![What it shows](TASK-NNNN-assets/x.draft)</code>; it shows here and in the task.";
  const q = query.trim().toLowerCase();
  const controls = diagrams.length
    ? `${segment("Group", DIAGRAM_GROUPS, by, "data-diagrams-by")}${projects.size > 1 ? `<label class="diagram-control"><span class="diagram-control-label">Project</span><select class="diagram-project" aria-label="Filter by project"><option value="">All (${all.length})</option>${[...projects].sort(([a], [b]) => (a === NO_PROJECT) - (b === NO_PROJECT) || a.localeCompare(b)).map(([name, count]) => `<option value="${escapeHtml(name)}"${name === project ? " selected" : ""}>${escapeHtml(name)} (${count})</option>`).join("")}</select></label>` : ""}${segment("View", DIAGRAM_LAYOUTS, as, "data-diagrams-as")}<button class="diagram-fold-all" type="button" data-diagrams-fold-all="${fold ? "" : "1"}">${fold ? "Expand all" : "Collapse all"}</button><input class="diagram-filter" type="search" value="${escapeHtml(query)}" placeholder="Filter by title, task or file" aria-label="Filter diagrams (/)" spellcheck="false"><kbd class="diagram-filter-key">/</kbd>`
    : "";
  const body = (group) => as === "list"
    ? `<div class="diagram-table" role="table">${group.items.map((diagram) => listRow(diagram, group, q, ago, documents)).join("")}</div>`
    : `<div class="diagram-strip">${group.items.map((diagram) => card(diagram, group, q, ago, documents)).join("")}</div>`;
  return `<section class="library-list diagram-index" data-as="${as}" aria-label="Diagrams">
    <div class="diagram-index-bar"><p class="library-intro">${intro}</p>${controls}</div>
    ${as === "list" && all.length ? `<div class="diagram-row diagram-row-head" aria-hidden="true"><span>Diagram</span><span>Task</span><span>Modified</span></div>` : ""}
    ${groups.map((group) => `<section class="diagram-group" data-group="${escapeHtml(group.key)}"${fold ? " data-folded" : ""}>${groupHead(group, ago)}${body(group)}</section>`).join("")}
    <p class="library-intro diagram-none" hidden>No diagram matches “<span></span>”.</p>
  </section>`;
}

// Hides cards, rows and groups that don't match, marks the match in each title, and says when nothing is left. Runs in
// place, so the filter keeps focus and the thumbnails stay loaded.
export function filterDiagrams(container, query) {
  const q = query.trim().toLowerCase();
  let shown = 0;
  for (const group of container.querySelectorAll(".diagram-group")) {
    let inGroup = 0;
    for (const item of group.querySelectorAll("[data-search]")) {
      const match = !q || item.dataset.search.includes(q);
      item.hidden = !match;
      const title = item.querySelector("[data-title]");
      title.innerHTML = mark(title.dataset.title, q);
      inGroup += match;
    }
    group.hidden = !inGroup;
    shown += inGroup;
  }
  const none = container.querySelector(".diagram-none");
  if (none) {
    none.hidden = shown > 0;
    none.querySelector("span").textContent = query.trim();
  }
}
