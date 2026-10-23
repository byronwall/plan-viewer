import { escapeHtml, markdownOutline, renderMarkdown } from "./markdown.js";
import { agentApp, agentName as appName } from "./config.js";
import { ago, copied, fadeIn, hideTip, iconButton, isSummonKey, openPrOverlay, showTip, sideFacts, when, heat } from "./code.js";

// The Code view's Plans tab: initiatives on each tracked repo's origin/main (and proposed in open PRs), as a list, an
// inspector, and a reader overview. Read-only; Update and Retire open agent drafts. docs/plans-plan.md has the why.
const DAY = 24 * 3_600_000;
const STATUSES = ["planned", "active", "paused", "completed", "cancelled"];
const FINISHED = new Set(["completed", "cancelled"]);
const SCOPES = { open: "Open", ...Object.fromEntries(STATUSES.map((status) => [status, status[0].toUpperCase() + status.slice(1)])), all: "All" };
const SORTS = { edited: "Edited", title: "Title", status: "Status", phase: "Phase" };
const PHASES = ["intent", "brainstorm", "shape", "plan", "execution", "reconciliation"];
const ps = { data: null, error: "", loading: null, scope: "open", sort: "edited", withPr: false, maps: new Map(), docs: new Map() };
let notify = (message) => console.warn(message);
export const setPlanNotice = (show) => { notify = show; };
let code = null; // helpers from code.js: render, select, notify, matches, repoFilter, repoCell, repoHead, tableHead, resetFilters, host

export function initPlans(helpers) {
  code = helpers;
  notify = helpers.notify;
  const params = new URLSearchParams(location.search);
  if (params.get("plans") in SCOPES) ps.scope = params.get("plans");
}

// ---------- data ----------

// `refresh` rescans (R); `poll` only re-reads while the server's open-PR scan is still running.
export function loadPlans(refresh = false, poll = false) {
  if (ps.loading || ((ps.data || ps.error) && !refresh && !poll)) return ps.loading || Promise.resolve(ps.data);
  if (code?.host()) code.host().dataset.plansState = "loading";
  ps.loading = (async () => {
    try {
      const response = await fetch(refresh ? "/api/code/plans?refresh" : "/api/code/plans");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load plans.");
      ps.data = body;
      ps.error = "";
      if (refresh) { ps.maps.clear(); ps.docs.clear(); }
    } catch (error) {
      ps.error = error.message;
      notify(error.message, true);
    } finally {
      ps.loading = null;
    }
    // Open PRs arrive from a background GraphQL scan; poll until it settles, as the Code page does.
    if (ps.data?.scanning) setTimeout(() => loadPlans(false, true), 2500);
    else if (code?.host()) code.host().dataset.plansState = "ready";
    code?.render();
    if (dialog?.open) renderOverview();
    return ps.data;
  })();
  return ps.loading;
}

export const plansLoaded = () => Boolean(ps.data);
const all = () => ps.data?.initiatives || [];
const byId = (id) => all().find((item) => item.id === id);
export const planFor = (key) => byId(key.slice(5));
const repoName = (path) => path.split("/").pop();
const repoInfo = (repo) => ps.data?.repos.find((entry) => entry.repo === repo);
const isOpen = (item) => !FINISHED.has(item.status);
const proposal = (item) => item.prs.find((pr) => pr.change === "proposes");
// Slugs resolve within the same repository: "depends_on" lists other initiatives there.
const bySlug = (repo, slug) => all().find((item) => item.repo === repo && item.slug === slug && item.source === "main") || all().find((item) => item.repo === repo && item.slug === slug);
const neededBy = (item) => all().filter((other) => other.repo === item.repo && other.dependsOn.includes(item.slug));

export function planItems() {
  return all();
}

export function plansCount() {
  return ps.data ? all().filter(isOpen).length : "…";
}

