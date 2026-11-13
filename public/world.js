// The world views: one task's documents, diagrams, images, files, plan days and updates on a day-by-day canvas with the
// oldest at the left (`?world=TASK-0082`), and every task as one row on the same kind of axis (`?world=all`). Days with
// nothing happening are skipped and marked as gaps; days more than two weeks before the newest are faded but stay
// one drag away. Drag pans, pinch or ⌘-wheel zooms around the cursor.
import { announceClosed, createOverlay, setOverlayParams } from "./overlay.js";
import { diagramHref, documentHref, escapeHtml } from "./markdown.js";
import { localTodayKey } from "./dates.js";
import { workStatusIcon } from "./actions.js";
import { showStepLayer, stepListHtml } from "./steps-page.js";

// Work first (what got done, and today what is ready), then the pictures, so the top of the canvas is where the task
// stands and what it looks like; the narrative lanes follow.
export const LANES = [
  { key: "work", label: "Work", noun: ["work item done", "work items done"] },
  { key: "diagram", label: "Diagrams", noun: ["diagram", "diagrams"] },
  { key: "image", label: "Images", noun: ["image", "images"] },
  { key: "document", label: "Documents", noun: ["document", "documents"] },
  { key: "updates", label: "Updates", noun: ["update", "updates"] },
  { key: "days", label: "Plans", noun: ["plan", "plans"] },
  { key: "file", label: "Files", noun: ["file", "files"] },
];
const READY_SHOWN = 4;
const TODAY_ROWS = 8;
const RECENT_DAYS = 14;
const DAY_MS = 86_400_000;

// app.js supplies what the world opens into: { documents(), tasks(), steps(id), step(key), peek(path, anchor), images(items, index, trigger), copy(path, button), open(path) }.
let host = null;
export const connectWorld = (value) => { host = value; };

let dialog = null;
let current = { id: "", day: "" };
// Views to go back to, newest last: each a snapshot of what was on screen, so Back returns to the same scroll and zoom.
const trail = [];
let leaving = false;

const dayNumber = (key) => Date.UTC(...key.split("-").map((part, index) => Number(part) - (index === 1 ? 1 : 0))) / DAY_MS;
const dayLabel = (key, weekday = true) => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { ...(weekday ? { weekday: "short" } : {}), month: "short", day: "numeric" });
const assetHref = (path) => `/api/asset?${new URLSearchParams({ path })}`;
const fileName = (path) => path.split("/").pop();
// Update titles carry `code` spans; anything richer stays plain text, since the card is itself a button.
const codeSpans = (text) => escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");

// Everything one task holds, each item with its lane and local day. Asset dates are when the file last changed.
export function taskItems(id, world, documents) {
  const task = documents.find((doc) => doc.path === `tasks/${id}.md`)?.task;
  const entry = world.tasks[id] || { files: [], updates: [] };
  const items = [];
  if (task?.created) items.push({ lane: "updates", day: task.created, title: "Task created", created: true });
  for (const update of entry.updates) items.push({ lane: "updates", day: update.date, title: update.title });
  for (const path of task?.referencedBy || []) {
    const doc = documents.find((candidate) => candidate.path === path);
    if (doc?.date) items.push({ lane: "days", day: doc.date, path, title: doc.kind === "Plan" ? "Plan" : doc.title });
  }
  // A completed work item sits on the day of the last update that names it (`… (W1.2)`); items no update names have no
  // day to sit on and stay out. Today lists the first few ready items, leaves only, so the newest column says what's next.
  // ponytail: ranges like "W9.3 to W9.5" date only their ends.
  const work = task?.work || [];
  const named = new Map();
  for (const update of entry.updates) for (const [workId] of update.title.matchAll(/\bW\d+(?:\.\d+)*\b/g)) if (!named.has(workId) || named.get(workId) < update.date) named.set(workId, update.date);
  for (const node of work) if (node.status === "completed" && named.has(node.id)) items.push({ lane: "work", day: named.get(node.id), node, title: node.title });
  const ready = work.filter((node) => node.ready && !work.some((child) => child.parent === node.id));
  const today = localTodayKey();
  for (const node of ready.slice(0, READY_SHOWN)) items.push({ lane: "work", day: today, node, title: node.title, ready: true });
  if (ready.length > READY_SHOWN) items.push({ lane: "work", day: today, more: ready.length - READY_SHOWN, ready: true });
  const folder = `tasks/${id}-assets/`;
  // A picture exported beside its `.draft` (flow.png next to flow.draft) is the same drawing; the diagram stands for it.
  const drafts = new Set(entry.files.filter((file) => file.kind === "diagram").map((file) => file.path.replace(/\.draft$/, "")));
  for (const file of entry.files) {
    if (file.kind === "image" && drafts.has(file.path.replace(/\.[^./]+$/, ""))) continue;
    const doc = documents.find((candidate) => candidate.path === file.path);
    const sub = file.path.slice(folder.length);
    items.push({ lane: file.kind, day: localTodayKey(new Date(file.modified)), path: file.path, modified: file.modified, title: doc?.title || fileName(file.path).replace(/\.draft$/, ""), folder: sub.includes("/") ? sub.slice(0, sub.lastIndexOf("/") + 1) : "" });
  }
  return items.sort((a, b) => a.day.localeCompare(b.day) || (b.modified || 0) - (a.modified || 0));
}

