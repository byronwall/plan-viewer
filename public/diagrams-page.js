// The Diagrams page (`?view=diagrams`): every `.draft` in the workspace as thumbnails, one row per task or folder,
// newest first. A card opens the image viewer's diagram mode, with every card on the page in its rail.
import { diagramHref, documentHref, escapeHtml } from "./markdown.js";

const STATUS = { open: "Open", active: "Active", waiting: "Waiting", deferred: "Deferred", completed: "Completed" };

// Groups diagrams by the task whose assets hold them, else by folder (a plan topic, a day, reference). Groups are
// ordered by their newest diagram, and so are the diagrams inside them.
export function diagramGroups(diagrams, documents) {
  const groups = new Map();
  for (const diagram of diagrams) {
    const key = diagram.task || diagram.path.split("/").slice(0, diagram.path.startsWith("plans/") ? 2 : -1).join("/");
    if (!groups.has(key)) groups.set(key, { key, items: [] });
    groups.get(key).items.push(diagram);
  }
  for (const group of groups.values()) {
    group.doc = group.key.startsWith("TASK-") ? documents.find((doc) => doc.path === `tasks/${group.key}.md`)
      : documents.find((doc) => doc.path === `${group.key}/README.md` || doc.path === `${group.key}/plan.md`);
    group.newest = Math.max(...group.items.map((item) => item.modified));
  }
  return [...groups.values()].sort((a, b) => b.newest - a.newest);
}

const searchText = (diagram, group) => [diagram.title, diagram.subtitle, diagram.path, group.key, group.doc?.task?.title || group.doc?.title || ""].join(" ").toLowerCase();

function mark(text, query) {
  if (!query) return escapeHtml(text);
  const at = text.toLowerCase().indexOf(query);
  return at < 0 ? escapeHtml(text) : `${escapeHtml(text.slice(0, at))}<mark>${escapeHtml(text.slice(at, at + query.length))}</mark>${escapeHtml(text.slice(at + query.length))}`;
}

function card(diagram, group, query) {
  return `<button class="markdown-image-trigger diagram-thumb diagram-card" type="button" data-diagram="${escapeHtml(diagram.path)}" data-search="${escapeHtml(searchText(diagram, group))}" aria-label="Open the ${escapeHtml(diagram.title)} diagram">
    <span class="diagram-thumb-frame"><img class="markdown-image" src="${escapeHtml(diagramHref(diagram.path))}" alt="${escapeHtml(diagram.title)}" loading="lazy" decoding="async"></span>
    <span class="diagram-card-text"><strong data-title="${escapeHtml(diagram.title)}">${mark(diagram.title, query)}</strong>${diagram.subtitle ? `<span>${escapeHtml(diagram.subtitle)}</span>` : ""}</span>
  </button>`;
}

function groupHead(group, ago) {
  const { doc } = group;
  const task = doc?.task;
  const name = task ? `<code>${escapeHtml(task.id)}</code><strong>${escapeHtml(task.title)}</strong>` : `<strong>${escapeHtml(doc?.title || group.key)}</strong>`;
  const title = doc ? `<a class="diagram-group-title markdown-document-link" href="${escapeHtml(documentHref(doc.path, ""))}" data-document-path="${escapeHtml(doc.path)}" data-document-anchor="">${name}</a>` : `<span class="diagram-group-title">${name}</span>`;
  const facts = [
    task ? `<span class="diagram-group-status" data-status="${escapeHtml(task.status)}">${STATUS[task.status] || escapeHtml(task.status)}</span>` : "",
    task?.project ? escapeHtml(task.project) : doc ? "" : `<code>${escapeHtml(group.key)}/</code>`,
    `${group.items.length} ${group.items.length === 1 ? "diagram" : "diagrams"}`,
    `${ago(group.newest)} ago`,
  ].filter(Boolean).join('<span aria-hidden="true"> · </span>');
  return `<header class="diagram-group-head">${title}<span class="diagram-group-meta">${facts}</span></header>`;
}

export function diagramsPageHtml(diagrams, documents, query, ago) {
  const groups = diagramGroups(diagrams, documents);
  const places = groups.length;
  const intro = diagrams.length
    ? `${diagrams.length} ${diagrams.length === 1 ? "diagram" : "diagrams"} in ${places} ${places === 1 ? "place" : "places"}, newest first.`
    : "No diagrams yet. Write a <code>.draft</code> beside a task and embed it with <code>![What it shows](TASK-NNNN-assets/x.draft)</code>; it shows here and in the task.";
  const q = query.trim().toLowerCase();
  return `<section class="library-list diagram-index" aria-label="Diagrams">
    <div class="diagram-index-bar"><p class="library-intro">${intro}</p>${diagrams.length ? `<input class="diagram-filter" type="search" value="${escapeHtml(query)}" placeholder="Filter by title, task or file" aria-label="Filter diagrams (/)" spellcheck="false"><kbd class="diagram-filter-key">/</kbd>` : ""}</div>
    ${groups.map((group) => `<section class="diagram-group" data-group="${escapeHtml(group.key)}">${groupHead(group, ago)}<div class="diagram-strip">${group.items.map((diagram) => card(diagram, group, q)).join("")}</div></section>`).join("")}
    <p class="library-intro diagram-none" hidden>No diagram matches “<span></span>”.</p>
  </section>`;
}

// Hides cards and groups that don't match, marks the match in each title, and says when nothing is left. Runs in
// place, so the filter keeps focus and the thumbnails stay loaded.
export function filterDiagrams(container, query) {
  const q = query.trim().toLowerCase();
  let shown = 0;
  for (const group of container.querySelectorAll(".diagram-group")) {
    let inGroup = 0;
    for (const item of group.querySelectorAll(".diagram-card")) {
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