function visible() {
  const scoped = all().filter((item) => ps.scope === "all" || (ps.scope === "open" ? isOpen(item) : item.status === ps.scope))
    .filter((item) => !ps.withPr || item.prs.length)
    .filter(code.repoFilter)
    .filter((item) => code.matches(`${item.title} ${item.slug} ${item.summary} ${item.nextAction} ${item.folder} ${item.phase} ${item.prs.map((pr) => `#${pr.number}`).join(" ")}`));
  const rank = (list, value) => { const index = list.indexOf(value); return index < 0 ? list.length : index; };
  const sorts = {
    edited: (a, b) => b.edited - a.edited,
    title: (a, b) => a.title.localeCompare(b.title),
    status: (a, b) => rank(STATUSES, a.status) - rank(STATUSES, b.status) || b.edited - a.edited,
    phase: (a, b) => rank(PHASES, a.phase) - rank(PHASES, b.phase) || b.edited - a.edited,
  };
  return scoped.sort(sorts[ps.sort] || sorts.edited);
}

// ---------- pieces ----------

const STATUS_MARKS = {
  planned: '<circle cx="8" cy="8" r="5"/>',
  active: '<circle cx="8" cy="8" r="5" class="is-fill"/>',
  paused: '<circle cx="8" cy="8" r="5"/><path d="M6.6 6v4M9.4 6v4"/>',
  completed: '<circle cx="8" cy="8" r="5.5" class="is-fill"/><path class="is-knock" d="m5.6 8.2 1.7 1.7 3.2-3.5"/>',
  cancelled: '<circle cx="8" cy="8" r="5"/><path d="m6.2 6.2 3.6 3.6M9.8 6.2l-3.6 3.6"/>',
  invalid: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.3"/>',
};
function statusMark(item, withLabel = false) {
  const tip = item.error ? `Invalid map: ${item.error}` : `${item.status}${item.inferred ? ` (inferred: ${item.evidence})` : ""}`;
  const mark = `<svg class="plan-mark plan-mark-${item.status}${item.inferred ? " is-inferred" : ""}" viewBox="0 0 16 16" aria-hidden="true">${STATUS_MARKS[item.status] || STATUS_MARKS.planned}</svg>`;
  return withLabel
    ? `<span class="plan-status plan-status-${item.status}${item.inferred ? " is-inferred" : ""}" data-tip="${escapeHtml(tip)}">${mark}${escapeHtml(item.error ? "Invalid map" : item.status)}</span>`
    : `<span class="plan-status" data-tip="${escapeHtml(tip)}" role="img" aria-label="${escapeHtml(tip)}">${mark}</span>`;
}

const CHANGE_WORDS = { edits: "edits", retires: "removes", proposes: "proposes" };
function prMark(item, pr) {
  const slug = repoInfo(item.repo)?.slug || "";
  const tip = `#${pr.number} ${CHANGE_WORDS[pr.change]} this initiative${pr.draft ? " · draft" : ""} · ${pr.title}`;
  return `<button type="button" class="code-pr-chip code-pr-${pr.draft ? "draft" : "open"} plan-pr plan-pr-${pr.change}" data-plan-pr="${pr.number}" data-slug="${escapeHtml(slug)}" data-tip="${escapeHtml(tip)}">#${pr.number}</button>`;
}

function phaseText(item) {
  return item.phase ? `<span class="plan-phase">${escapeHtml(item.phase)}</span>` : "";
}

function planRow(item) {
  const key = `plan:${item.id}`;
  const proposed = proposal(item);
  return `<tr class="code-row plan-row" data-code-row="${escapeHtml(key)}" aria-selected="${code.selected() === key}">
    ${code.repoCell(item.repo)}<td class="plan-col-status">${statusMark(item)}</td>
    <td class="code-col-main plan-col-title"><div class="plan-title">${escapeHtml(item.title)}${proposed ? `<span class="code-tag code-tag-open">proposed</span>` : ""}</div>${item.summary ? `<div class="plan-summary">${escapeHtml(item.summary)}</div>` : item.error ? `<div class="plan-summary plan-error">${escapeHtml(item.error)}</div>` : ""}</td>
    <td class="plan-col-phase">${phaseText(item)}</td>
    <td class="plan-col-next">${escapeHtml(item.nextAction)}</td>
    <td class="plan-col-prs">${item.prs.map((pr) => prMark(item, pr)).join("")}</td>
    <td class="code-col-when ${item.edited ? `code-heat-${heat(item.edited)}` : ""}">${item.edited ? when(item.edited) : ""}</td></tr>`;
}

export function plansControls(segment, count) {
  if (!ps.data) return "";
  const counts = (status) => all().filter((item) => status === "all" || (status === "open" ? isOpen(item) : item.status === status)).length;
  const scopes = Object.fromEntries(Object.entries(SCOPES).map(([id, label]) => [id, `${label}${count(counts(id))}`]));
  return segment("data-plan-scope", ps.scope, scopes)
    + `<label class="code-check"><input type="checkbox" data-plan-with-pr ${ps.withPr ? "checked" : ""}> In open PRs${count(all().filter((item) => item.prs.length).length)}</label>`
    + segment("data-plan-sort", ps.sort, SORTS);
}

function emptyPlans() {
  if (!all().length) return `<div class="code-empty"><p>No initiative maps on main in the tracked repositories.</p><p class="code-muted">Any <code>initiative-map.json</code> on a repo's origin/main shows up here, with the Markdown files beside it.</p></div>`;
  const narrowed = ps.scope !== "all" || ps.withPr || code.filtered();
  return `<div class="code-empty"><p>No initiatives match${code.filterText() ? ` <b>“${escapeHtml(code.filterText())}”</b>` : ""}${ps.scope === "all" ? "" : ` in ${SCOPES[ps.scope]}`}.</p>${narrowed ? `<button type="button" class="code-bar-button" data-plan-reset data-code-reset>Show all initiatives <kbd>Esc</kbd></button>` : ""}</div>`;
}

export function plansBody() {
  if (!ps.data && ps.error) return `<div class="code-empty"><p>Could not load initiatives: ${escapeHtml(ps.error)}</p><p class="code-muted">${/not found|ENOENT|404/i.test(ps.error) ? "This server predates the Plans tab; restart the viewer. " : ""}<kbd>R</kbd> tries again.</p></div>`;
  if (!ps.data) return `<p class="code-empty">Loading initiatives from each repository's main…</p>`;
  const items = visible();
  if (!items.length) return emptyPlans();
  const columns = [...code.repoHead(), ["plan-col-status", ""], ["code-col-main plan-col-title", "Initiative"], ["plan-col-phase", "Phase"], ["plan-col-next", "Next action"], ["plan-col-prs", "PRs"], ["code-col-when", "Edited"]];
  const span = columns.length;
  let sections;
  if (ps.sort === "edited") {
    const groups = [["Last 24 hours", DAY], ["This week", 7 * DAY], ["This month", 30 * DAY], ["Older", Infinity]];
    let start = 0;
    sections = groups.map(([label, age]) => {
      let end = start;
      while (end < items.length && Date.now() - items[end].edited < age) end++;
      const rows = items.slice(start, end);
      start = end;
      return rows.length ? `<tbody><tr class="code-group-row"><th colspan="${span}">${label} <span>${rows.length}</span></th></tr>${rows.map(planRow).join("")}</tbody>` : "";
    }).join("");
  } else sections = `<tbody>${items.map(planRow).join("")}</tbody>`;
  return `<table class="code-table plan-table">${code.tableHead(columns)}${sections}</table>`;
}

// ---------- inspector ----------

const shortSha = (sha) => sha.slice(0, 7);
function whereText(item) {
  const proposed = proposal(item);
  const info = repoInfo(item.repo);
  return proposed ? `PR #${proposed.number} · ${proposed.branch}` : `${info?.base || "origin/main"} @ ${shortSha(item.ref)}`;
}

function linkList(items, empty = "") {
  if (!items.length) return empty;
  return `<span class="plan-links">${items.map(({ slug, item }) => item
    ? `<button type="button" class="plan-link" data-plan-goto="${escapeHtml(item.id)}" data-tip="${escapeHtml(`${item.status} · ${item.summary || item.title}`)}">${statusMark(item)}<span>${escapeHtml(item.title)}</span></button>`
    : `<code class="plan-link-missing" data-tip="No initiative with this slug on main">${escapeHtml(slug)}</code>`).join("")}</span>`;
}

function planFacts(item) {
  const fetched = repoInfo(item.repo)?.fetchedAt;
  const folder = `${item.repo}/${item.folder}`;
  const finished = FINISHED.has(item.status) && !item.error;
  const agent = `<span class="code-side-skills">${iconButton("draft", `Draft an update in ${appName()} (U)`, `data-plan-agent="update" data-id="${escapeHtml(item.id)}"`)}${finished ? iconButton("trash", `Draft retirement in ${appName()} (Shift+U)`, `data-plan-agent="retire" data-id="${escapeHtml(item.id)}"`) : ""}${iconButton("copy", "Copy the update prompt", `data-plan-copy-prompt="update" data-id="${escapeHtml(item.id)}"`)}</span>`;
  return sideFacts([
    ["Status", `${statusMark(item, true)}${item.inferred ? `<span class="code-muted">${escapeHtml(item.evidence)}</span>` : ""}`],
    ["Phase", [item.phase && `<span>${escapeHtml(item.phase)}</span>`, item.scale && `<span class="code-muted">${escapeHtml(item.scale)}</span>`].filter(Boolean).join("")],
    ["Next", item.nextAction ? `<span class="plan-next">${escapeHtml(item.nextAction)}</span>` : ""],
    ["Where", `<span>${escapeHtml(repoName(item.repo))}</span><span class="code-muted" data-tip="${fetched ? `Last fetched ${escapeHtml(new Date(fetched).toLocaleString())}` : "Never fetched"}">${escapeHtml(whereText(item))}</span>`],
    ["Folder", `<button type="button" class="code-path code-side-path" data-code-copy="${escapeHtml(folder)}" data-tip="${escapeHtml(folder)} · click to copy">${escapeHtml(item.folder || ".")}</button>`],
    ["Edited", [item.edited && `<span class="code-muted" data-tip="${escapeHtml(new Date(item.edited).toLocaleString())}">${proposal(item) ? "PR updated" : "committed"} ${ago(item.edited)} ago</span>`, item.lastUpdated && `<span class="code-muted">map says ${escapeHtml(item.lastUpdated)}</span>`].filter(Boolean).join("")],
    ["Depends on", linkList(item.dependsOn.map((slug) => ({ slug, item: bySlug(item.repo, slug) })))],
    ["Needed by", linkList(neededBy(item).map((other) => ({ slug: other.slug, item: other })))],
    ["Related", linkList(item.related.filter((slug) => !item.dependsOn.includes(slug)).map((slug) => ({ slug, item: bySlug(item.repo, slug) })))],
    [appName(), agent],
  ]);
}

function prSection(item) {
  if (!item.prs.length) return "";
  return `<section><h4>Open pull requests <span>${item.prs.length}</span></h4><ul class="plan-pr-list">${item.prs.map((pr) => `<li>${prMark(item, pr)}<span class="plan-pr-title">${escapeHtml(pr.title)}</span><span class="code-muted">${CHANGE_WORDS[pr.change]} ${pr.files.length} ${pr.files.length === 1 ? "file" : "files"}${pr.draft ? " · draft" : ""} · ${ago(pr.updatedAt)}</span></li>`).join("")}</ul></section>`;
}

function docsSection(item) {
  return `<section><h4>Documents <span>${item.docs.length}</span></h4>${item.docs.length ? `<ul class="plan-docs">${item.docs.map((doc) => `<li><button type="button" class="plan-doc-link" data-plan-open="${escapeHtml(item.id)}" data-doc="${escapeHtml(doc.path)}"><b>${escapeHtml(doc.label)}</b><span class="code-muted">${escapeHtml(doc.name)}</span></button></li>`).join("")}<li><button type="button" class="plan-doc-link" data-plan-open="${escapeHtml(item.id)}" data-doc="map"><b>Map</b><span class="code-muted">initiative-map.json</span></button></li></ul>` : `<p class="code-muted">Only the map.</p>`}</section>`;
}

function historySection(item, full = null) {
  const entries = full || item.history;
  if (!entries.length) return "";
  return `<section><h4>Activity <span>${full ? entries.length : `${entries.length} of ${item.historyCount}`}</span></h4><ol class="plan-history">${entries.map((entry) => `<li><time>${escapeHtml(entry.date || "")}</time><b>${escapeHtml(/\s/.test(entry.event || "") ? entry.event : String(entry.event || "").replace(/[-_]/g, " "))}</b>${entry.reason ? `<span>${escapeHtml(entry.reason)}</span>` : ""}</li>`).join("")}</ol></section>`;
}

export function planDetail(item) {
  return `<header class="code-detail-head">${statusMark(item)}<h3>${escapeHtml(item.title)}</h3><span class="code-side-tools">${iconButton("expand", "Open the reader (Enter)", `data-plan-open="${escapeHtml(item.id)}"`)}</span></header>
    ${item.summary ? `<p class="plan-detail-summary">${escapeHtml(item.summary)}</p>` : ""}
    ${item.error ? `<p class="work-warning">${escapeHtml(item.error)}</p>` : ""}
    ${planFacts(item)}${prSection(item)}${docsSection(item)}${historySection(item)}`;
}

export const planEmptyHint = () => `<kbd>J</kbd><kbd>K</kbd> move · <kbd>Enter</kbd> read · <kbd>U</kbd> draft an update · <kbd>Y</kbd> copy folder · <kbd>F</kbd> filter · <kbd>G</kbd> repos · <kbd>R</kbd> rescan`;

// ---------- agent drafts ----------

async function draft(kind, id, doc = "") {
  const response = await fetch("/api/code/plan-agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: agentApp(), id, kind, doc }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not open the draft.");
  notify(`Drafted ${kind === "retire" ? "a retirement" : "an update"} in ${appName()}. Add your notes under the --- line, then send.`);
}

async function copyPrompt(button, kind, id, doc = "") {
  const response = await fetch("/api/code/plan-prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: agentApp(), id, kind, doc }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not build the prompt.");
  await navigator.clipboard.writeText(body.draft);
  copied(button);
}

const openDoc = () => (dialog?.open && reader.doc !== "map" ? reader.doc : "");

// Handles plan-only clicks from the Code page and the reader; returns true when it did.
export function planClick(dataset, target) {
  if (dataset.planScope) { ps.scope = dataset.planScope; syncScope(); code.render({ animate: true }); return true; }
  if (dataset.planSort) { ps.sort = dataset.planSort; code.render({ animate: true }); return true; }
  if ("planWithPr" in dataset) { ps.withPr = target.checked; code.render({ animate: true }); return true; }
  if ("planReset" in dataset) { resetPlans(); code.render({ animate: true }); return true; }
  if (dataset.planOpen) { openPlan(dataset.planOpen, dataset.doc || ""); return true; }
  if (dataset.planGoto) {
    if (dialog?.open) openPlan(dataset.planGoto);
    else { if (!code.host()?.querySelector(`[data-code-row="${CSS.escape(`plan:${dataset.planGoto}`)}"]`)) { resetPlans(); code.render(); } code.select(`plan:${dataset.planGoto}`, true); }
    return true;
  }
  if (dataset.planPr) { openPrOverlay(dataset.slug, Number(dataset.planPr)); return true; }
  if (dataset.planAgent) { draft(dataset.planAgent, dataset.id, openDoc()).catch((error) => notify(error.message, true)); return true; }
  if (dataset.planCopyPrompt) { copyPrompt(target, dataset.planCopyPrompt, dataset.id, openDoc()).catch((error) => notify(error.message, true)); return true; }
  return false;
}

// Page keys for a selected initiative: Enter reads, U drafts an update (Shift+U retires), Y copies the folder.
export function planKey(key, item, event) {
  if (key === "enter") return openPlan(item.id), true;
  if (key === "u") { draft(event.shiftKey && FINISHED.has(item.status) ? "retire" : "update", item.id).catch((error) => notify(error.message, true)); return true; }
  if (key === "y") { const folder = `${item.repo}/${item.folder}`; navigator.clipboard.writeText(folder).then(() => notify(`Copied ${folder}`)); return true; }
  return false;
}

function resetPlans() {
  ps.scope = "all";
  ps.withPr = false;
  code.resetFilters();
  syncScope();
}

function syncScope() {
  const url = new URL(location.href);
  if (ps.scope === "open") url.searchParams.delete("plans"); else url.searchParams.set("plans", ps.scope);
  if (url.href !== location.href) history.replaceState(history.state, "", url);
}
export const planScopeParam = () => (ps.scope === "open" ? {} : { plans: ps.scope });

// ---------- reader overview ----------

let dialog = null;
const reader = { id: "", doc: "", list: [], back: [] };

async function fetchDoc(item, path) {
  const key = `${item.repo}\n${item.ref}\n${path}`;
  if (!ps.docs.has(key)) {
    ps.docs.set(key, fetch(`/api/code/plan-doc?${new URLSearchParams({ repo: item.repo, ref: item.ref, path })}`).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Could not read ${path}.`);
      return body.body;
    }).catch((error) => { ps.docs.delete(key); throw error; }));
  }
  return ps.docs.get(key);
}

async function fetchMap(item) {
  if (!ps.maps.has(item.id)) {
    ps.maps.set(item.id, fetch(`/api/code/plan-map?id=${encodeURIComponent(item.id)}`).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not read the map.");
      return body.map;
    }).catch((error) => { ps.maps.delete(item.id); throw error; }));
  }
  return ps.maps.get(item.id);
}

// Relative links between Markdown files become reader links; the rest render as usual.
const READER_LINK = "https://plan-reader.invalid/";
function readerMarkdown(source, path) {
  const { facts, body } = frontMatter(source);
  // The renderer leaves "# " lines alone (documents get their title from the page), so the first becomes the
  // reader's title and any later one a section.
  let title = "";
  let fenced = false;
  const lines = body.split(/\r?\n/).filter((line) => {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced || !/^#\s+/.test(line) || title) return true;
    title = line.replace(/^#\s+/, "").replace(/\s+#*$/, "");
    return false;
  }).map((line) => (/^#\s+/.test(line) ? `#${line}` : line));
  const head = `${title ? `<h2 class="plan-doc-title">${escapeHtml(title)}</h2>` : ""}${facts.length ? `<dl class="plan-map-facts plan-front-matter">${facts.map(([key, value]) => `<dt>${escapeHtml(label(key))}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>` : ""}`;
  return head + linkedMarkdown(lines.join("\n"), path);
}

// A leading YAML block of simple `key: value` lines, shown as facts above the document instead of as text.
function frontMatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return { facts: [], body: source };
  const facts = match[1].split(/\r?\n/).map((line) => line.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean)
    .map(([, key, value]) => [key, value.replace(/^(["'])(.*)\1$/, "$2")]).filter(([key, value]) => value && !["title", "slug"].includes(key));
  return { facts, body: source.slice(match[0].length) };
}

function linkedMarkdown(body, path) {
  const rewritten = body.replace(/\]\(\s*<?([^)\s>]+)>?(\s+"[^"]*")?\s*\)/g, (match, href) => {
    if (/^[a-z][\w+.-]*:|^#|^\//i.test(href)) return match;
    const [file, anchor = ""] = href.split("#");
    if (!/\.(md|json)$/i.test(file)) return match;
    try {
      const resolved = decodeURIComponent(new URL(file, `https://x.invalid/${path}`).pathname.slice(1));
      return `](${READER_LINK}${encodeURI(resolved)}${anchor ? `#${anchor}` : ""})`;
    } catch { return match; }
  });
  return renderMarkdown(rewritten, "");
}

// The map, laid out for reading: known sections get a shape, anything else still shows as nested facts.
const label = (key) => key.replace(/[_-]+/g, " ").replace(/^./, (char) => char.toUpperCase());
function valueHtml(value, depth = 0) {
  if (value === null || value === undefined || value === "") return `<span class="code-muted">—</span>`;
  if (typeof value !== "object") return `<span>${escapeHtml(String(value))}</span>`;
  if (Array.isArray(value)) {
    if (!value.length) return `<span class="code-muted">none</span>`;
    if (value.every((entry) => typeof entry !== "object" || entry === null)) return `<ul class="plan-map-list">${value.map((entry) => `<li>${escapeHtml(String(entry))}</li>`).join("")}</ul>`;
    return `<ol class="plan-map-items">${value.map((entry) => `<li>${itemHtml(entry, depth + 1)}</li>`).join("")}</ol>`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return `<span class="code-muted">none</span>`;
  return `<dl class="plan-map-facts">${entries.map(([key, entry]) => `<dt>${escapeHtml(label(key))}</dt><dd>${valueHtml(entry, depth + 1)}</dd>`).join("")}</dl>`;
}

// A section's plain fields as one facts grid, then each list or nested object as its own full-width subsection.
function sectionHtml(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return valueHtml(value);
  const entries = Object.entries(value);
  const plain = entries.filter(([, entry]) => entry === null || typeof entry !== "object");
  const nested = entries.filter(([, entry]) => entry !== null && typeof entry === "object");
  return `${plain.length ? valueHtml(Object.fromEntries(plain)) : ""}${nested.map(([key, entry]) => `<h5>${escapeHtml(label(key))}${Array.isArray(entry) ? ` <span>${entry.length}</span>` : ""}</h5>${valueHtml(entry, 1)}`).join("")}`;
}

// A list entry reads as one line (id, headline, status) followed by its other fields.
const HEADLINES = ["title", "name", "statement", "summary", "question", "decision", "claim", "description"];
function itemHtml(entry, depth) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return valueHtml(entry, depth);
  const headline = HEADLINES.find((key) => typeof entry[key] === "string" && entry[key]);
  const { id, status } = entry;
  const rest = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== headline && !(["id", "status"].includes(key) && typeof entry[key] !== "object")));
  const head = [id !== undefined && typeof id !== "object" && `<code>${escapeHtml(String(id))}</code>`, headline && `<b>${escapeHtml(entry[headline])}</b>`, status !== undefined && typeof status !== "object" && `<span class="code-muted">${escapeHtml(String(status))}</span>`].filter(Boolean).join("");
  return `${head ? `<div class="plan-map-item-head">${head}</div>` : ""}${Object.keys(rest).length ? valueHtml(rest, depth) : ""}`;
}