// How much each task holds, for the Tasks table: { "TASK-0082": { document, diagram, image } }, PNG exports excluded.
export function taskCounts(world, documents) {
  return Object.fromEntries(Object.keys(world.tasks).map((id) => {
    const counts = { document: 0, diagram: 0, image: 0 };
    for (const item of taskItems(id, world, documents)) if (item.lane in counts) counts[item.lane] += 1;
    return [id, counts];
  }));
}

// The day columns: every day with an item, oldest first, each knowing the gap before it and whether it is recent.
function dayColumns(items) {
  const days = [...new Set(items.map((item) => item.day))].sort();
  const newest = days.at(-1);
  const today = localTodayKey();
  return days.map((day, index) => ({ day, today: day === today, gap: index ? dayNumber(day) - dayNumber(days[index - 1]) - 1 : 0, old: newest && dayNumber(newest) - dayNumber(day) > RECENT_DAYS }));
}

function shell(className) {
  if (dialog) { dialog.className = `code-diff world-overlay ${className}`; return dialog; }
  dialog = createOverlay("world-overlay");
  dialog.innerHTML = `<header class="code-diff-head" data-w="head"></header><div class="world-scroller" data-w="scroller" tabindex="-1"></div>`;
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    if (!leaving) announceClosed(); // not when Open task took you to the page
    leaving = false;
    setOverlayParams({ world: "", "world-day": "" });
    dialog.querySelector('[data-w="scroller"]').replaceChildren();
    trail.length = 0;
  });
  dialog.addEventListener("click", onClick);
  // Backspace, Alt+← and the mouse's back button step back through the trail instead of leaving the page.
  dialog.addEventListener("keydown", (event) => {
    if (event.target.closest("input, textarea")) return;
    if (event.key === "Backspace" || (event.altKey && event.key === "ArrowLeft")) { event.preventDefault(); back(); }
    // Enter opens the task in view as the page, as it does in the document peek; on a focused control it presses that.
    if (event.key === "Enter" && current.id !== "all" && !event.target.closest("a, button") && !(event.metaKey || event.ctrlKey || event.altKey)) { event.preventDefault(); openTask(); }
  });
  dialog.addEventListener("mouseup", (event) => { if (event.button === 3) { event.preventDefault(); back(); } });
  installPanZoom(dialog.querySelector('[data-w="scroller"]'));
  dialog.className = `code-diff world-overlay ${className}`;
  return dialog;
}

export async function fetchWorld() {
  const response = await fetch("/api/task-world");
  if (!response.ok) throw new Error("Could not load the task files. The viewer's server may have restarted.");
  return response.json();
}