const MILESTONE_DONE =new Set(["done", "complete", "completed", "closed"]);
function milestonesHtml(milestones) {
  return `<ol class="plan-milestones">${milestones.map((milestone) => {
    const state = String(milestone?.status || "").toLowerCase();
    const { id, title, name, status, ...rest } = milestone || {};
    const mark = MILESTONE_DONE.has(state) ? "completed" : /progress|start|partial|active/.test(state) ? "active" : "planned";
    return `<li><header>${statusMark({ status: mark, inferred: false, evidence: "" })}${id ? `<code>${escapeHtml(String(id))}</code>` : ""}<b>${escapeHtml(String(title || name || ""))}</b><span class="code-muted">${escapeHtml(String(status || ""))}</span></header>${Object.keys(rest).length ? valueHtml(rest, 2) : ""}</li>`;
  }).join("")}</ol>`;
}

function mapHtml(item, map) {
  const sections = [];
  const order = ["intent", "brainstorm", "shape", "implementation", "closure", "sources", "artifacts"];
  const keys = [...order.filter((key) => key in map), ...Object.keys(map).filter((key) => !order.includes(key) && !["initiative", "history", "schema_version", "related_initiatives"].includes(key))];
  for (const key of keys) {
    const value = map[key];
    if (value === null || value === undefined) continue;
    if (key === "implementation" && value && Array.isArray(value.milestones)) {
      const { milestones, ...rest } = value;
      sections.push(`<section><h4>Implementation</h4>${Object.keys(rest).length ? sectionHtml(rest) : ""}${milestones.length ? `<h5>Milestones <span>${milestones.length}</span></h5>${milestonesHtml(milestones)}` : ""}</section>`);
    } else sections.push(`<section><h4>${escapeHtml(label(key))}</h4>${sectionHtml(value)}</section>`);
  }
  const history = Array.isArray(map.history) ? [...map.history].reverse().map((entry) => {
    const event = entry?.event || entry?.action || entry?.change || "";
    return { date: entry?.date, event, reason: entry?.reason || [entry?.summary, entry?.notes].find((value) => value && value !== event) || "" };
  }) : [];
  return `<div class="plan-map">${sections.join("")}${historySection(item, history)}<section><h4>Initiative</h4>${valueHtml(map.initiative)}</section></div>`;
}