// `lead` sits before the title: the way back (or up to All tasks).
// The frame controls stay disabled until there is a canvas to frame, so they never look live over an empty one.
const head = (title, detail, tools, lead = "", ready = true) => `${lead}<div class="issue-overview-title"><h3>${title}</h3><p class="code-muted">${detail}</p></div><span class="code-spacer"></span>${tools}<span class="world-frame"><button type="button" class="code-bar-button" data-world-fit="recent" title="Newest two weeks at full size"${ready ? "" : " disabled"}>Recent</button><button type="button" class="code-bar-button" data-world-fit="all" title="Zoom out to the whole history"${ready ? "" : " disabled"}>All</button><button type="button" class="world-zoom" data-world-zoom title="Reset to 100%"${ready ? "" : " disabled"}>100%</button></span><button type="button" class="code-icon-button" data-world-close aria-label="Close (Esc)">×</button>`;
// A failed load says so in the header (replacing "Loading…") and offers the retry beside the message.
function failed(box, title, error) {
  box.querySelector('[data-w="head"]').innerHTML = head(title, "Not loaded", current.id === "all" ? "" : openTaskButton(current.id), backButton, false);
  syncBack();
  box.querySelector('[data-w="scroller"]').innerHTML = `<div class="world-empty"><p class="work-warning">${escapeHtml(error.message)}</p><button type="button" class="code-bar-button" data-world-retry>Try again</button></div>`;
}

const noun = (lane, count) => `${count} ${lane.noun[count === 1 ? 0 : 1]}`;
function legend(counts) {
  return `<span class="world-legend">${LANES.filter((lane) => counts[lane.key]).map((lane) => `<span><i class="world-dot" data-lane="${lane.key}"></i>${escapeHtml(noun(lane, counts[lane.key]))}</span>`).join("")}</span>`;
}

// ---------- moving between views ----------

function snapshot() {
  const scroller = dialog.querySelector('[data-w="scroller"]');
  return { current: { ...current }, className: dialog.className, head: dialog.querySelector('[data-w="head"]').innerHTML, body: scroller.innerHTML, left: scroller.scrollLeft, top: scroller.scrollTop, zoom: zoomOf(scroller), visuals: dialog.visuals };
}

function back() {
  const view = trail.pop();
  if (!view) return current.id !== "all" && up();
  const scroller = dialog.querySelector('[data-w="scroller"]');
  current = view.current;
  dialog.className = view.className;
  dialog.visuals = view.visuals;
  dialog.querySelector('[data-w="head"]').innerHTML = view.head;
  scroller.style.setProperty("--zoom", String(view.zoom));
  scroller.innerHTML = view.body;
  scroller.scrollLeft = view.left;
  scroller.scrollTop = view.top;
  setOverlayParams({ world: current.id, "world-day": current.day || "" });
  syncBack();
}

// From a task to All tasks: back to the one you came from when that is where you were, else a fresh one.
function up() {
  if (trail.at(-1)?.current.id === "all") return back();
  trail.push(snapshot());
  openPortfolio(host.tasks());
}

function go(id, day) {
  trail.push(snapshot());
  openTaskWorld(id, day);
}

// The ← button names where it goes; a task view with nothing behind it offers All tasks instead.
function backLabel() {
  const previous = trail.at(-1)?.current;
  if (previous) return previous.id === "all" ? "All tasks" : previous.id;
  return current.id === "all" ? "" : "All tasks";
}
function syncBack() {
  const button = dialog.querySelector("[data-world-back]");
  const label = backLabel();
  if (!button) return;
  button.hidden = !label;
  button.querySelector("span:last-child").textContent = label;
  button.title = trail.length ? `Back to ${label} (⌫)` : "Every task on one timeline (⌫)";
}
const backButton = `<button type="button" class="code-bar-button world-back" data-world-back hidden><span aria-hidden="true" class="world-back-arrow">←</span><span></span></button>`;

// Leaves the world for the task's page, wherever the world was opened from.
function openTask() {
  leaving = true;
  host.open(`tasks/${current.id}.md`);
}
const openTaskButton = (id) => `<a class="code-bar-button is-primary world-open" href="${escapeHtml(documentHref(`tasks/${id}.md`, ""))}" data-world-open-task title="Open ${escapeHtml(id)} as the page (Enter)">Open task <kbd>↵</kbd></a>`;

// A task's Today column: its open steps as the shared step list (You first when anything waits on you), eight a segment,
// each opening the step dialog over the world; "+N more" opens the dialog on the task, whose rail lists them all.
function todaySteps(id) {
  const { toggle, stack } = stepListHtml(host.steps(id), { cap: TODAY_ROWS, more: (move, count) => `<button type="button" class="world-more" data-open-step="${escapeHtml(id)}">+${count - TODAY_ROWS} more</button>` });
  return `<div class="world-steps step-panel">${toggle}${stack}</div>`;
}

// ---------- one task ----------

export async function openTaskWorld(id, day = "") {
  const box = shell("is-task");
  current = { id, day };
  setOverlayParams({ world: id, "world-day": day });
  const task = host.documents().find((doc) => doc.path === `tasks/${id}.md`)?.task;
  const scroller = box.querySelector('[data-w="scroller"]');
  const title = `<code>${escapeHtml(id)}</code>${escapeHtml(task?.title || "")}`;
  box.querySelector('[data-w="head"]').innerHTML = head(title, "Loading files…", openTaskButton(id), backButton, false);
  syncBack();
  scroller.innerHTML = "";
  if (!box.open) { box.showModal(); box.focus({ preventScroll: true }); }
  let world;
  try { world = await fetchWorld(); } catch (error) { if (current.id === id) failed(box, title, error); return; }
  if (current.id !== id) return;
  const items = taskItems(id, world, host.documents());
  // Today's column is the task's step list, so it exists whenever the task has open steps, ready or not.
  const hasSteps = host.steps(id).length > 0;
  if (hasSteps && !items.some((item) => item.lane === "work" && item.ready)) items.push({ lane: "work", day: localTodayKey(), ready: true, more: 0 });
  const columns = dayColumns(items);
  const lanes = LANES.filter((lane) => items.some((item) => item.lane === lane.key));
  const counts = Object.fromEntries(lanes.map((lane) => [lane.key, items.filter((item) => item.lane === lane.key && !item.created && !item.ready).length]));
  const readyCount = (task?.work || []).filter((node) => node.ready && !task.work.some((child) => child.parent === node.id)).length;
  const span = columns.length ? `${dayLabel(columns[0].day, false)} – ${dayLabel(columns.at(-1).day, false)} · ${columns.length} active ${columns.length === 1 ? "day" : "days"}` : "Nothing filed yet";
  box.querySelector('[data-w="head"]').innerHTML = head(title, escapeHtml(span + (readyCount ? ` · ${readyCount} ready now` : "")), legend(counts) + openTaskButton(id), backButton);
  syncBack();
  // Images and diagrams open in the image viewer together, newest first, grouped by day, so its rail is the task's gallery.
  const visuals = items.filter((item) => item.lane === "image" || item.lane === "diagram").reverse();
  box.visuals = visuals.map((item) => ({ src: item.lane === "diagram" ? diagramHref(item.path) : assetHref(item.path), alt: item.title, ...(item.lane === "diagram" ? { diagram: item.path } : {}), group: dayLabel(item.day) }));
  const visualIndex = new Map(visuals.map((item, index) => [item, index]));
  const cell = (lane, items) => {
    if (lane === "updates") return items.map((item) => `<button type="button" class="world-card world-update${item.created ? " is-created" : ""}" data-world-peek="tasks/${escapeHtml(id)}.md" data-world-anchor="${item.created ? "" : "updates"}"><span>${codeSpans(item.title)}</span></button>`).join("");
    // Done items keep their check rows; today's ready items give way to the step list. Every row opens the step dialog.
    if (lane === "work") return items.filter((item) => !item.ready).map((item) => `<button type="button" class="world-card world-work" data-open-step="${escapeHtml(`${id}:${item.node.id}`)}">${workStatusIcon(item.node, task.work)}<code>${escapeHtml(item.node.id)}</code><span>${codeSpans(item.title)}</span></button>`).join("")
      + (hasSteps && items.some((item) => item.ready) ? todaySteps(id) : "");
    if (lane === "days") return `<span class="world-chips">${items.map((item) => `<button type="button" class="world-chip" data-world-peek="${escapeHtml(item.path)}">${escapeHtml(item.title)}</button>`).join("")}</span>`;
    if (lane === "document") return items.map((item) => `<button type="button" class="world-card" data-world-peek="${escapeHtml(item.path)}" title="${escapeHtml(item.path)}"><span>${escapeHtml(item.title)}</span>${item.folder ? `<small>${escapeHtml(item.folder)}</small>` : ""}</button>`).join("");
    if (lane === "file") return items.map((item) => `<button type="button" class="world-file" data-world-copy="${escapeHtml(item.path)}" title="Copy ${escapeHtml(item.path)}">${item.folder ? `<small>${escapeHtml(item.folder)}</small>` : ""}${escapeHtml(fileName(item.path))}</button>`).join("");
    return `<span class="world-thumbs">${items.map((item) => `<button type="button" class="world-thumb" data-world-visual="${visualIndex.get(item)}" title="${escapeHtml(item.path)}"><span class="world-thumb-frame"><img src="${escapeHtml(item.lane === "diagram" ? diagramHref(item.path) : assetHref(item.path))}" alt="" loading="lazy" decoding="async"></span><span class="world-thumb-title">${escapeHtml(item.title)}</span></button>`).join("")}</span>`;
  };
  if (!columns.length) { scroller.innerHTML = `<p class="world-empty">${escapeHtml(id)} has no updates, plan mentions, work or files yet.</p>`; return; }
  const columnClass = (column) => `${column.old ? " is-old" : ""}${column.gap ? " has-gap" : ""}${column.day === day ? " is-focus" : ""}${column.today ? " is-today" : ""}`;
  const header = columns.map((column) => {
    const count = items.filter((item) => item.day === column.day && !item.created && !item.ready).length;
    const note = [column.gap && `${column.gap} quiet ${column.gap === 1 ? "day" : "days"} before`, count && `${count} ${count === 1 ? "item" : "items"} this day`].filter(Boolean).join(" · ");
    return `<div class="world-day${columnClass(column)}" data-world-day="${column.day}"${note ? ` title="${note}"` : ""}><strong>${column.today ? "Today" : escapeHtml(dayLabel(column.day))}</strong><span>${count || ""}</span></div>`;
  }).join("");
  const rows = lanes.map((lane) => `<div class="world-lane-label"><i class="world-dot" data-lane="${lane.key}"></i>${escapeHtml(lane.label)}</div>${columns.map((column) => {
    const here = items.filter((item) => item.lane === lane.key && item.day === column.day);
    return `<div class="world-cell${columnClass(column)}" data-lane="${lane.key}">${here.length ? cell(lane.key, here) : ""}</div>`;
  }).join("")}`).join("");
  // The Today column holds a step list, so it gets room for a pill and a full title.
  const wide = hasSteps && columns.some((column) => column.today);
  const template = columns.map((column) => column.today && hasSteps ? "minmax(var(--today-col), 1.6fr)" : "minmax(var(--col), 1fr)").join(" ");
  const size = wide ? `;grid-template-columns:var(--label) ${template};width:max(100%, calc(var(--label) + ${columns.length - 1} * var(--col) + var(--today-col)))` : "";
  scroller.innerHTML = `<div class="world-grid world-task-grid" style="--columns:${columns.length}${size}"><div class="world-corner"></div>${header}${rows}</div>`;
  fit(scroller, "recent", day);
}