function ensureDialog() {
  if (dialog) return;
  dialog = Object.assign(document.body.appendChild(document.createElement("dialog")), { className: "code-diff issue-overview plan-overview", tabIndex: -1 });
  dialog.innerHTML = `<header class="code-diff-head" data-o="head"></header><div class="issue-overview-split plan-reader-split"><aside class="code-diff-pr" data-o="side"></aside><div class="plan-reader"><nav class="plan-reader-tabs" data-o="tabs"></nav><div class="plan-reader-body"><article class="plan-reader-text markdown" data-o="main"></article><nav class="plan-outline" data-o="outline" aria-label="Outline"></nav></div></div></div>`;
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    document.dispatchEvent(new CustomEvent("overview-closed", { detail: location.href }));
    syncReaderUrl();
    reader.id = "";
  });
  let pressedBackdrop = false;
  dialog.addEventListener("pointerdown", (event) => { pressedBackdrop = event.target === dialog; });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) { if (pressedBackdrop) dialog.close(); return; }
    const link = event.target.closest("a[href]");
    if (link?.href.startsWith(READER_LINK)) { event.preventDefault(); return followLink(link.href); }
    const outline = event.target.closest("[data-outline]");
    if (outline) { dialog.querySelector(`[data-o="main"] [id="${CSS.escape(outline.dataset.outline)}"]`)?.scrollIntoView({ block: "start", behavior: "instant" }); return; }
    const target = event.target.closest("button, input[type=checkbox]");
    if (!target) return;
    if ("planClose" in target.dataset) return dialog.close();
    if ("planBack" in target.dataset) return goBack();
    if (target.dataset.readerDoc !== undefined) return showDoc(target.dataset.readerDoc);
    if (target.dataset.codeCopy !== undefined) return navigator.clipboard.writeText(target.dataset.codeCopy).then(() => copied(target));
    planClick(target.dataset, target);
  });
  dialog.addEventListener("pointerover", (event) => { const target = event.target.closest("[data-tip]"); if (target) showTip(target); else hideTip(); });
  dialog.addEventListener("pointerleave", hideTip);
  dialog.addEventListener("keydown", (event) => {
    if (isSummonKey(event)) return;
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.altKey || event.target.closest?.("input, textarea")) return;
    const key = event.key.toLowerCase();
    const item = byId(reader.id);
    const step = { j: 1, k: -1 }[key];
    const tabs = ["map", ...(item?.docs || []).map((doc) => doc.path)];
    if (step) stepOverview(step);
    else if ((key === "[" || key === "]") && item) showDoc(tabs[(tabs.indexOf(reader.doc) + (key === "]" ? 1 : -1) + tabs.length) % tabs.length]);
    else if (key === "m" && item) showDoc("map");
    else if (key === "b" && reader.back.length) goBack();
    else if (key === "u" && item) draft(event.shiftKey && FINISHED.has(item.status) ? "retire" : "update", item.id, openDoc()).catch((error) => notify(error.message, true));
    else if (key === "y" && item) { const folder = `${item.repo}/${item.folder}`; navigator.clipboard.writeText(folder).then(() => notify(`Copied ${folder}`)); }
    else return;
    event.preventDefault();
  });
}