// ---------- every task ----------

// `tasks` is the Tasks page's list (its order and its completed toggle), as { id, title, status } rows.
export async function openPortfolio(tasks) {
  const box = shell("is-portfolio");
  current = { id: "all", day: "", tasks };
  setOverlayParams({ world: "all", "world-day": "" });
  const scroller = box.querySelector('[data-w="scroller"]');
  box.querySelector('[data-w="head"]').innerHTML = head("All tasks", "Loading files…", "", backButton, false);
  syncBack();
  scroller.innerHTML = "";
  if (!box.open) { box.showModal(); box.focus({ preventScroll: true }); }
  let world;
  try { world = await fetchWorld(); } catch (error) { if (current.id === "all") failed(box, "All tasks", error); return; }
  if (current.id !== "all") return;
  const documents = host.documents();
  const rowsData = tasks.map((task) => ({ ...task, items: taskItems(task.id, world, documents).filter((item) => !item.created) }));
  const columns = dayColumns(rowsData.flatMap((row) => row.items));
  const counts = {};
  for (const item of rowsData.flatMap((row) => row.items)) if (!item.ready && !item.more) counts[item.lane] = (counts[item.lane] || 0) + 1;
  box.querySelector('[data-w="head"]').innerHTML = head("All tasks", escapeHtml(`${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} · ${columns.length} active days · newest at the right`), legend(counts), backButton);
  syncBack();
  if (!columns.length) { scroller.innerHTML = `<p class="world-empty">No task has updates, plan mentions or files yet.</p>`; return; }
  const columnClass = (column) => `${column.old ? " is-old" : ""}${column.gap ? " has-gap" : ""}${column.today ? " is-today" : ""}`;
  const header = columns.map((column) => `<div class="world-day${columnClass(column)}" data-world-day="${column.day}" title="${escapeHtml(dayLabel(column.day))}"><strong>${column.today ? "Today" : escapeHtml(dayLabel(column.day, false))}</strong></div>`).join("");
  // A cell shows the day's newest picture, then one dot per kind with its count. Plan mentions and loose files are left
  // to the task's own view: they say little at this distance and crowded the cell. Today's work dot counts ready items.
  const cell = (row, column) => {
    const here = row.items.filter((item) => item.day === column.day);
    if (!here.length) return `<div class="world-cell${columnClass(column)}"></div>`;
    const pictures = here.filter((item) => item.lane === "image" || item.lane === "diagram").sort((a, b) => (b.modified || 0) - (a.modified || 0)).slice(0, 1);
    const dots = LANES.filter((lane) => lane.key !== "days" && lane.key !== "file").map((lane) => [lane, here.filter((item) => item.lane === lane.key).reduce((sum, item) => sum + (item.more || 1), 0)]).filter(([, count]) => count);
    if (!dots.length && !pictures.length) return `<div class="world-cell${columnClass(column)}"></div>`;
    const readyHere = here.filter((item) => item.ready).reduce((sum, item) => sum + (item.more || 1), 0);
    const summary = dots.map(([lane, count]) => lane.key === "work" && readyHere ? [count - readyHere && `${count - readyHere} done`, `${readyHere} ready`].filter(Boolean).join(" and ") + " work" : noun(lane, count)).join(", ");
    return `<button type="button" class="world-cell world-mark${columnClass(column)}" data-world-task="${escapeHtml(row.id)}" data-world-at="${column.day}" title="${escapeHtml(`${row.id} · ${dayLabel(column.day)}: ${summary}`)}">${pictures.map((item) => `<span class="world-mini"><img src="${escapeHtml(item.lane === "diagram" ? diagramHref(item.path) : assetHref(item.path))}" alt="" loading="lazy" decoding="async"></span>`).join("")}<span class="world-dots">${dots.map(([lane, count]) => `<span><i class="world-dot" data-lane="${lane.key}"></i>${count > 1 ? count : ""}</span>`).join("")}</span></button>`;
  };
  const rows = rowsData.map((row) => `<button type="button" class="world-lane-label world-task-label" data-world-task="${escapeHtml(row.id)}"><code>${escapeHtml(row.id)}</code><span>${escapeHtml(row.title)}</span></button>${columns.map((column) => cell(row, column)).join("")}`).join("");
  scroller.innerHTML = `<div class="world-grid world-portfolio-grid" style="--columns:${columns.length}"><div class="world-corner"></div>${header}${rows}</div>`;
  fit(scroller, "recent");
}

// ---------- clicks, pan and zoom ----------

function onClick(event) {
  if (event.target === dialog) return;
  const openLink = event.target.closest("[data-world-open-task]");
  if (openLink && !(event.metaKey || event.ctrlKey || event.shiftKey)) { event.preventDefault(); return openTask(); }
  const move = event.target.closest(".step-panel [data-step-list-move]");
  if (move) return showStepLayer(move.closest(".step-panel"), move.dataset.stepListMove);
  const step = event.target.closest("[data-open-step]");
  if (step) return host.step(step.dataset.openStep);
  const target = event.target.closest("[data-world-close], [data-world-back], [data-world-fit], [data-world-zoom], [data-world-retry], [data-world-peek], [data-world-visual], [data-world-copy], [data-world-task]");
  if (!target) return;
  const scroller = dialog.querySelector('[data-w="scroller"]');
  if (target.matches("[data-world-close]")) dialog.close();
  else if (target.matches("[data-world-fit]")) fit(scroller, target.dataset.worldFit);
  else if (target.matches("[data-world-back]")) back();
  else if (target.matches("[data-world-zoom]")) setZoom(scroller, 1);
  else if (target.matches("[data-world-retry]")) current.id === "all" ? openPortfolio(current.tasks) : openTaskWorld(current.id, current.day);
  else if (target.matches("[data-world-peek]")) host.peek(target.dataset.worldPeek, target.dataset.worldAnchor || "");
  else if (target.matches("[data-world-visual]")) host.images(dialog.visuals, Number(target.dataset.worldVisual), target);
  else if (target.matches("[data-world-copy]")) host.copy(target.dataset.worldCopy, target);
  else if (target.matches("[data-world-task]")) go(target.dataset.worldTask, target.dataset.worldAt || "");
}