function stepOverview(step) {
  const index = reader.list.indexOf(reader.id);
  const next = reader.list[index + step];
  if (index >= 0 && next) openPlan(next);
}

function followLink(href) {
  const url = new URL(href);
  const path = decodeURIComponent(url.pathname.slice(1));
  const item = byId(reader.id);
  if (!item) return;
  // A link into another initiative's folder opens that initiative; a map link opens the Map tab.
  const owner = all().filter((other) => other.repo === item.repo && other.ref === item.ref && (!other.folder || path.startsWith(`${other.folder}/`))).sort((a, b) => b.folder.length - a.folder.length)[0];
  reader.back.push({ id: reader.id, doc: reader.doc });
  if (owner && owner.id !== item.id) return openPlan(owner.id, path.endsWith(".json") ? "map" : path, { keepBack: true, anchor: url.hash.slice(1) });
  showDoc(path.endsWith("initiative-map.json") ? "map" : path, { keepBack: true, anchor: url.hash.slice(1) });
}

function goBack() {
  const last = reader.back.pop();
  if (!last) return;
  if (last.id !== reader.id) openPlan(last.id, last.doc, { keepBack: true });
  else showDoc(last.doc, { keepBack: true });
}

function renderOverview() {
  const item = byId(reader.id);
  if (!item || !dialog) return;
  const position = reader.list.indexOf(item.id);
  const walk = position >= 0 && reader.list.length > 1 ? `<span class="code-muted">${position + 1} of ${reader.list.length} · <kbd>J</kbd><kbd>K</kbd> walk · <kbd>[</kbd><kbd>]</kbd> documents</span>` : `<span class="code-muted"><kbd>[</kbd><kbd>]</kbd> documents</span>`;
  dialog.querySelector('[data-o="head"]').innerHTML = `${statusMark(item)}<div class="issue-overview-title"><h3>${escapeHtml(item.title)}</h3><p class="code-muted">${escapeHtml(repoName(item.repo))} · ${escapeHtml(item.folder || ".")} · ${escapeHtml(whereText(item))}</p></div><span class="code-spacer"></span>${walk}${iconButton("fail", "Close (Esc)", "data-plan-close")}`;
  dialog.querySelector('[data-o="side"]').innerHTML = `${item.summary ? `<p class="plan-detail-summary">${escapeHtml(item.summary)}</p>` : ""}${planFacts(item)}${prSection(item)}${historySection(item)}`;
  renderTabs(item);
}

function renderTabs(item) {
  const known = item.docs.some((doc) => doc.path === reader.doc) || reader.doc === "map";
  const tabs = [...item.docs.map((doc) => [doc.path, doc.label, doc.name]), ...(known ? [] : [[reader.doc, reader.doc.split("/").pop(), reader.doc]]), ["map", "Map", "initiative-map.json"]];
  dialog.querySelector('[data-o="tabs"]').innerHTML = `${reader.back.length ? `<button type="button" class="plan-reader-back" data-plan-back data-tip="Back (B)">← Back</button>` : ""}${tabs.map(([path, name, tip]) => `<button type="button" data-reader-doc="${escapeHtml(path)}" aria-pressed="${reader.doc === path}" data-tip="${escapeHtml(tip)}">${escapeHtml(name)}</button>`).join("")}`;
}

async function showDoc(path, { keepBack = false, anchor = "" } = {}) {
  const item = byId(reader.id);
  if (!item) return;
  if (!keepBack && path !== reader.doc) reader.back = [];
  reader.doc = path || item.docs[0]?.path || "map";
  syncReaderUrl();
  renderTabs(item);
  const main = dialog.querySelector('[data-o="main"]');
  const outline = dialog.querySelector('[data-o="outline"]');
  const doc = reader.doc;
  main.setAttribute("aria-busy", "true");
  let html;
  let headings = [];
  try {
    if (doc === "map") html = mapHtml(item, await fetchMap(item));
    else {
      const body = await fetchDoc(item, doc);
      html = readerMarkdown(body, doc);
      headings = flatten(markdownOutline(body));
    }
  } catch (error) {
    html = `<p class="work-warning">${escapeHtml(error.message)}</p>`;
  }
  if (reader.id !== item.id || reader.doc !== doc) return; // a newer pick won
  main.removeAttribute("aria-busy");
  main.innerHTML = html;
  // Links between the repo's own files stay in the reader, so they drop the new-tab marker external links get.
  for (const link of main.querySelectorAll(`a[href^="${READER_LINK}"]`)) {
    link.className = "plan-reader-link";
    link.removeAttribute("target");
    link.querySelectorAll(".external-mark, .sr-only").forEach((mark) => mark.remove());
  }
  outline.innerHTML = headings.length > 2 ? `<h4>On this page</h4>${headings.map((heading) => `<button type="button" class="plan-outline-${heading.level}" data-outline="${escapeHtml(heading.anchor)}">${escapeHtml(heading.title)}</button>`).join("")}` : "";
  const scroller = dialog.querySelector(".plan-reader-body");
  const target = anchor && main.querySelector(`[id="${CSS.escape(anchor)}"]`);
  if (target) target.scrollIntoView({ block: "start", behavior: "instant" }); else scroller.scrollTop = 0;
  fadeIn(main, 140);
}