const zoomOf = (scroller) => Number(scroller.style.getPropertyValue("--zoom")) || 1;
function setZoom(scroller, zoom, focus = null) {
  const old = zoomOf(scroller);
  const next = Math.min(2, Math.max(0.2, zoom));
  // CSS zoom scales layout, so scroll offsets scale with it; keep the content under the focus point still.
  const rect = scroller.getBoundingClientRect();
  const fx = focus ? focus.x - rect.left : scroller.clientWidth / 2;
  const fy = focus ? focus.y - rect.top : scroller.clientHeight / 2;
  const x = (scroller.scrollLeft + fx) / old;
  const y = (scroller.scrollTop + fy) / old;
  scroller.style.setProperty("--zoom", String(next));
  scroller.scrollLeft = x * next - fx;
  scroller.scrollTop = y * next - fy;
  const label = dialog.querySelector("[data-world-zoom]");
  if (label) label.textContent = `${Math.round(next * 100)}%`;
}

// "recent" opens at full size scrolled to the newest day (or the named one); "all" zooms out to the whole width.
function fit(scroller, mode, day = "") {
  const grid = scroller.querySelector(".world-grid");
  if (!grid) return;
  if (mode === "all") {
    setZoom(scroller, 1);
    setZoom(scroller, Math.min(1, scroller.clientWidth / grid.scrollWidth));
    scroller.scrollLeft = 0;
    return;
  }
  setZoom(scroller, 1);
  const focus = day && grid.querySelector(`.world-day[data-world-day="${CSS.escape(day)}"]`);
  scroller.scrollLeft = focus ? focus.offsetLeft - scroller.clientWidth / 2 + focus.offsetWidth / 2 : scroller.scrollWidth;
  scroller.scrollTop = 0;
}

function installPanZoom(scroller) {
  scroller.addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return; // a pinch arrives as ctrl+wheel; plain wheels and swipes scroll
    event.preventDefault();
    setZoom(scroller, zoomOf(scroller) * Math.exp(-event.deltaY * 0.01), { x: event.clientX, y: event.clientY });
  }, { passive: false });
  // Drag anywhere to pan. A drag that moved swallows the click that ends it, so cards under the pointer don't open.
  scroller.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    const start = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    let moved = false;
    const move = (next) => {
      const dx = next.clientX - start.x;
      const dy = next.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      scroller.classList.add("is-panning");
      scroller.scrollLeft = start.left - dx;
      scroller.scrollTop = start.top - dy;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      scroller.classList.remove("is-panning");
      if (!moved) return;
      const swallow = (click) => { click.stopPropagation(); click.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true })); // no click follows a drag that left the window

    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}