const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children)]);

function syncReaderUrl() {
  const url = new URL(location.href);
  if (dialog?.open && reader.id) { url.searchParams.set("plan", reader.id); url.searchParams.set("doc", reader.doc); }
  else { url.searchParams.delete("plan"); url.searchParams.delete("doc"); }
  if (url.href !== location.href) history.replaceState(history.state, "", url);
}

export const planTitle = (id) => byId(id)?.title || "";
export const cachedPlans = () => ps.data;

// Opens the reader from anywhere: the Plans tab, ⌘K, a ?plan= URL, or Recently viewed.
export async function openPlan(id, doc = "", { keepBack = false, anchor = "" } = {}) {
  if (!ps.data) await loadPlans();
  const item = byId(id);
  if (!item) return notify("That initiative isn't on main or in an open PR any more.", true);
  ensureDialog();
  if (!keepBack) reader.back = [];
  reader.id = id;
  const listed = code?.host()?.isConnected ? [...code.host().querySelectorAll(".plan-table [data-code-row]")].map((row) => row.dataset.codeRow.slice(5)) : [];
  reader.list = listed.includes(id) ? listed : reader.list.includes(id) ? reader.list : [id];
  if (!dialog.open) { dialog.showModal(); dialog.focus({ preventScroll: true }); }
  renderOverview();
  await showDoc(doc || item.docs[0]?.path || "map", { keepBack: true, anchor });
  if (code?.host()?.isConnected && code.selected() !== `plan:${id}` && code.host().querySelector(`[data-code-row="${CSS.escape(`plan:${id}`)}"]`)) code.select(`plan:${id}`, true);
}

// ⌘K: initiatives whose title, slug or summary hold every word.
export function searchPlans(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return all().filter((item) => terms.every((term) => `${item.title} ${item.slug} ${item.summary} ${repoName(item.repo)}`.toLowerCase().includes(term)))
    .sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.edited - a.edited).slice(0, 6);
}
export { statusMark as planStatusMark };
