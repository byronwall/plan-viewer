import { escapeHtml, renderMarkdown, SERVICE_ICONS } from "./markdown.js";
import { agentApp, agentName as appName, config, escapeRegExp } from "./config.js";
import { decorate, lineClasses, markWords } from "./word-diff.js";
import { mapHtml, mapSvg, moveGroups, svgToPng, tileCard } from "./diff-map.js";

// Code dashboard: tracked repos' worktrees (most recent first), their open PRs, and worktree cleanup.
export const TABS = { prs: "Pull requests", worktrees: "Worktrees", commits: "Commits", cleanup: "Cleanup" };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ui = {
  tab: "prs", data: null, filter: "", day: "", treeScope: "all", prScope: "all", prSort: "updated", hideDrafts: false, failingOnly: false,
  showKeep: false, openDescriptions: new Set(), selected: new Set(), removed: new Set(), removing: null, poll: 0, sel: "", detail: new Map(),
  commitScope: "local", commits: new Map(), detailErrors: new Map(), branches: new Set(), prefixes: new Set(), branchQuery: "", branchActive: 0,
  authors: new Set(), authorQuery: "", authorActive: 0, runLogs: new Map(),
};
const storage = { get: (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }, set: (key, value) => { try { localStorage.setItem(key, value); } catch {} } };
// Cleanup never offers a worktree created or touched more recently than this; a fresh one may be about to get used.
const GUARDS = { off: 0, day: DAY, week: 7 * DAY };
let cleanupGuard = storage.get("code-cleanup-guard", "day");
const level = (tree) => {
  const base = tree.cleanup?.level;
  return (base === "safe" || base === "review") && Date.now() - tree.activity < GUARDS[cleanupGuard] ? "fresh" : base;
};
const noop = () => {};
let notify = noop;
let host = null;

export const codeTab = (value) => (value in TABS ? value : "prs");

const ICONS = {
  vscode: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6"/>',
  terminal: '<path d="m4 17 6-5-6-5M12 19h8"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  session: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  shakedown: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  "adversarial-pr-review": '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 11.5v1"/>',
  discuss: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  "ruthless-simplify": '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 20M8.1 15.9 20 4"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  comment: '<path d="M4 5h16v11H9l-5 4z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>',
  conflict: '<path d="M12 3 2 20h20zM12 10v4M12 17v.5"/>',
  review: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  pass: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  approved: '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16.2 9.5"/>',
  fail: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  pending: '<circle cx="12" cy="12" r="7.5"/><path d="M12 8v4.5l3 1.8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  local: '<rect x="3" y="4.5" width="18" height="11.5" rx="1.5"/><path d="M1.5 19.5h21"/>',
  draft: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  preview: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z"/>',
  diff: '<path d="M8 3v8M4 7h8M5 17h6M14 4h6v16h-6M18 9v6"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8"/>',
};
const icon = (name) => `<svg class="code-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.review}</svg>`;
const iconButton = (name, tip, attrs) => `<button type="button" class="code-icon-button" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}" ${attrs}>${icon(name)}</button>`;
const copyButton = (value, tip) => iconButton("copy", tip, `data-code-copy="${escapeHtml(value)}"`);
// One-line, width-capped branch name; click copies the full name.
// Runs the configured `code.prPreview` command for the PR; blank slot keeps columns aligned elsewhere.
const previewButton = (pr) => meta().previews?.includes(pr.repo) ? iconButton("preview", "Open signed-in PR deployment (D)", `data-code-preview="${pr.number}" data-repo="${escapeHtml(pr.repo)}"`) : `<span class="code-icon-button is-blank"></span>`;
// Starts `code.run` for a worktree, or for a PR (checked out first when it has no worktree); stops it while it runs.
const runFor = (path) => (path && ui.data?.runs?.[path]) || null;
function runButton(repo, tree, branch) {
  if (!ui.data?.runnable?.includes(repo) || (!tree && !config().code.run?.worktree)) return `<span class="code-icon-button is-blank"></span>`;
  const run = runFor(tree?.path);
  if (run && run.state !== "exited") return iconButton("stop", run.url ? `Stop local server at ${run.url} (L)` : "Stop local server · starting (L)", `data-code-stop-run="${escapeHtml(tree.path)}" data-run-state="${run.state}"`);
  return iconButton("play", tree ? "Run local server (L)" : "Check out a worktree and run local server (L)", `data-code-run data-path="${escapeHtml(tree?.path || "")}" data-repo="${escapeHtml(repo)}" data-branch="${escapeHtml(branch)}"`);
}
const branchChip = (branch, className = "code-sub-branch") => `<button type="button" class="${className}" data-code-copy="${escapeHtml(branch)}" data-tip="${escapeHtml(branch)} · click to copy">${className === "code-sub-branch" ? icon("branch") : ""}<span>${escapeHtml(branch)}</span></button>`;

export function ago(time) {
  const minutes = Math.round((Date.now() - new Date(time).getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  if (minutes < 60 * 24 * 60) return `${Math.round(minutes / 1440)}d`;
  return `${Math.round(minutes / 43200)}mo`;
}
const bytes = (size) => size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB` : size < 1073741824 ? `${(size / 1048576).toFixed(1)} MB` : `${(size / 1073741824).toFixed(1)} GB`;
const when = (time) => `<time datetime="${new Date(time).toISOString()}" title="${escapeHtml(new Date(time).toLocaleString())}">${ago(time)}</time>`;
const heat = (time) => { const age = Date.now() - new Date(time).getTime(); return age < 2 * HOUR ? "hot" : age < DAY ? "warm" : age < 7 * DAY ? "week" : "cold"; };
const dayKey = (time) => { const d = new Date(time); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const shortPath = (path) => path.replace(/^\/Users\/[^/]+\/repos\//, "").replace(/^\/Users\/[^/]+/, "~");
const repoName = (path) => path.split("/").pop();
const worktreeFor = (pr) => ui.data.worktrees.find((tree) => tree.repo === pr.repo && tree.branch === pr.branch && !ui.removed.has(tree.path));
const prFor = (tree) => ui.data.prs.find((pr) => pr.repo === tree.repo && pr.branch === tree.branch);
const matches = (text) => !ui.filter || ui.filter.toLowerCase().split(/\s+/).every((word) => text.toLowerCase().includes(word));
// The overview can open without the Code page, so the slug may come from the worktree detail instead.
const githubUrl = (tree) => { const slug = ui.data?.slugs?.[tree.repo] || ui.detail.get(`tree:${tree.path}`)?.slug; return slug && tree.branch !== "(detached)" ? `https://github.com/${slug}/tree/${tree.branch}` : ""; };

async function post(action, body) {
  const response = await fetch(`/api/code/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

// ---------- shared pieces ----------

// Always renders a fixed-width slot so CI arriving from the background scan never shifts the PR number.
function ciBadge(pr) {
  const map = { SUCCESS: ["pass", "Checks passing"], FAILURE: ["fail", "Checks failing"], ERROR: ["fail", "Checks errored"], PENDING: ["pending", "Checks running"], EXPECTED: ["pending", "Checks expected"] };
  const [kind, tip] = map[pr?.ci] || ["", ""];
  return kind ? `<span class="code-ci code-ci-${kind}" role="img" aria-label="${tip}">${icon(kind)}</span>` : `<span class="code-ci" aria-hidden="true"></span>`;
}

function prChip(pr) {
  return `<a class="code-pr-chip code-pr-${pr.draft ? "draft" : "open"}" href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">${ciBadge(pr)}#${pr.number}</a>`;
}

function historyChip(tree) {
  if (!tree.prNumber || tree.prState === "OPEN") return "";
  return `<span class="code-tag code-tag-${tree.prState.toLowerCase()}">#${tree.prNumber} ${tree.prState.toLowerCase()}</span>`;
}

function aheadBehind(tree) {
  if (tree.main || tree.ahead === undefined) return "";
  return `<span class="code-ab" data-tip="${tree.ahead} commits ahead of main, ${tree.behind} behind"><span class="${tree.ahead ? "is-ahead" : ""}">↑${tree.ahead}</span><span class="${tree.behind > 200 ? "is-far" : ""}">↓${tree.behind}</span></span>`;
}

function treeActions(tree) {
  const url = githubUrl(tree);
  return runButton(tree.repo, tree, tree.branch)
    + iconButton("vscode", "Open in VS Code (E)", `data-code-open="vscode" data-path="${escapeHtml(tree.path)}"`)
    + iconButton("terminal", `Open in ${config().code.terminal.label} (X)`, `data-code-open="terminal" data-path="${escapeHtml(tree.path)}"`)
    + iconButton("folder", "Reveal in Finder", `data-code-open="finder" data-path="${escapeHtml(tree.path)}"`)
    + iconButton("session", `New ${appName()} session here (S)`, `data-code-session data-path="${escapeHtml(tree.path)}"`)
    + (url ? `<a class="code-icon-button" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" aria-label="Branch on GitHub">${icon("external")}</a>` : `<span class="code-icon-button is-blank"></span>`);
}

function skillButtons(pr, workspace, tree) {
  return (meta().skills || []).map((skill, index) => iconButton(skill.icon || skill.id, `${skill.label} in ${appName()} · ${tree ? "worktree" : "main checkout"} (${index + 1})`, `data-code-skill="${skill.id}" data-url="${escapeHtml(pr.url)}" data-path="${escapeHtml(workspace)}"`)).join("");
}

function sizeBar(pr) {
  const total = pr.additions + pr.deletions;
  const width = Math.min(48, Math.round(Math.log10(total + 1) * 14));
  const add = total ? Math.round((pr.additions / total) * width) : 0;
  return `<span class="code-size" data-tip="+${pr.additions} −${pr.deletions}"><span class="code-size-add" style="width:${add}px"></span><span class="code-size-del" style="width:${width - add}px"></span></span>`;
}

// One mark per person everywhere: the GitHub avatar over initials on a hue of the name, so a missing image still reads.
const initialsOf = (name) => name.replace(/^app\//, "").split(/[\s._-]+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
const avatar = (login, name = login) => `<span class="code-avatar" style="--hue:${branchHue(name || "?")}" aria-hidden="true">${escapeHtml(initialsOf(name || "?"))}${login ? `<img src="https://github.com/${encodeURIComponent(login.replace(/^app\//, ""))}.png?size=40" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>`;
const REVIEW = { APPROVED: ["approved", "Approved"], CHANGES_REQUESTED: ["changes", "Changes requested"], REVIEW_REQUIRED: ["required", "Needs review"] };
const reviewTag = (pr) => { const [kind, label] = REVIEW[pr.reviewDecision] || ["", ""]; return kind ? `<span class="code-tag code-tag-${kind}">${label}</span>` : ""; };
// One icon per row for the states that change what to do next, named on hover; an ordinary "needs review" stays blank.
// Approval is a ringed check so it never reads as the bare CI check beside the PR number.
const PR_STATES = { draft: ["draft", "draft"], CHANGES_REQUESTED: ["fail", "diff"], APPROVED: ["pass", "approved"], mine: ["review", "review"], requested: ["requested", "person"] };
// Bots (Copilot, anything[bot]) are requested automatically, so they don't count as asking someone for a review.
const humanReviewers = (pr) => (pr.reviewers || []).filter((login) => !/copilot|\[bot\]$/i.test(login));
const prState = (pr) => {
  const people = humanReviewers(pr);
  const key = pr.draft ? "draft" : PR_STATES[pr.reviewDecision] ? pr.reviewDecision : pr.requestedOfMe ? "mine" : people.length ? "requested" : "";
  if (!key) return "";
  const [name, glyph] = PR_STATES[key];
  const by = (state) => (pr.reviews || []).filter((review) => review.state === state).map((review) => review.login).join(", ");
  const tip = {
    draft: "Draft",
    APPROVED: `Approved${by("APPROVED") ? ` by ${by("APPROVED")}` : ""}`,
    CHANGES_REQUESTED: `Changes requested${by("CHANGES_REQUESTED") ? ` by ${by("CHANGES_REQUESTED")}` : ""}`,
    mine: "Your review is requested",
    requested: `Review requested from ${people.join(", ")}`,
  }[key];
  return `<span class="code-state code-state-${name}" role="img" aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}">${icon(glyph)}${key === "requested" ? `<b class="code-state-count">${people.length}</b>` : ""}</span>`;
};
const labelDots = (pr) => (pr.labels || []).map((label) => `<span class="code-label" style="--label:#${escapeHtml(label.color.replace(/[^0-9a-f]/gi, ""))}">${escapeHtml(label.name)}</span>`).join("");

// Worktrees by the day of their last activity, 30 days back; click a bar to filter to that day.
function activityStrip(trees) {
  const days = Array.from({ length: 30 }, (_, index) => dayKey(Date.now() - (29 - index) * DAY));
  const counts = new Map(days.map((day) => [day, { dirty: 0, clean: 0 }]));
  for (const tree of trees) {
    const bucket = counts.get(dayKey(tree.activity));
    if (bucket) bucket[tree.dirty > 0 ? "dirty" : "clean"]++;
  }
  const max = Math.max(1, ...[...counts.values()].map((count) => count.dirty + count.clean));
  const bars = days.map((day) => {
    const { dirty, clean } = counts.get(day);
    const total = dirty + clean;
    const label = new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    return `<button type="button" class="code-bar${ui.day === day ? " is-active" : ""}" data-code-day="${day}" data-tip="${label}: ${total} worktree${total === 1 ? "" : "s"}${dirty ? `, ${dirty} uncommitted` : ""}" aria-label="${label}, ${total} worktrees"><span class="code-bar-clean" style="height:${(clean / max) * 100}%"></span><span class="code-bar-dirty" style="height:${(dirty / max) * 100}%"></span></button>`;
  }).join("");
  return `<div class="code-activity" role="group" aria-label="Worktree activity, last 30 days" data-tip="Worktree activity, last 30 days">${bars}</div>`;
}

// ---------- worktrees ----------

function visibleTrees() {
  const scopes = {
    all: () => true,
    today: (tree) => Date.now() - tree.activity < DAY,
    week: (tree) => Date.now() - tree.activity < 7 * DAY,
    dirty: (tree) => tree.dirty > 0,
    pr: (tree) => Boolean(prFor(tree)),
  };
  return ui.data.worktrees
    .filter((tree) => !ui.removed.has(tree.path))
    .filter(scopes[ui.treeScope] || scopes.all)
    .filter((tree) => !ui.day || dayKey(tree.activity) === ui.day)
    .filter((tree) => matches(`${tree.branch} ${tree.path} ${prFor(tree)?.title || ""}`));
}

function treeRow(tree) {
  const pr = prFor(tree);
  const key = `tree:${tree.path}`;
  return `<tr class="code-row" data-code-row="${escapeHtml(key)}" aria-selected="${ui.sel === key}">
    <td class="code-col-main"><div class="code-line">${branchChip(tree.branch, "code-branch")}${tree.main ? '<span class="code-tag">main checkout</span>' : ""}${tree.dirty ? `<span class="code-tag code-tag-dirty">${tree.dirty} changed</span>` : ""}</div>
      ${pr ? `<div class="code-sub">${escapeHtml(pr.title)}</div>` : ""}</td>
    <td class="code-col-pr">${pr ? prChip(pr) : historyChip(tree)}</td>
    <td class="code-col-ab">${aheadBehind(tree)}</td>
    <td class="code-col-when code-heat-${heat(tree.activity)}">${when(tree.activity)}</td>
    <td class="code-col-path"><button type="button" class="code-path" data-code-copy="${escapeHtml(tree.path)}" data-tip="Copy path (Y)">${escapeHtml(shortPath(tree.path))}</button></td>
    <td class="code-col-actions">${treeActions(tree)}</td></tr>`;
}

// Names everything narrowing the list and offers one way back to all of it.
function emptyState(noun) {
  const scopes = { requested: "review requested", today: "last 24h", week: "this week", dirty: "uncommitted", pr: "with an open PR" };
  const narrowing = [
    ui.tab === "prs" && ui.prScope !== "all" && scopes[ui.prScope],
    ui.tab === "prs" && ui.hideDrafts && "no drafts",
    ui.tab === "prs" && ui.failingOnly && "failing CI",
    ui.tab === "worktrees" && ui.treeScope !== "all" && scopes[ui.treeScope],
    ui.tab === "worktrees" && ui.day && new Date(`${ui.day}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    ui.tab === "commits" && (ui.branches.size || ui.prefixes.size) && "picked branches",
    ui.tab !== "worktrees" && ui.authors.size && (ui.authors.size === 1 ? `${authorName([...ui.authors][0])}'s` : "picked authors"),
  ].filter(Boolean);
  if (!ui.filter && !narrowing.length) return `<div class="code-empty"><p>No ${noun} yet.</p></div>`;
  const query = ui.filter ? ` match <b>“${escapeHtml(ui.filter)}”</b>` : "";
  const within = narrowing.length ? ` in ${narrowing.map(escapeHtml).join(", ")}` : "";
  return `<div class="code-empty"><p>No ${noun}${query || " match"}${within}.</p><button type="button" class="code-bar-button" data-code-reset>Clear ${ui.filter && narrowing.length ? "search and filters" : ui.filter ? "search" : "filters"} <kbd>Esc</kbd></button></div>`;
}

const tableHead = (columns) => `<thead><tr>${columns.map(([className, label]) => `<th class="${className}">${label}</th>`).join("")}</tr></thead>`;

function worktreesBody() {
  const trees = visibleTrees();
  if (!trees.length) return emptyState("worktrees");
  const groups = [["Last 24 hours", (tree) => Date.now() - tree.activity < DAY], ["This week", (tree) => Date.now() - tree.activity < 7 * DAY], ["This month", (tree) => Date.now() - tree.activity < 30 * DAY], ["Older", () => true]];
  const seen = new Set();
  const sections = groups.map(([label, test]) => {
    const rows = trees.filter((tree) => !seen.has(tree.path) && test(tree));
    rows.forEach((tree) => seen.add(tree.path));
    return rows.length ? `<tbody><tr class="code-group-row"><th colspan="6">${label} <span>${rows.length}</span></th></tr>${rows.map(treeRow).join("")}</tbody>` : "";
  }).join("");
  return `<table class="code-table">${tableHead([["code-col-main", "Branch"], ["code-col-pr", "PR"], ["code-col-ab", "vs main"], ["code-col-when", "Changed"], ["code-col-path", "Path"], ["code-col-actions", "Open"]])}${sections}</table>`;
}

// ---------- pull requests ----------

function visiblePrs() {
  const sorts = {
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    created: (a, b) => a.createdAt.localeCompare(b.createdAt),
    size: (a, b) => (b.additions + b.deletions) - (a.additions + a.deletions),
  };
  return ui.data.prs
    .filter((pr) => ui.prScope === "all" || pr.requestedOfMe)
    .filter(authorFilter)
    .filter((pr) => !(ui.hideDrafts && pr.draft))
    .filter((pr) => !ui.failingOnly || ["FAILURE", "ERROR"].includes(pr.ci))
    .filter((pr) => matches(`#${pr.number} ${pr.number} ${pr.title} ${pr.author} ${pr.branch} ${(pr.labels || []).map((label) => label.name).join(" ")}`))
    .sort(sorts[ui.prSort] || sorts.updated);
}

// Stacked PRs: a PR whose base is another open PR's head branch sits on top of it.
const stackKey = (repo, branch) => `${repo}\0${branch}`;
const stackParent = (pr, prs = ui.data.prs) => { const up = prs.find((item) => item.repo === pr.repo && item.branch === pr.base); return up === pr ? null : up; };

// The whole stack containing `pr`, base first, depth-first so each fork's subtree stays together.
function stackOf(pr, prs = ui.data.prs) {
  const parent = (item) => stackParent(item, prs);
  const children = new Map();
  for (const item of prs) {
    const up = parent(item);
    if (up) children.set(up, [...(children.get(up) || []), item]);
  }
  let root = pr;
  for (const seen = new Set([pr]); parent(root) && !seen.has(parent(root));) { root = parent(root); seen.add(root); }
  const out = [];
  const walk = (item) => { if (out.includes(item)) return; out.push(item); (children.get(item) || []).sort((a, b) => a.number - b.number).forEach(walk); };
  walk(root);
  return out;
}

// Keeps each stack together at the position of its first visible member and lays out a subway rail:
// a child continues its parent's lane when it is the next row, otherwise it forks into a new lane.
function stackOrder(prs) {
  const visible = new Set(prs);
  const placed = new Set();
  const rows = [];
  for (const pr of prs) {
    if (placed.has(pr)) continue;
    const stack = stackOf(pr);
    const shown = stack.filter((item) => visible.has(item));
    shown.forEach((item) => placed.add(item));
    if (stack.length < 2) { rows.push({ pr, rail: null }); continue; }
    const parts = shown.map(() => []);
    const lane = new Map();
    let lanes = 1;
    shown.forEach((item, index) => {
      let up = stackParent(item);
      while (up && !visible.has(up)) up = stackParent(up);
      const from = up ? shown.indexOf(up) : -1;
      lane.set(item, from < 0 ? 0 : from === index - 1 ? lane.get(up) : lanes++);
      const own = lane.get(item);
      if (from >= 0) {
        parts[from].push(lane.get(up) === own ? { kind: "bottom", lane: own } : { kind: "elbow", from: lane.get(up), lane: own });
        for (let row = from + 1; row < index; row++) parts[row].push({ kind: "full", lane: own });
        parts[index].push({ kind: "top", lane: own });
      }
    });
    shown.forEach((item, index) => rows.push({ pr: item, rail: { lane: lane.get(item), parts: parts[index], position: stack.indexOf(item) + 1, size: stack.length, parent: stackParent(item) } }));
    rows.slice(-shown.length).forEach((row) => { row.rail.width = lanes; });
  }
  return rows;
}

function railCell(pr, rail) {
  if (!rail) return `<td class="code-col-stack"></td>`;
  const tip = `${rail.position} of ${rail.size} in this stack · on ${rail.parent ? `#${rail.parent.number} ${rail.parent.title}` : pr.base}`;
  const at = (lane) => `--lane:${lane}`;
  const parts = rail.parts.map((part) => part.kind === "elbow"
    ? `<b class="code-rail-elbow" style="${at(part.from)};--span:${part.lane - part.from}"></b>`
    : `<b class="code-rail-${part.kind}" style="${at(part.lane)}"></b>`).join("");
  return `<td class="code-col-stack" style="--lanes:${rail.width}"><span class="code-rail" data-tip="${escapeHtml(tip)}" role="img" aria-label="${escapeHtml(tip)}">${parts}<i class="${rail.parent ? "" : "is-base"}${rail.position > 9 ? " is-wide" : ""}" style="${at(rail.lane)}">${rail.position}</i></span></td>`;
}

// Says which way the stack runs: the base names its size and target branch, every other PR the PR it sits on.
function stackNote(pr, rail) {
  if (!rail) return "";
  return rail.parent
    ? `<span class="code-sub-stack">on <a class="code-pr-link" href="${escapeHtml(rail.parent.url)}" target="_blank" rel="noreferrer">#${rail.parent.number}</a></span>`
    : `<span class="code-sub-stack">base of ${rail.size} · on ${escapeHtml(pr.base)}</span>`;
}

function prRow(pr, rail) {
  const tree = worktreeFor(pr);
  const workspace = tree?.path || pr.repo;
  const key = `pr:${pr.slug}#${pr.number}`;
  return `<tr class="code-row" data-code-row="${escapeHtml(key)}" aria-selected="${ui.sel === key}">
    ${railCell(pr, rail)}<td class="code-col-num"><a class="code-pr-link" href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">${ciBadge(pr)}#${pr.number}</a></td>
    <td class="code-col-main"><div class="code-pr-title">${escapeHtml(pr.title)}</div>
      <div class="code-sub">${authorButton(pr.author, pr.author, authorName(pr.author), true)}${stackNote(pr, rail)}${branchChip(pr.branch)}</div></td>
    <td class="code-col-flags">${prFlags(pr, tree)}</td>
    <td class="code-col-labels">${labelDots(pr)}</td>
    <td class="code-col-state">${prState(pr)}</td>
    <td class="code-col-size">${sizeBar(pr)}</td>
    <td class="code-col-when">${when(pr.updatedAt)}<span class="code-age" data-tip="Opened ${escapeHtml(new Date(pr.createdAt).toLocaleDateString())}">${ago(pr.createdAt)} old</span></td>
    <td class="code-col-skills">${skillButtons(pr, workspace, tree)}</td>
    <td class="code-col-actions">${runButton(pr.repo, tree, pr.branch)}${previewButton(pr)}${copyButton(pr.url, "Copy PR link (Y)")}${tree ? iconButton("vscode", "Open worktree in VS Code", `data-code-open="vscode" data-path="${escapeHtml(tree.path)}"`) : `<span class="code-icon-button is-blank"></span>`}</td></tr>`;
}

// Two fixed slots, so the same flag lines up from row to row; the toolbar legend names them.
const FLAGS = {
  local: ["code-flag-local", "Local worktree"],
  conflict: ["code-flag-conflict", "Merge conflicts"],
};
const flag = (name, on, tip = FLAGS[name][1]) => on ? `<span class="code-flag ${FLAGS[name][0]}" data-tip="${escapeHtml(tip)}" role="img" aria-label="${escapeHtml(tip)}">${icon(name === "conflict" ? "conflict" : name)}</span>` : `<span class="code-flag" aria-hidden="true"></span>`;
const prFlags = (pr, tree) => flag("local", Boolean(tree), tree ? `Local worktree: ${shortPath(tree.path)}` : "") + flag("conflict", pr.mergeable === "CONFLICTING")
  + `<span class="code-comments"${pr.comments ? ` data-tip="${pr.comments} comments"` : ' aria-hidden="true"'}>${pr.comments ? `${icon("comment")}${pr.comments}` : ""}</span>`;

function prsBody() {
  const prs = visiblePrs();
  if (!prs.length) return emptyState("pull requests");
  return `<table class="code-table">${tableHead([["code-col-stack", ""], ["code-col-num", "PR"], ["code-col-main", "Title · author · branch"], ["code-col-flags", "Flags"], ["code-col-labels", "Labels"], ["code-col-state", "State"], ["code-col-size", "Size"], ["code-col-when", "Updated"], ["code-col-skills", `Send to ${appName()}`], ["code-col-actions", "Open"]])}<tbody>${stackOrder(prs).map(({ pr, rail }) => prRow(pr, rail)).join("")}</tbody></table>`;
}

// ---------- commits ----------

const COMMIT_SCOPES = { local: "Not on main", all: "Everything" };
const commitsInScope = () => ui.commits.get(ui.commitScope);
const commitFor = (key) => commitsInScope()?.find((commit) => `commit:${commit.sha}` === key);

async function loadCommits(force = false) {
  const scope = ui.commitScope;
  if (!force && ui.commits.has(scope)) return;
  ui.commits.set(scope, null);
  if (host) host.dataset.commitsState = "loading";
  try {
    const response = await fetch(`/api/code/commits?scope=${scope}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load commits.");
    ui.commits.set(scope, body.commits);
  } catch (error) {
    ui.commits.delete(scope);
    notify(error.message, true);
  }
  if (ui.tab === "commits") render({ animate: true });
  if (host && ui.commits.has(scope)) host.dataset.commitsState = "ready";
}

function visibleCommits() {
  return (commitsInScope() || [])
    .filter(branchFilter)
    .filter(authorFilter)
    .filter((commit) => matches(`${commit.sha} ${commit.subject} ${commit.author} ${commit.branch}`));
}

// A stable hue per branch name (FNV-1a, spread by the golden angle) so repeated branches read at a glance.
function branchHue(branch) {
  let hash = 2166136261;
  for (const char of branch) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return Math.round(((hash >>> 0) * 137.508) % 360);
}

// Shape × hue gives ~80 distinguishable marks, enough that two of 70 branches rarely look alike.
const GLYPHS = [
  '<circle cx="5" cy="5" r="4"/>', '<rect x="1.2" y="1.2" width="7.6" height="7.6" rx="1"/>', '<path d="M5 .8 9.4 9H.6z"/>', '<path d="M5 .5 9.5 5 5 9.5.5 5z"/>',
  '<path d="M5 .6 9.2 3.7 7.6 8.9H2.4L.8 3.7z"/>', '<path d="M5 .5l1.3 3h3.2L7 5.6l1 3.6L5 7.1 2 9.2l1-3.6L.5 3.5h3.2z"/>', '<path d="M3.4 .8h3.2v2.6h2.6v3.2H6.6v2.6H3.4V6.6H.8V3.4h2.6z"/>', '<path d="M5 .8 9.2 5 5 9.2.8 5z" fill="none" stroke-width="1.6"/>',
];
const branchGlyph = (branch) => {
  const hue = branchHue(branch);
  const shape = GLYPHS[(hue * 7 + branch.length) % GLYPHS.length];
  return `<svg class="code-branch-glyph" viewBox="0 0 10 10" style="--hue:${hue}" aria-hidden="true">${shape}</svg>`;
};
// Long names keep a short head and their distinctive tail in whole words: "concurrency-05-build-reuse" → "concu…05-build-reuse".
function middleTrim(text, max = 24) {
  if (text.length <= max) return text;
  const parts = text.split("-");
  const head = parts.shift().slice(0, 5);
  let tail = "";
  while (parts.length && head.length + 1 + parts.at(-1).length + (tail ? tail.length + 1 : 0) <= max) tail = tail ? `${parts.pop()}-${tail}` : parts.pop();
  return `${head}…${tail || text.slice(-(max - head.length - 1))}`;
}

// `repeat` mutes the name when the row above is on the same branch, so runs read as one block.
function branchPill(branch, repeat = false) {
  if (!branch) return "";
  const filtered = ui.branches.has(branch);
  const prefix = prefixOf(branch);
  return `<button type="button" class="code-branch-tag${filtered ? " is-filtered" : ""}${repeat ? " is-repeat" : ""}" data-code-branch-filter="${escapeHtml(branch)}" data-tip="${escapeHtml(branch)} · click to ${filtered ? "stop filtering" : "filter to this branch"}">${branchGlyph(branch)}${prefix ? `<em>${escapeHtml(prefix)}</em>` : ""}<span>${escapeHtml(middleTrim(branch.slice(prefix.length)))}</span></button>`;
}

// ---------- authors ----------
// The author filter spans both tabs. Its key is a GitHub login, or the git name of a commit whose login is unknown.
const authorOf = (item) => item.sha ? item.login || item.author : item.author;
const authorName = (key) => key === ui.data.me ? "you" : key.replace(/^app\//, "");
const authorFilter = (item) => !ui.authors.size || ui.authors.has(authorOf(item));

// A row's avatar (and name, when `labelled`) filters to that author on click.
function authorButton(key, login, tip, labelled = false) {
  const filtered = ui.authors.has(key);
  return `<button type="button" class="code-author${labelled ? " is-labelled" : ""}${filtered ? " is-filtered" : ""}" data-code-author-filter="${escapeHtml(key)}" data-tip="${escapeHtml(`${tip} · click to ${filtered ? "stop filtering" : "show only theirs"}`)}">${avatar(login, key)}${labelled ? `<span>${escapeHtml(authorName(key))}</span>` : ""}</button>`;
}

// Authors on the current tab, you first, then by how much they've done; picked authors stay listed even at zero.
function authorStats() {
  const stats = new Map();
  const add = (key, login) => stats.get(key) || stats.set(key, { key, login, names: new Set(), count: 0, latest: 0 }).get(key);
  for (const item of ui.tab === "prs" ? ui.data.prs : commitsInScope() || []) {
    const key = authorOf(item);
    if (!key) continue;
    const entry = add(key, item.sha ? item.login : item.author);
    entry.count++;
    entry.latest = Math.max(entry.latest, item.time || new Date(item.updatedAt).getTime());
    if (item.sha && item.author !== key) entry.names.add(item.author);
  }
  for (const key of ui.authors) add(key, /\s/.test(key) ? "" : key);
  return [...stats.values()].sort((a, b) => (b.key === ui.data.me) - (a.key === ui.data.me) || b.count - a.count || b.latest - a.latest);
}

function authorTrigger() {
  const stats = authorStats();
  const picked = stats.filter((entry) => ui.authors.has(entry.key));
  const label = picked.length === 1 ? authorName(picked[0].key) : picked.length ? `${picked.length} authors` : "Authors";
  const marks = picked.length ? `<i class="code-avatar-stack">${picked.slice(0, 3).map((entry) => avatar(entry.login, entry.key)).join("")}</i>` : icon("person");
  return `<button type="button" class="code-branch-trigger code-author-trigger${picked.length ? " is-active" : ""}" popovertarget="code-authors" data-code-author-trigger>${marks}<span class="code-trigger-label">${escapeHtml(label)}</span><span class="code-count">${stats.length}</span><kbd>A</kbd></button>`
    + (picked.length ? `<button type="button" class="code-more" data-code-author-clear>Clear</button>` : "");
}

function toggleAuthor(key, only = false) {
  if (only) ui.authors = new Set([key]);
  else ui.authors.has(key) ? ui.authors.delete(key) : ui.authors.add(key);
  syncUrl();
  render({ animate: true });
  renderAuthorList();
}

// Like the branch picker: redrawn on its own so typing never replaces the search box.
function renderAuthorList() {
  const panel = host?.querySelector("#code-authors");
  if (!panel?.matches(":popover-open")) return;
  const words = ui.authorQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = authorStats().filter((entry) => words.every((word) => `${entry.key} ${[...entry.names].join(" ")} ${authorName(entry.key)}`.toLowerCase().includes(word)));
  ui.authorActive = Math.max(0, Math.min(rows.length - 1, ui.authorActive));
  const noun = ui.tab === "prs" ? "open PRs" : "commits";
  panel.querySelector("[data-author-list]").innerHTML = rows.length ? rows.map((entry, index) => {
    const aka = [...entry.names].filter((name) => name.toLowerCase() !== entry.key.toLowerCase()).slice(0, 2).join(", ");
    return `<li data-author-row="${escapeHtml(entry.key)}" aria-selected="${index === ui.authorActive}">
      <input type="checkbox" tabindex="-1" ${ui.authors.has(entry.key) ? "checked" : ""} aria-label="Show ${escapeHtml(entry.key)}">
      <span class="code-author-name">${avatar(entry.login, entry.key)}<b>${escapeHtml(authorName(entry.key))}</b>${entry.key === ui.data.me ? `<span class="code-muted">${escapeHtml(entry.key)}</span>` : ""}${aka ? `<span class="code-muted">${escapeHtml(aka)}</span>` : ""}</span>
      <span class="code-count" data-tip="${entry.count} ${noun}">${entry.count}</span>${entry.latest ? `<span class="code-heat-${heat(entry.latest)}">${when(entry.latest)}</span>` : "<span></span>"}
      <button type="button" class="code-more" data-author-only="${escapeHtml(entry.key)}">Only</button></li>`;
  }).join("") : `<li class="code-muted">No author matches.</li>`;
  panel.querySelector("[data-author-actions]").innerHTML = ui.authors.size ? `<button type="button" class="code-more" data-code-author-clear>Clear ${ui.authors.size} picked</button>` : "";
  panel.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function authorKeys(event) {
  const rows = [...host.querySelectorAll("#code-authors [data-author-row]")];
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (step) { ui.authorActive += step; renderAuthorList(); event.preventDefault(); return; }
  const active = rows[ui.authorActive]?.dataset.authorRow;
  if (event.key === "Enter" && active) { event.preventDefault(); toggleAuthor(active, event.shiftKey); if (event.shiftKey) host.querySelector("#code-authors").hidePopover(); }
}

function commitRow(commit, repeat = false) {
  const key = `commit:${commit.sha}`;
  const many = ui.data.repos.length > 1;
  return `<tr class="code-row" data-code-row="${escapeHtml(key)}" aria-selected="${ui.sel === key}">
    <td class="code-col-when code-heat-${heat(commit.time)}">${when(commit.time)}</td>
    <td class="code-col-author">${authorButton(authorOf(commit), commit.login, `${commit.author} <${commit.email}>`)}</td>
    <td class="code-col-branch">${branchPill(commit.branch, repeat)}</td>
    <td class="code-col-main"><div class="code-pr-title" data-tip="${escapeHtml(commit.subject)}">${many ? `<span class="code-muted">${escapeHtml(repoName(commit.repo))}</span> ` : ""}${escapeHtml(commit.subject)}</div></td>
    <td class="code-col-files" data-tip="+${commit.additions} −${commit.deletions}">${commit.files}</td>
    <td class="code-col-num"><button type="button" class="code-path" data-code-copy="${commit.sha}" data-tip="Copy SHA">${commit.sha.slice(0, 8)}</button></td>
    <td class="code-col-actions">${iconButton("diff", "View diff (Enter)", `data-code-row-diff="${escapeHtml(key)}"`)}${commit.worktree ? iconButton("vscode", "Open worktree in VS Code", `data-code-open="vscode" data-path="${escapeHtml(commit.worktree)}"`) : `<span class="code-icon-button is-blank"></span>`}</td></tr>`;
}

function commitsBody() {
  const list = commitsInScope();
  if (!list) return `<p class="code-empty">Loading commits…</p>`;
  const commits = visibleCommits();
  if (!commits.length) return emptyState("commits");
  const groups = [["Last 24 hours", DAY], ["This week", 7 * DAY], ["This month", 30 * DAY], ["Older", Infinity]];
  let start = 0;
  const sections = groups.map(([label, age]) => {
    let end = start;
    while (end < commits.length && Date.now() - commits[end].time < age) end++;
    const rows = commits.slice(start, end);
    start = end;
    return rows.length ? `<tbody><tr class="code-group-row"><th colspan="7">${label} <span>${rows.length}</span></th></tr>${rows.map((commit, index) => commitRow(commit, rows[index - 1]?.branch === commit.branch)).join("")}</tbody>` : "";
  }).join("");
  return `<table class="code-table code-commit-table">${tableHead([["code-col-when", "When"], ["code-col-author", ""], ["code-col-branch", "Branch"], ["code-col-main", "Subject"], ["code-col-files", "Files"], ["code-col-num", "SHA"], ["code-col-actions", ""]])}${sections}</table>`;
}

// Branch filtering: prefix facets (codex/, alex/…) and picked branches combine with OR, so "codex/ plus my one
// branch" works; the text filter then narrows what's left.
const prefixOf = (branch) => branch.includes("/") ? `${branch.split("/")[0]}/` : "";
const branchFilter = (commit) => (!ui.branches.size && !ui.prefixes.size) || ui.branches.has(commit.branch) || ui.prefixes.has(prefixOf(commit.branch));

// Branches in the current scope, newest commit first, with what the picker shows about each.
function branchStats() {
  const stats = new Map();
  for (const commit of commitsInScope() || []) {
    if (!commit.branch) continue;
    const entry = stats.get(commit.branch) || stats.set(commit.branch, { branch: commit.branch, count: 0, latest: commit.time, repo: commit.repo, worktree: commit.worktree }).get(commit.branch);
    entry.count++;
  }
  return [...stats.values()];
}

function toggleBranch(branch, only = false) {
  if (only) { ui.branches = new Set([branch]); ui.prefixes.clear(); }
  else ui.branches.has(branch) ? ui.branches.delete(branch) : ui.branches.add(branch);
  render({ animate: true });
  renderBranchList();
}

function commitControls() {
  const list = commitsInScope() || [];
  const prefixes = new Map();
  for (const commit of list) { const prefix = prefixOf(commit.branch); if (prefix) prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1); }
  const facets = [...prefixes].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([prefix, count]) => `<button type="button" class="code-facet" data-code-prefix="${escapeHtml(prefix)}" aria-pressed="${ui.prefixes.has(prefix)}" data-tip="Every ${escapeHtml(prefix)}… branch">${escapeHtml(prefix)}<span class="code-count">${count}</span></button>`).join("");
  // A few picked branches show as removable chips; more than that, the trigger's "N branches" stands in for them.
  const picked = ui.branches.size > 3 ? "" : [...ui.branches].map((branch) => `<span class="code-picked"><button type="button" data-code-branch-filter="${escapeHtml(branch)}" data-tip="Remove ${escapeHtml(branch)}">${escapeHtml(branch)}<b aria-hidden="true">×</b></button></span>`).join("");
  const label = ui.branches.size === 1 ? [...ui.branches][0] : ui.branches.size ? `${ui.branches.size} branches` : "Branches";
  const any = ui.branches.size || ui.prefixes.size;
  return `<div class="code-segment">${Object.entries(COMMIT_SCOPES).map(([id, label]) => `<button type="button" data-code-commit-scope="${id}" aria-pressed="${ui.commitScope === id}">${label}</button>`).join("")}</div>
    ${authorTrigger()}
    <button type="button" class="code-branch-trigger${ui.branches.size ? " is-active" : ""}" popovertarget="code-branches" data-code-branch-trigger>${icon("branch")}<span>${escapeHtml(label)}</span><span class="code-count">${branchStats().length}</span><kbd>B</kbd></button>
    ${facets ? `<div class="code-facets">${facets}</div>` : ""}${picked}${any ? `<button type="button" class="code-more" data-code-branch-clear>Clear</button>` : ""}`;
}

// The picker's list is redrawn on its own so typing never replaces the search box.
function renderBranchList() {
  const panel = host?.querySelector("#code-branches");
  if (!panel?.matches(":popover-open")) return;
  const words = ui.branchQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = branchStats().filter((entry) => words.every((word) => entry.branch.toLowerCase().includes(word)));
  ui.branchActive = Math.max(0, Math.min(rows.length - 1, ui.branchActive));
  const mark = (name) => {
    const word = words.find((candidate) => name.toLowerCase().includes(candidate));
    if (!word) return escapeHtml(name);
    const at = name.toLowerCase().indexOf(word);
    return `${escapeHtml(name.slice(0, at))}<mark>${escapeHtml(name.slice(at, at + word.length))}</mark>${escapeHtml(name.slice(at + word.length))}`;
  };
  panel.querySelector("[data-branch-list]").innerHTML = rows.length ? rows.map((entry, index) => {
    const tree = entry.worktree && ui.data.worktrees.find((candidate) => candidate.path === entry.worktree);
    const pr = ui.data.prs.find((candidate) => candidate.repo === entry.repo && candidate.branch === entry.branch);
    return `<li data-branch-row="${escapeHtml(entry.branch)}" aria-selected="${index === ui.branchActive}">
      <input type="checkbox" tabindex="-1" ${ui.branches.has(entry.branch) ? "checked" : ""} aria-label="Show ${escapeHtml(entry.branch)}">
      <span class="code-branch-name">${branchGlyph(entry.branch)}${mark(entry.branch)}</span>
      <span class="code-branch-meta">${tree?.dirty ? `<span class="code-tag code-tag-dirty">${tree.dirty} changed</span>` : ""}${pr ? `<span class="code-tag">#${pr.number}</span>` : ""}${tree ? `<span class="code-flag code-flag-local" data-tip="Local worktree">${icon("local")}</span>` : ""}</span>
      <span class="code-count">${entry.count}</span><span class="code-heat-${heat(entry.latest)}">${when(entry.latest)}</span>
      <button type="button" class="code-more" data-branch-only="${escapeHtml(entry.branch)}">Only</button></li>`;
  }).join("") : `<li class="code-muted">No branch matches.</li>`;
  const unpicked = rows.filter((entry) => !ui.branches.has(entry.branch)).length;
  panel.querySelector("[data-branch-actions]").innerHTML = (words.length && unpicked ? `<button type="button" class="code-bar-button" data-branch-all>Add all ${unpicked} matches</button>` : "")
    + (ui.branches.size ? `<button type="button" class="code-more" data-code-branch-clear>Clear ${ui.branches.size} picked</button>` : "");
  panel.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function branchKeys(event) {
  const rows = [...host.querySelectorAll("#code-branches [data-branch-row]")];
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (step) { ui.branchActive += step; renderBranchList(); event.preventDefault(); return; }
  const active = rows[ui.branchActive]?.dataset.branchRow;
  if (event.key === "Enter" && active) { event.preventDefault(); toggleBranch(active, event.shiftKey); if (event.shiftKey) host.querySelector("#code-branches").hidePopover(); }
}

// The branch's open PR (or, from PR history, its last closed or merged one) so it is one click away.
function commitPrSection(commit) {
  const pr = ui.data.prs.find((candidate) => candidate.repo === commit.repo && candidate.branch === commit.branch);
  if (pr) {
    return `<section><h4>Pull request</h4><div class="code-commit-pr"><a class="code-pr-link" href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">${ciBadge(pr)}#${pr.number}</a><span class="code-commit-pr-title">${escapeHtml(pr.title)}</span></div>
      <div class="code-detail-meta">${reviewTag(pr)}${pr.draft ? '<span class="code-tag code-tag-draft">draft</span>' : ""}${pr.mergeable === "CONFLICTING" ? '<span class="code-tag code-tag-dirty">conflicts</span>' : ""}<span class="code-muted">updated ${ago(pr.updatedAt)} ago</span><span class="code-spacer"></span>
      <button type="button" class="code-bar-button" data-code-goto-pr="${escapeHtml(`pr:${pr.slug}#${pr.number}`)}">Inspect PR</button>${previewButton(pr)}${copyButton(pr.url, "Copy PR link")}<a class="code-icon-button" href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer" aria-label="Open PR on GitHub">${icon("external")}</a></div></section>`;
  }
  const tree = ui.data.worktrees.find((candidate) => candidate.repo === commit.repo && candidate.branch === commit.branch);
  const slug = ui.data.slugs?.[commit.repo];
  if (!tree?.prNumber || !slug) return "";
  const url = `https://github.com/${slug}/pull/${tree.prNumber}`;
  return `<section><h4>Pull request</h4><div class="code-detail-meta"><a class="code-pr-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">#${tree.prNumber}</a>${historyChip(tree)}<span class="code-spacer"></span>${copyButton(url, "Copy PR link")}</div></section>`;
}

function commitDetailPane(commit) {
  const extra = ui.detail.get(`commit:${commit.sha}`);
  const body = extra?.body.split("\n").slice(1).join("\n").trim();
  return `<header class="code-detail-head"><h3>${escapeHtml(commit.subject)}</h3>${copyButton(commit.sha, "Copy SHA")}</header>
    <div class="code-detail-meta">${avatar(commit.login, authorOf(commit))}<span>${escapeHtml(commit.author)}${commit.login && commit.login !== commit.author ? ` <span class="code-muted">${escapeHtml(commit.login)}</span>` : ""}</span><span>${when(commit.time)} ago</span><code>${commit.sha.slice(0, 10)}</code></div>
    <div class="code-detail-meta">${branchPill(commit.branch)}${sizeBar(commit)}<span class="code-muted">+${commit.additions} −${commit.deletions}</span></div>
    <div class="code-detail-actions"><button type="button" class="code-bar-button" data-code-view-diff>View diff <kbd>Enter</kbd></button>${commit.worktree ? treeActions(ui.data.worktrees.find((tree) => tree.path === commit.worktree) || { path: commit.worktree, branch: commit.branch }) : ""}</div>
    ${commitPrSection(commit)}
    ${body ? `<section><h4>Message</h4><pre class="code-commit-body">${escapeHtml(body)}</pre></section>` : ""}
    <section><h4>Files <span>${extra?.files?.length ?? ""}</span></h4>${extra ? fileTree(extra.files, diffFileLink) : `<p class="code-muted">Loading…</p>`}</section>`;
}

// ---------- diff overlay ----------

// Splits `git diff` / `git show -p` output into files of numbered lines.
export function parsePatch(patch) {
  const files = [];
  let file = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const start = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (start) { file = { path: start[2], old: start[1], status: "M", binary: false, additions: 0, deletions: 0, lines: [] }; files.push(file); continue; }
    if (!file) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); file.lines.push({ kind: "hunk", text: line }); continue; }
    if (!file.lines.length) {
      if (/ 120000$/.test(line)) file.symlink = true; // git's mode for a symbolic link, on the mode or index line
      if (line.startsWith("new file")) file.status = "A";
      else if (line.startsWith("deleted file")) file.status = "D";
      else if (line.startsWith("rename from ")) { file.status = "R"; file.old = line.slice(12); }
      else if (line.startsWith("Binary files")) file.binary = true;
      continue;
    }
    if (line.startsWith("+")) { file.additions++; file.lines.push({ kind: "add", text: line.slice(1), new: newLine++ }); }
    else if (line.startsWith("-")) { file.deletions++; file.lines.push({ kind: "del", text: line.slice(1), old: oldLine++ }); }
    else if (line.startsWith(" ")) file.lines.push({ kind: "ctx", text: line.slice(1), old: oldLine++, new: newLine++ });
  }
  return files;
}

const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path);
let diffLayout = storage.get("code-diff-layout", "split");
// "single" shows one file and J/K steps through them; "all" stacks every file in one scroll, rendered as it nears view.
let diffView = storage.get("code-diff-view", "single");
// Viewed files drop out of the file list and J/K by default (H toggles); the current file always stays.
let hideViewed = storage.get("code-diff-hide-viewed", "on") === "on";
// "map" swaps the file list for a treemap of the change (T toggles); `zoom` is the folder it is zoomed into.
let fileListMode = storage.get("code-diff-files", "list");
// Move ribbons are drawn only on request (E); the moves list and its highlight carry renames by default.
let mapEdges = storage.get("code-map-edges", "off") === "on";
let mapChrome = 62; // measured height of the bar and moves row above the canvas, so the canvas fills the rest
let mapFull = false; // the map lifted over the whole overlay in a frame you can resize, to pick the image's aspect ratio
let mapPointer = null; // last pointer position over the map, so a redraw under the cursor keeps its hover state
const lineCounts = new Map(); // per diff params: { counts } once loaded, counts null when no local clone could answer
// `pr` turns the overlay into a PR overview: a left column with the PR, its stack, and its commits; `scope` is
// "description", "all" (the whole PR diff) or one commit SHA.
const diff = { params: null, title: "", sub: "", files: null, error: "", index: 0, mode: "diff", texts: new Map(), pr: null, wt: null, local: null, dirs: new Map(), scope: "all", filter: "", collapsed: new Map(), viewed: null, notes: null, zoom: "", move: null };
const patches = new Map(); // parsed diffs by params for one open overlay, so walking commits back and forth refetches nothing
let diffDialog = null;
let lazySections = null;
let jumpedAt = 0;
const ROW_PX = 18; // one unwrapped diff row, for placeholder heights before a section renders
const BIG_FILE = 1500;

const meta = () => ui.data || prIndexData || {};
const prKey = (slug, number) => `${slug}#${number}`;

// GitHub-style "Viewed" for the PR overview, per PR in localStorage. Each mark stores a hash of the file's diff, so a
// file that changes after it was viewed comes back unviewed.
function hashText(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index++) hash = (hash * 33 + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}
const fileSig = (file) => (file.sig ||= hashText(file.lines.map((line) => line.kind[0] + line.text).join("\n")));
// The overview's subject: a PR ({ slug, number, key }) or a worktree browsed like one ({ path, key: "wt:<path>" }).
const subject = () => diff.pr || diff.wt;
function viewedMap() {
  const current = subject();
  if (!current) return null;
  if (diff.viewed?.key !== current.key) {
    let map = {};
    try { map = JSON.parse(localStorage.getItem(`code-pr-viewed:${current.key}`) || "{}"); } catch {}
    diff.viewed = { key: current.key, map };
  }
  return diff.viewed.map;
}
const isViewed = (file) => Boolean(subject()) && viewedMap()[file.path] === fileSig(file);
function toggleViewed(file) {
  const map = viewedMap();
  if (!map) return false;
  if (isViewed(file)) delete map[file.path]; else map[file.path] = fileSig(file);
  diff.collapsed.delete(file.path); // collapse follows Viewed again until toggled by hand
  storage.set(`code-pr-viewed:${subject().key}`, JSON.stringify(map));
  return isViewed(file);
}
// Lockfiles, snapshots, minified and vendored output start collapsed in "All files".
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|uv\.lock|poetry\.lock|Cargo\.lock|go\.sum)$|\.min\.(js|css)$|\.snap$|(^|\/)(vendor|__snapshots__)\//;
const isGenerated = (file) => GENERATED.test(file.path);
const isCollapsed = (file) => diff.collapsed.get(file.path) ?? (isViewed(file) || isGenerated(file));

function diffRegion(name, html) {
  const element = diffDialog.querySelector(`[data-d="${name}"]`);
  if (lastHtml.get(element) === html) return null;
  lastHtml.set(element, html);
  element.innerHTML = html;
  return element;
}

// The open overview lives in the URL (?pr=owner/repo#n or ?wt=<path>) so a refresh reopens it.
function syncOverviewUrl(kind = "", value = "") {
  const url = new URL(location.href);
  url.searchParams.delete("pr");
  url.searchParams.delete("wt");
  url.searchParams.delete("file");
  url.searchParams.delete("scope");
  if (kind) url.searchParams.set(kind, value);
  history.replaceState(history.state, "", url);
}

// The current file and scope ride along with ?pr= / ?wt=, so a refresh reopens the same view.
function syncViewUrl() {
  if (!subject() || (!diff.files && !isDocScope())) return;
  const url = new URL(location.href);
  const file = isDocScope() ? "" : diff.files?.[diff.index]?.path || "";
  for (const [name, value] of [["file", file], ["scope", diff.scope === "all" ? "" : diff.scope]]) value ? url.searchParams.set(name, value) : url.searchParams.delete(name);
  if (url.href !== location.href) history.replaceState(history.state, "", url);
}

function ensureDiffDialog() {
  if (diffDialog) return;
  diffDialog = Object.assign(document.body.appendChild(document.createElement("dialog")), { className: "code-diff", tabIndex: -1 });
  diffDialog.innerHTML = `<header class="code-diff-head" data-d="head"></header><div class="code-diff-split"><aside class="code-diff-pr" data-d="pr"></aside><div class="code-diff-files"><div class="code-diff-filter-row"><label class="code-filter code-diff-filter"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.75"/><path d="m10.5 10.5 3 3"/></svg><input type="search" data-diff-filter placeholder="Filter files  /" spellcheck="false" autocomplete="off"></label><button type="button" class="code-diff-hide" data-diff-hide></button><span data-d="listmode"></span></div><div data-d="files"></div></div><div class="code-diff-main"><div data-d="filehead"></div><div class="code-diff-body" data-d="body"></div></div></div><button type="button" class="code-note-add" data-note-new hidden>${icon("comment")}Comment <kbd>C</kbd></button><div class="code-note-composer" hidden><div class="code-note-where"><b data-composer-where></b><span class="code-muted">saved to plans/pr-notes</span></div><blockquote></blockquote><textarea rows="2" placeholder="Note for this PR" spellcheck="true"></textarea><div class="code-note-buttons"><button type="button" class="code-bar-button" data-note-cancel>Cancel</button><button type="button" class="code-bar-button is-primary" data-note-save>Save <kbd>⌘↵</kbd></button></div></div>`;
  const body = diffDialog.querySelector('[data-d="body"]');
  // While selecting, the other side of a split diff can't be selected, so a drag down one column stays in it.
  body.addEventListener("mousedown", (event) => {
    if (startPick(event)) return;
    const table = event.target.closest?.(".code-diff-split-table");
    if (table) table.dataset.selecting = event.target.closest("td[data-l]")?.dataset.l.split(":")[0] || "";
  });
  body.addEventListener("mouseup", () => setTimeout(showNoteButton));
  document.addEventListener("selectionchange", () => { if (getSelection().isCollapsed && diffDialog?.open) diffDialog.querySelector("[data-note-new]").hidden = true; });
  const composerText = diffDialog.querySelector(".code-note-composer textarea");
  composerText.addEventListener("input", () => sizeComposer(composerText));
  composerText.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!composerText.value.trim()) closeComposer(); }
  });
  lazySections = new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting) renderSection(entry.target); }, { root: body, rootMargin: "1200px 0px" });
  // Scroll spy for "all": the file whose section crosses the top is the current one in the file list.
  let frame = 0;
  body.addEventListener("scroll", () => {
    if (diffView !== "all" || frame || Date.now() - jumpedAt < 400) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const top = body.getBoundingClientRect().top + 8;
      let current = 0;
      // ponytail: linear scan of section tops per frame; binary search if PRs with thousands of files feel slow.
      for (const section of body.querySelectorAll("[data-diff-section]")) { if (section.getBoundingClientRect().top <= top) current = Number(section.dataset.diffSection); else break; }
      if (current !== diff.index) { diff.index = current; renderDiffFiles(); }
    });
  }, { passive: true });
  // The close event is queued, so a quick close-and-reopen (⌘K, a stack row) must not clear the PR that just opened.
  diffDialog.addEventListener("close", () => { if (diffDialog.open) return; if (subject()) { document.dispatchEvent(new CustomEvent("overview-closed", { detail: location.href })); syncOverviewUrl(); } diff.pr = diff.wt = null; diffDialog.querySelector(".code-note-composer").hidden = diffDialog.querySelector("[data-note-new]").hidden = true; });
  diffDialog.addEventListener("cancel", (event) => { // Esc keeps a typed note, and first shrinks an expanded map
    if (composerDirty()) event.preventDefault();
    else if (mapFull && fileListMode === "map") { event.preventDefault(); toggleMapFull(); }
  });
  const fileRegion = diffDialog.querySelector('[data-d="files"]');
  fileRegion.addEventListener("pointerover", mapHover);
  fileRegion.addEventListener("pointerleave", mapHover);
  let resizeFrame = 0; // dragging the expanded map's corner relays it out once per frame
  new ResizeObserver(() => {
    if (fileListMode !== "map" || !diffDialog.open || !diff.files?.length || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; renderDiffFiles(); });
  }).observe(fileRegion);
  const filter = diffDialog.querySelector("[data-diff-filter]");
  filter.addEventListener("input", () => { diff.filter = filter.value; renderDiffFiles(); });
  filter.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && filter.value) { event.preventDefault(); filter.value = diff.filter = ""; renderDiffFiles(); }
    else if (event.key === "Escape" || event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault();
      const first = diffDialog.querySelector('[data-d="files"] [data-diff-file]');
      if (event.key !== "Escape" && first) focusFile(Number(first.dataset.diffFile));
      diffDialog.focus({ preventScroll: true });
    }
  });
  // A drag that starts inside (resizing the map, selecting text) and ends outside clicks the dialog itself; only a
  // press that also began on the backdrop closes it.
  let pressedBackdrop = false;
  diffDialog.addEventListener("pointerdown", (event) => { pressedBackdrop = event.target === diffDialog; });
  diffDialog.addEventListener("click", (event) => {
    if (event.target === diffDialog) return composerDirty() || !pressedBackdrop ? null : diffDialog.close();
    const commitPr = event.target.closest("[data-commit-pr]");
    if (commitPr) { const [slug, number] = commitPr.dataset.commitPr.split("#"); return openPrOverlay(slug, Number(number)); }
    const noteButton = event.target.closest("[data-note-file], [data-note-new], [data-note-save], [data-note-cancel], [data-note-edit], [data-note-delete], [data-note-jump]");
    if (noteButton) {
      const { dataset } = noteButton;
      if (dataset.noteFile) noteOnFile(Number(dataset.noteFile));
      else if ("noteNew" in dataset) { const target = selectedLines(); if (target) openComposer(target); }
      else if ("noteSave" in dataset) saveComposer();
      else if ("noteCancel" in dataset) closeComposer();
      else if (dataset.noteEdit) openComposer(null, prNotes().find((note) => note.id === dataset.noteEdit));
      else if (dataset.noteDelete) changeNote({ op: "delete", id: dataset.noteDelete });
      else if (dataset.noteJump) jumpToNote(dataset.noteJump);
      return;
    }
    if (event.target.closest("[data-code-skill], [data-code-open], [data-code-session], [data-code-preview], [data-code-run], [data-code-stop-run]")) return handleClick(event);
    const button = event.target.closest("[data-diff-hide], [data-diff-list], [data-map-zoom], [data-map-move], [data-map-edges], [data-map-export], [data-map-full], [data-diff-viewed], [data-diff-collapse], [data-diff-local-dir], [data-diff-file], [data-diff-mode], [data-diff-layout], [data-diff-view], [data-diff-scope], [data-diff-pr], [data-diff-wt], [data-diff-local], [data-diff-load], [data-diff-close], [data-code-copy]");
    if (!button) return;
    const { dataset } = button;
    if ("diffHide" in dataset) return toggleHideViewed();
    if (dataset.diffList) return setFileListMode(dataset.diffList);
    if ("mapZoom" in dataset) { diff.zoom = dataset.mapZoom; return renderDiffFiles(); }
    if (dataset.mapMove) return pinMove(Number(dataset.mapMove));
    if ("mapEdges" in dataset) return toggleEdges();
    if ("mapFull" in dataset) return toggleMapFull();
    if (dataset.mapExport) return exportMap(button, dataset.mapExport);
    if (dataset.diffViewed) { toggleViewed(diff.files[Number(dataset.diffViewed)]); return renderDiff(); }
    if (dataset.diffCollapse) {
      const file = diff.files[Number(dataset.diffCollapse)];
      diff.collapsed.set(file.path, !isCollapsed(file));
      return renderDiff();
    }
    if (dataset.codeCopy !== undefined) return copy(button, dataset.codeCopy);
    if ("diffClose" in dataset) return diffDialog.close();
    if (dataset.diffPr) { const [slug, number] = dataset.diffPr.split("#"); return openPrOverlay(slug, Number(number)); }
    if (dataset.diffWt) return openWorktreeOverlay(dataset.diffWt);
    if (dataset.diffLocal !== undefined) return openLocalFile(dataset.diffLocal, dataset.kind);
    if (dataset.diffLocalDir) return toggleLocalDir(dataset.diffLocalDir);
    if (dataset.diffScope) return selectScope(dataset.diffScope);
    if (dataset.diffLoad) return renderSection(button.closest("[data-diff-lazy]"), true);
    if (dataset.diffMode) diff.mode = dataset.diffMode;
    if (dataset.diffLayout) { diffLayout = dataset.diffLayout; storage.set("code-diff-layout", diffLayout); }
    if (dataset.diffView) { diffView = dataset.diffView; storage.set("code-diff-view", diffView); }
    if (dataset.mapTile) diff.move = dataset.move === undefined ? null : Number(dataset.move); // selecting a renamed file keeps its move lit
    if (dataset.diffFile) return focusFile(Number(dataset.diffFile));
    renderDiff();
    if (dataset.diffView) scrollToFile();
  });
  diffDialog.addEventListener("pointerover", (event) => { const target = event.target.closest("[data-tip]"); if (target) showTip(target); else hideTip(); });
  diffDialog.addEventListener("pointerleave", hideTip);
  diffDialog.addEventListener("keydown", (event) => {
    if (isSummonKey(event)) return; // H and ⌘K open Recently viewed and search above the overlay
    event.stopPropagation(); // keep the page's J/K and other global shortcuts out of the overlay
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !diffDialog.querySelector(".code-note-composer").hidden) { event.preventDefault(); return saveComposer(); }
    if (event.metaKey || event.ctrlKey || event.altKey || event.target.closest?.("input, textarea")) return;
    const key = event.key.toLowerCase();
    const step = { j: 1, arrowdown: 1, k: -1, arrowup: -1 }[key];
    const commitStep = { n: 1, p: -1 }[key];
    if (step && diff.files?.length && !isDocScope()) stepFile(step);
    else if (commitStep && subject()) stepScope(commitStep);
    else if (key === "x" && subject() && diff.files?.[diff.index]) markViewedAndAdvance();
    else if (key === "/") diffDialog.querySelector("[data-diff-filter]").focus();
    else if (key === "u" && subject()) toggleHideViewed();
    else if (key === "e" && fileListMode === "map") toggleEdges();
    else if (key === "f" && fileListMode === "map") toggleMapFull();
    else if (key === "t") setFileListMode(fileListMode === "map" ? "list" : "map");
    else if (event.key === "Backspace" && fileListMode === "map" && diff.zoom) { diff.zoom = diff.zoom.includes("/") ? diff.zoom.slice(0, diff.zoom.lastIndexOf("/")) : ""; renderDiffFiles(); }
    else if ((key === "[" || key === "]") && diff.pr) stepStack(key === "]" ? 1 : -1);
    else if (event.key === "D" && diffDialog.querySelector('nav.code-diff-scopes [data-diff-scope="description"]')) selectScope("description");
    else if (event.key === "d" && subject()) cycleMainView();
    else if (key === "c" && diff.pr && !isDocScope() && diff.files?.[diff.index]) selectedLines() ? openComposer(selectedLines()) : noteOnFile(diff.index); // no selection: a note on the whole current file
    else if (/^[1-9]$/.test(key) && diffDialog.querySelectorAll(".code-side-skills [data-code-skill]")[key - 1]) diffDialog.querySelectorAll(".code-side-skills [data-code-skill]")[key - 1].click();
    else if (key === "w" && diffDialog.querySelector(diff.pr ? ".code-side-facts [data-diff-wt]" : ".code-side-facts [data-diff-pr]")) diffDialog.querySelector(diff.pr ? ".code-side-facts [data-diff-wt]" : ".code-side-facts [data-diff-pr]").click();
    else if (key === "v") { diffView = diffView === "all" ? "single" : "all"; storage.set("code-diff-view", diffView); renderDiff(); scrollToFile(); }
    else if (key === "m" && diffView === "single") { diff.mode = diff.mode === "rendered" ? "diff" : "rendered"; renderDiff(); }
    else if (key === "s") { diffLayout = diffLayout === "split" ? "unified" : "split"; storage.set("code-diff-layout", diffLayout); renderDiff(); }
    else return;
    event.preventDefault();
  });
}

// The two keys that reach the page from inside any overlay: ⌘K (search) and a bare H (Recently viewed).
export function isSummonKey(event) {
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) return key === "k";
  return key === "h" && !event.altKey && !event.shiftKey && !event.target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}

function showDiffDialog() {
  renderDiff();
  if (diffDialog.open) return;
  diffDialog.showModal();
  diffDialog.focus({ preventScroll: true }); // showModal focuses the first link, which draws a focus ring on the title
}

function resetDiffView() {
  diff.filter = "";
  diff.zoom = "";
  diff.move = null;
  diff.collapsed = new Map();
  const filter = diffDialog.querySelector("[data-diff-filter]");
  if (filter) filter.value = "";
}

// Space-free review loop: mark the current file viewed and move to the next one not yet viewed.
function markViewedAndAdvance() {
  const viewed = toggleViewed(diff.files[diff.index]);
  const next = viewed ? visibleFileIndexes().find((index) => index > diff.index && !isViewed(diff.files[index])) : undefined;
  if (next !== undefined) focusFile(next); else renderDiff();
}

async function loadPatch() {
  const params = diff.params;
  const key = JSON.stringify(params);
  diff.error = "";
  if (patches.has(key)) { diff.files = patches.get(key); return renderDiff(); }
  diff.files = null;
  renderDiff();
  try {
    const response = await fetch(`/api/code/diff?${new URLSearchParams(params)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load the diff.");
    const files = treeWalk(parsePatch(body.patch)).filter((row) => row.file).map((row) => row.file); // tree order, so J/K follows the list
    if (params.source !== "worktree") patches.set(key, files);
    if (diff.params === params) diff.files = files;
  } catch (error) {
    if (diff.params === params) { diff.files = []; diff.error = error.message.split("\n")[0]; }
  }
  if (diff.params === params) renderDiff();
}

async function openDiff(file = "", target = diffTarget()) {
  if (!target) return;
  ensureDiffDialog();
  loadHighlighter();
  if (!diffDialog.open) patches.clear();
  if (subject()) syncOverviewUrl();
  const same = !subject() && JSON.stringify(diff.params) === JSON.stringify(target.params);
  if (!same) resetDiffView();
  Object.assign(diff, target, { pr: null, wt: null, scope: "all", mode: "diff" }, same ? {} : { files: null, index: 0, texts: new Map() });
  showDiffDialog();
  if (!diff.files) await loadPatch();
  if (file) focusFile(Math.max(0, diff.files.findIndex((candidate) => candidate.path === file)));
}

// ---------- PR overlay ----------

let prIndexData = null;
let prIndexLoad = null;
// Every tracked PR (open ones with CI and reviews, then history) from the server's disk-backed cache; never waits on GitHub.
export function loadPrIndex() {
  prIndexLoad ||= fetch("/api/code/pr-index").then((response) => response.json()).then((data) => { prIndexData = data; return data; }).finally(() => { prIndexLoad = null; });
  return prIndexLoad;
}
export const cachedPrIndex = () => prIndexData;

// Warms the server's PR caches for a PR the user is pointing at, so opening the overview doesn't wait on `gh`.
// Debounced, so J/K through a list or arrowing through ⌘K only warms the PR the selection settles on.
const prefetched = new Set();
let prefetchTimer = 0;
export function prefetchPr(slug, number) {
  window.clearTimeout(prefetchTimer);
  const key = prKey(slug, number);
  if (prefetched.has(key)) return;
  prefetchTimer = window.setTimeout(() => {
    prefetched.add(key);
    fetch(`/api/code/pr?${new URLSearchParams({ slug, number })}`).catch(noop);
    fetch(`/api/code/diff?${new URLSearchParams({ source: "pr", slug, number })}`).catch(noop);
  }, 250);
}

const openPrList = () => ui.data?.prs || (prIndexData?.prs || []).filter((pr) => pr.state === "OPEN");
const prInfo = (slug, number) => ({
  ...prIndexData?.prs.find((pr) => pr.slug === slug && pr.number === number),
  ...ui.data?.prs.find((pr) => pr.slug === slug && pr.number === number),
  ...ui.detail.get(`pr:${prKey(slug, number)}`),
});

// Opens the PR overview from anywhere (⌘K, the Code page, a ?pr= URL), on the whole PR diff.
export async function openPrOverlay(slug, number, file = "", scope = "all") {
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug) || !Number.isInteger(number)) return;
  if (scope === "stack" && !openPrList().length) await loadPrIndex().catch(noop); // the stack comes from the open PR list
  ensureDiffDialog();
  loadHighlighter();
  if (!diffDialog.open) patches.clear();
  if (!ui.data && !prIndexData) loadPrIndex().then(renderDiff, noop);
  const key = prKey(slug, number);
  if (diff.pr?.key !== key) resetDiffView();
  diff.pr = { slug, number, key };
  diff.wt = null;
  Object.assign(diff, { scope, mode: "diff", params: scopeParams(scope), files: null, index: 0, texts: new Map() });
  syncOverviewUrl("pr", key);
  showDiffDialog();
  loadDetail(`pr:${key}`);
  loadNotes();
  await loadPatch();
  if (file && diff.pr?.key === key) focusFile(Math.max(0, diff.files.findIndex((candidate) => candidate.path === file)));
}

function scopes() {
  if (diff.wt) return ["local", "all", "uncommitted", ...wtCommits().map((commit) => commit.sha)];
  const pr = prInfo(diff.pr.slug, diff.pr.number);
  return ["description", "all", ...(pr.commits || []).map((commit) => commit.sha)];
}

// Description (PR) and Local files (worktree) keep the "All changes" files in the file column.
const isDocScope = () => diff.scope === "description" || diff.scope === "local";

function scopeParams(scope) {
  if (diff.wt) {
    const { path } = diff.wt;
    if (scope === "uncommitted") return { source: "worktree", path };
    if (scope === "all" || scope === "local") return { source: "branch", path };
    const detail = ui.detail.get(`tree:${path}`);
    return { source: "commit", repo: detail?.tree?.repo || path, ...(detail?.slug ? { slug: detail.slug } : {}), sha: scope };
  }
  const { slug, number } = diff.pr;
  if (scope === "stack") {
    const { stack } = prStack();
    if (stack.length > 1) return { source: "stack", slug, number: stack[stack.length - 1].number, base: stack[0].base, head: stack[stack.length - 1].branch };
    scope = diff.scope = "all"; // not (or no longer) stacked
  }
  return scope === "all" || scope === "description" ? { source: "pr", slug, number } : { source: "commit", name: slug.split("/")[1], slug, sha: scope };
}

function selectScope(scope) {
  if (!subject() || scope === diff.scope) return;
  const params = scopeParams(scope);
  diff.scope = scope;
  if (JSON.stringify(params) === JSON.stringify(diff.params)) return renderDiff();
  Object.assign(diff, { params, files: null, index: 0, texts: new Map(), zoom: "", move: null });
  loadPatch();
}

function stepScope(step) {
  const list = scopes();
  selectScope(list[Math.max(0, Math.min(list.length - 1, list.indexOf(diff.scope) + step))]);
  diffDialog.querySelector('.code-diff-scopes [aria-current="true"]')?.scrollIntoView({ block: "nearest" });
}

const CI_LABELS = { SUCCESS: ["pass", "Checks passing"], FAILURE: ["fail", "Checks failing"], ERROR: ["fail", "Checks errored"], PENDING: ["pending", "Checks running"], EXPECTED: ["pending", "Checks expected"] };

// The overlay's left column opens with one label/value grid: facts first, then a row per set of actions.
const sideFacts = (rows) => `<dl class="code-side-facts">${rows.filter(([, value]) => value).map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("")}</dl>`;
const sideStatus = (kind, glyph, text, tip = "") => `<span class="code-side-status code-side-${kind}"${tip ? ` data-tip="${escapeHtml(tip)}"` : ""}>${icon(glyph)}${text}</span>`;
const sideHead = (title, meta = "", tools = "") => `<header class="code-side-head"><h4>${title}${meta ? ` <span>${meta}</span>` : ""}</h4>${tools}</header>`;
const sideViews = (buttons) => `<nav class="code-diff-scopes code-side-views">${buttons}</nav>`;
const scopeCommits = (commits) => `<ol class="code-diff-scopes code-diff-commits">${commits.map((commit, index) => `<li>${scopeButton(commit.sha, `<b>${index + 1}</b><span>${escapeHtml(commit.subject)}</span>`, `<code>${commit.sha.slice(0, 7)}</code>`)}</li>`).join("")}</ol>`;

function prStatus(pr) {
  const ci = CI_LABELS[pr.ci];
  const by = (state) => (pr.reviews || []).filter((review) => review.state === state).map((review) => review.login).join(", ");
  const review = {
    APPROVED: ["pass", "approved", "Approved", by("APPROVED") && `Approved by ${by("APPROVED")}`],
    CHANGES_REQUESTED: ["fail", "diff", "Changes requested", by("CHANGES_REQUESTED") && `Changes requested by ${by("CHANGES_REQUESTED")}`],
    REVIEW_REQUIRED: ["quiet", "review", "Needs review"],
  }[pr.reviewDecision];
  return [
    { MERGED: sideStatus("merged", "branch", "Merged"), CLOSED: sideStatus("quiet", "fail", "Closed") }[pr.state] || "",
    pr.draft ? sideStatus("quiet", "draft", "Draft") : "",
    ci ? sideStatus(ci[0], ci[0], ci[1]) : "",
    review && (!pr.state || pr.state === "OPEN") ? sideStatus(...review) : "",
    pr.mergeable === "CONFLICTING" ? sideStatus("fail", "conflict", "Conflicts") : "",
  ].join("");
}

// The state is a color and a mark, named on hover: requested is quiet, approved green, changes red.
const REVIEW_MARK = { approved: "pass", "changes requested": "fail" };
// People by name; bots (Copilot and the like) shrink to their avatar, named on hover.
function prReviewers(pr) {
  const seen = new Set();
  const people = [...(pr.reviews || []).map((review) => [review.login, review.state.toLowerCase().replace("_", " ")]), ...(pr.reviewers || []).map((login) => [login, "requested"])]
    .filter(([login]) => !seen.has(login) && seen.add(login));
  return people.map(([login, state]) => /copilot|\[bot\]$/i.test(login)
    ? `<span class="code-reviewer is-bot" data-tip="${escapeHtml(`${login} ${state}`)}">${avatar(login)}</span>`
    : `<span class="code-reviewer code-reviewer-${state.replace(" ", "-")}" data-tip="${escapeHtml(`${login} ${state}`)}">${avatar(login)}${escapeHtml(login)}${REVIEW_MARK[state] ? icon(REVIEW_MARK[state]) : ""}</span>`).join("");
}

// Skills as icons in one row; 1–9 press them from anywhere in the overlay.
const sideSkills = (pr, workspace, tree) => `<span class="code-side-skills">${skillButtons(pr, workspace, tree)}</span>`;

// ---------- worktree overview ----------

// A worktree browsed like a PR: everything since main as "All changes", plus what only exists on this disk.
export async function openWorktreeOverlay(path, file = "", scope = "all") {
  if (!path) return;
  ensureDiffDialog();
  loadHighlighter();
  if (!diffDialog.open) patches.clear();
  const key = `wt:${path}`;
  if (diff.wt?.key !== key) resetDiffView();
  diff.wt = { path, key };
  diff.pr = null;
  diff.local = null;
  diff.dirs = new Map();
  diff.scope = scope;
  Object.assign(diff, { mode: "diff", params: scopeParams(scope), files: null, index: 0, texts: new Map() });
  syncOverviewUrl("wt", path);
  showDiffDialog();
  ui.detail.delete(`tree:${path}`); // local files change underfoot, so every open rescans them
  loadDetail(`tree:${path}`);
  await loadPatch();
  if (file && diff.wt?.key === key) focusFile(Math.max(0, diff.files.findIndex((candidate) => candidate.path === file)));
}

// Commits not on main, oldest first, so N/P walks them in the order they were made.
const wtCommits = () => [...(ui.detail.get(`tree:${diff.wt?.path}`)?.commits || [])].reverse();

const scopeButton = (scope, label, extra = "") => `<button type="button" class="code-diff-scope" data-diff-scope="${escapeHtml(scope)}" aria-current="${diff.scope === scope}">${label}${extra}</button>`;
const countLabel = (value) => (value === null || value === undefined ? "" : ` <span class="code-muted">${value.toLocaleString()}</span>`);

function wtColumn() {
  const { path } = diff.wt;
  const detail = ui.detail.get(`tree:${path}`);
  const tree = ui.data?.worktrees.find((candidate) => candidate.path === path) || detail?.tree;
  if (!tree) return `<p class="code-muted">${ui.detailErrors.has(`tree:${path}`) ? "Couldn't load this worktree." : "Loading…"}</p>`;
  const pr = detail?.pr || (ui.data ? prFor(tree) : null);
  const branchFiles = patches.get(JSON.stringify({ source: "branch", path }));
  const commits = wtCommits();
  const prValue = pr
    ? `<button type="button" class="code-side-pr" data-diff-pr="${escapeHtml(prKey(pr.slug, pr.number))}" data-tip="Open the pull request (W)">${ciBadge(pr)}<b>#${pr.number}</b><span>${escapeHtml(pr.title || "")}</span></button>${{ MERGED: sideStatus("merged", "branch", "Merged"), CLOSED: sideStatus("quiet", "fail", "Closed") }[pr.state] || ""}`
    : `<span class="code-muted">None for this branch</span>`;
  const local = detail ? detail.untrackedCount + detail.ignoredCount : null;
  return sideFacts([
    ["Path", `<button type="button" class="code-path code-side-path" data-code-copy="${escapeHtml(path)}" data-tip="${escapeHtml(path)} · click to copy">${escapeHtml(shortPath(path))}</button>`],
    ["Status", tree.main ? "Main checkout" : `<span data-tip="Commits ahead of and behind origin/main">↑${tree.ahead ?? "?"} ↓${tree.behind ?? "?"} vs main</span>${tree.activity ? `<span class="code-muted">changed ${when(tree.activity)} ago</span>` : ""}`],
    ["PR", prValue],
    [appName(), pr?.state === "OPEN" && pr.url ? sideSkills(pr, tree.path, tree) : ""],
    ["Open", `<span class="code-side-tools">${treeActions(tree)}</span>`],
  ])
    + sideViews(`${scopeButton("local", "Local", countLabel(local))}${scopeButton("all", "Changes", countLabel(branchFiles?.length))}${scopeButton("uncommitted", "Uncommitted", countLabel(tree.dirty))}`)
    + `<section>${sideHead(tree.main ? "Recent commits" : "Commits", detail ? `${commits.length}${tree.main ? "" : ` not on ${escapeHtml(detail.base || "main")}`}` : "")}${!detail ? `<p class="code-muted">Loading…</p>` : !commits.length ? `<p class="code-muted">None. Everything committed here is on main.</p>` : scopeCommits(commits)}</section>`;
}

// Everything on this disk that no PR or commit would carry: untracked files and folders, and ignored files that look
// hand-made (dependency and build caches are left out by the server).
function localFilesBody() {
  const detail = ui.detail.get(`tree:${diff.wt.path}`);
  if (!detail) return `<p class="code-muted">${ui.detailErrors.has(`tree:${diff.wt.path}`) ? "Couldn't scan this worktree." : "Scanning local files…"}</p>`;
  if (diff.local) {
    const { path, text } = diff.local;
    const content = text === null ? `<p class="code-muted">Loading…</p>`
      : text.error ? `<p class="work-warning code-diff-error">${escapeHtml(text.error)}</p>`
      : isMarkdown(path) ? `<div class="markdown code-diff-markdown">${renderMarkdown(text)}</div>`
      : `<pre class="code-local-text">${escapeHtml(text)}</pre>`;
    return `<div class="code-diff-file-head"><button type="button" class="code-more" data-diff-local="">← Local files</button><b>${escapeHtml(path)}</b>${copyButton(path, "Copy path")}<span class="code-spacer"></span><span class="code-muted">ignored · not in git</span></div>${content}`;
  }
  const rows = [...detail.untracked.map((item) => ({ ...item, kind: "untracked" })), ...detail.ignored.map((item) => ({ ...item, kind: "ignored" }))];
  if (!rows.length) return `<p class="code-muted code-local-empty">Nothing local-only. Every file here is tracked by git, or is a dependency or build cache.</p>`;
  const more = (shown, total, label) => (total > shown ? ` Showing ${shown} of ${total.toLocaleString()} ${label}.` : "");
  const status = (kind) => (kind === "untracked" ? "Untracked" : "Ignored");
  const fileRow = (item, kind, nested = false) => `<tr class="${nested ? "is-nested" : ""}"><td>${fileType(item.path)}<button type="button" class="code-local-link" data-diff-local="${escapeHtml(item.path)}" data-kind="${kind}" title="${escapeHtml(item.path)}">${escapeHtml(nested ? item.path.slice(nested.length) : item.path)}</button></td><td>${status(kind)}</td><td></td><td>${bytes(item.bytes)}</td><td>${item.newest ? `${when(item.newest)} ago` : ""}</td></tr>`;
  const row = (item) => {
    if (!item.path.endsWith("/")) return fileRow(item, item.kind);
    const open = diff.dirs.get(item.path);
    const head = `<tr><td>${fileType(item.path)}<button type="button" class="code-local-link code-local-dir" data-diff-local-dir="${escapeHtml(item.path)}" aria-expanded="${Boolean(open)}">${escapeHtml(item.path)}</button></td><td>${status(item.kind)}</td><td>${item.files.toLocaleString()}</td><td>${item.truncated ? "≥ " : ""}${bytes(item.bytes)}</td><td>${item.newest ? `${when(item.newest)} ago` : ""}</td></tr>`;
    if (!open) return head;
    if (open === "loading" || open.error) return `${head}<tr class="is-nested"><td colspan="5" class="code-muted">${open.error ? escapeHtml(open.error) : "Loading…"}</td></tr>`;
    const capped = open.total > open.files.length ? `<tr class="is-nested"><td colspan="5" class="code-muted">Newest ${open.files.length} of ${open.total.toLocaleString()} files.</td></tr>` : "";
    return head + open.files.map((file) => fileRow({ ...file, path: file.path }, item.kind, item.path)).join("") + capped;
  };
  return `<div class="code-local">
    <p class="code-muted">Files on this disk that no commit carries. Untracked files are also in All changes; ignored ones exist only here, and removing the worktree deletes them.${more(detail.untracked.length, detail.untrackedCount, "untracked")}${more(detail.ignored.length, detail.ignoredCount, "ignored")}</p>
    <table class="code-local-table"><thead><tr><th>Path</th><th>Status</th><th>Files</th><th>Size</th><th>Modified</th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table></div>`;
}

// A folder row expands to its files, newest first, each of which opens like a top-level file.
async function toggleLocalDir(dir) {
  if (diff.dirs.has(dir)) { diff.dirs.delete(dir); return renderDiff(); }
  const wtPath = diff.wt.path;
  diff.dirs.set(dir, "loading");
  renderDiff();
  try {
    const response = await fetch(`/api/code/local-dir?${new URLSearchParams({ path: wtPath, dir })}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not list the folder.");
    if (diff.wt?.path === wtPath && diff.dirs.has(dir)) diff.dirs.set(dir, body);
  } catch (error) {
    if (diff.wt?.path === wtPath && diff.dirs.has(dir)) diff.dirs.set(dir, { error: error.message });
  }
  if (diff.wt?.path === wtPath) renderDiff();
}

// An untracked file opens in its diff; an ignored one opens read-only in place.
async function openLocalFile(path, kind) {
  if (!path) { diff.local = null; return renderDiff(); }
  if (kind === "untracked") {
    diff.scope = "all";
    return focusFile(Math.max(0, diff.files?.findIndex((file) => file.path === path) ?? 0));
  }
  const wtPath = diff.wt.path;
  diff.local = { path, text: null };
  renderDiff();
  try {
    const response = await fetch(`/api/code/file?${new URLSearchParams({ source: "worktree", path: wtPath, file: path })}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not read the file.");
    if (diff.local?.path === path) diff.local.text = body.text;
  } catch (error) {
    if (diff.local?.path === path) diff.local.text = { error: error.message };
  }
  if (diff.wt?.path === wtPath) renderDiff();
}

// The open PR's stack, bottom (on main) first; [ and ] step down and up it.
function prStack() {
  const list = openPrList();
  const current = diff.pr && list.find((item) => item.slug === diff.pr.slug && item.number === diff.pr.number);
  return { stack: current ? stackOf(current, list) : [], current };
}

// d cycles the views listed above the commits (Description and All changes; Local files, All changes and
// Uncommitted in a worktree). From a commit it starts at the first.
function cycleMainView() {
  const views = [...diffDialog.querySelectorAll("nav.code-diff-scopes [data-diff-scope]")].map((button) => button.dataset.diffScope);
  if (views.length) selectScope(views[(views.indexOf(diff.scope) + 1) % views.length]);
}

function stepStack(step) {
  const { stack, current } = prStack();
  const next = stack[stack.indexOf(current) + step];
  if (stack.length > 1 && next) openPrOverlay(next.slug, next.number);
}

// The PR facts and action rows, shared by the overview's left column and the Code page inspector.
function prFacts(pr, tree, wtPath, overlay = false) {
  const open = pr.url && pr.repo && (!pr.state || pr.state === "OPEN"); // the Code page list holds only open PRs, without a state
  return sideFacts([
    ["Status", prStatus(pr)],
    ["Author", pr.author ? `<span class="code-side-person">${avatar(pr.author)}${escapeHtml(pr.author)}</span>${pr.createdAt ? `<span class="code-muted" data-tip="Opened ${escapeHtml(new Date(pr.createdAt).toLocaleString())}${pr.updatedAt ? ` · updated ${escapeHtml(new Date(pr.updatedAt).toLocaleString())}` : ""}">${ago(pr.updatedAt || pr.createdAt)} ago</span>` : ""}` : ""],
    ["Branch", pr.branch ? `${branchChip(pr.branch)}${pr.base ? `<span class="code-muted code-side-base" data-tip="Merges into ${escapeHtml(pr.base)}">→ ${escapeHtml(pr.base)}</span>` : ""}` : ""],
    ["Size", pr.additions !== undefined ? `<span class="code-side-size">${sizeBar(pr)}<span class="code-add">+${pr.additions}</span><span class="code-del">−${pr.deletions}</span></span>${labelDots(pr)}` : ""],
    ["Reviews", prReviewers(pr)],
    [appName(), open ? sideSkills(pr, tree?.path || pr.repo, tree) : ""],
    ["Local", wtPath ? `<span class="code-side-tools">${iconButton("branch", `Worktree overview${overlay ? " (W)" : ""}`, `data-diff-wt="${escapeHtml(wtPath)}"`)}${tree ? treeActions(tree) : ""}</span>` : open && ui.data ? `<span class="code-side-tools">${runButton(pr.repo, null, pr.branch)}</span><span class="code-muted">Not checked out</span>` : ""],
  ]);
}

function prColumn() {
  const { slug, number, key } = diff.pr;
  const pr = prInfo(slug, number);
  const detail = ui.detail.get(`pr:${key}`);
  const tree = ui.data && pr.branch ? worktreeFor(pr) : null;
  const { stack, current } = prStack();
  const commits = detail?.commits;
  const allFiles = patches.get(JSON.stringify({ source: "pr", slug, number })); // gh pr view caps its file list at 100
  const wtPath = tree?.path || detail?.worktree;
  const stackTip = stack.length > 1 ? `Every PR in the stack, #${stack[0].number}–#${stack[stack.length - 1].number}, against ${stack[0].base}` : "";
  return prFacts(pr, tree, wtPath, true)
    + sideViews(`${detail?.body ? scopeButton("description", "Description") : ""}${scopeButton("all", "Changes", countLabel(allFiles?.length))}${stack.length > 1 ? scopeButton("stack", `<span data-tip="${escapeHtml(stackTip)}">Stack</span>`, countLabel(stack.length)) : ""}`)
    + notesSection(pr, tree?.path || pr.repo || "")
    + `<section>${sideHead("Commits", commits ? String(commits.length) : "")}${!commits ? `<p class="code-muted">${ui.detailErrors.has(`pr:${key}`) ? "Couldn't load commits." : "Loading…"}</p>` : scopeCommits(commits)}</section>`
    + (stack.length > 1 ? `<section>${sideHead("Stack", `${stack.indexOf(current) + 1} of ${stack.length} · on ${escapeHtml(stack[0].base)}`)}<ol class="code-stack-list code-diff-stack">${stack.map((item, index) => `<li class="${item === current ? "is-current" : ""}"><button type="button" class="code-diff-stack-row" data-diff-pr="${escapeHtml(prKey(item.slug, item.number))}" ${item === current ? 'aria-current="true"' : ""}><b class="code-stack-n">${index + 1}</b><span class="code-diff-stack-item">${ciBadge(item)}#${item.number}</span><span>${escapeHtml(item.title)}</span></button></li>`).join("")}</ol></section>` : "");
}

async function loadFileText(file) {
  const key = file.path;
  if (diff.texts.has(key)) return;
  const params = diff.params;
  diff.texts.set(key, null);
  try {
    const response = await fetch(`/api/code/file?${new URLSearchParams({ ...params, file: file.path })}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load the file.");
    if (diff.params === params) diff.texts.set(key, body.text);
  } catch (error) {
    if (diff.params === params) diff.texts.set(key, { error: error.message });
  }
  if (diff.params === params) renderDiff();
}

// ---------- syntax highlighting ----------

// highlight.js (common languages), vendored as one ES module and loaded on the first diff; if it fails, diffs stay plain.
let highlighter = null;
let highlighterLoad = null;
const loadHighlighter = () => highlighterLoad ||= import("./vendor/highlight.js").then((module) => { highlighter = module.default; refreshAllFiles(); }, () => {});

// highlight.js output can open a span on one line and close it lines later; close and reopen it at every line break.
export function splitHighlightedLines(html) {
  const open = [];
  return html.split("\n").map((line) => {
    const prefix = open.join("");
    for (const tag of line.match(/<span[^>]*>|<\/span>/g) || []) tag === "</span>" ? open.pop() : open.push(tag);
    return prefix + line + "</span>".repeat(open.length);
  });
}

const languageFor = (path) => {
  const name = path.split("/").pop().toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : name;
  return highlighter?.getLanguage(ext) ? ext : "";
};
const colorize = (text, language) => splitHighlightedLines(highlighter.highlight(text, { language, ignoreIllegals: true }).value);

// Two passes, storing each line's colors as `html` (context lines take the new side's):
// 1. at once, every hunk of a side joined in order, so a string or comment carries from one hunk into the next;
// 2. then both whole files from the server, so state opened above the first hunk (a docstring, a <style>) is right too.
// PR diffs and files the server can't read keep pass 1.
function highlightFile(file) {
  if (!highlighter || file.highlighted) return;
  const language = languageFor(file.path);
  file.highlighted = true;
  if (!language) return;
  const sides = [["old", (line) => line.kind === "del" || line.kind === "ctx", (line) => line.kind === "del"], ["new", (line) => line.kind === "add" || line.kind === "ctx", () => true]];
  for (const [, keep, assign] of sides) {
    const lines = file.lines.filter(keep);
    const html = colorize(lines.map((line) => line.text).join("\n"), language);
    lines.forEach((line, index) => { if (assign(line)) line.html = html[index]; });
  }
  const params = diff.params;
  fetch(`/api/code/sides?${new URLSearchParams({ ...params, file: file.path, old: file.old || file.path })}`)
    .then((response) => response.ok ? response.json() : null)
    .then((whole) => {
      if (!whole || diff.params !== params) return;
      for (const [side, keep, assign] of sides) {
        if (typeof whole[side] !== "string") continue;
        const html = colorize(whole[side], language);
        const text = whole[side].split("\n");
        // A PR's old side is read at the merge base; a line that doesn't match keeps its hunk-only colors.
        for (const line of file.lines) if (keep(line) && assign(line) && text[line[side] - 1] === line.text) line.html = html[line[side] - 1];
      }
      refreshFile(file);
    }, () => {});
}

// ---------- local review notes ----------

// Select code in a PR diff and press C (or the Comment button) to keep a note in plans/pr-notes/; the PR column lists
// them and drafts an agent prompt that posts them as a pending GitHub review or works through them.
const noteScope = () => (diff.pr && diff.scope !== "all" && diff.scope !== "description" ? diff.scope : "");
const prNotes = () => (diff.pr && diff.notes?.key === diff.pr.key ? diff.notes.list : []);
const noteRange = (note) => (!note.line ? "whole file" : `${note.side} ${note.end > note.line ? `${note.line}–${note.end}` : note.line}`);

async function loadNotes() {
  const pr = diff.pr;
  const response = await fetch(`/api/code/notes?${new URLSearchParams({ slug: pr.slug, number: pr.number })}`).catch(() => null);
  const body = response?.ok ? await response.json() : null;
  if (!body || diff.pr !== pr) return;
  diff.notes = { key: pr.key, path: body.path, list: body.notes };
  refreshAllFiles();
  renderDiff();
}

async function changeNote(change) {
  const { slug, number, key } = diff.pr;
  try {
    const body = await post("notes", { slug, number, title: prInfo(slug, number).title || "", ...change });
    if (diff.pr?.key !== key) return true;
    diff.notes = { key, path: body.path, list: body.notes };
    refreshAllFiles();
    renderDiff();
    return true;
  } catch (error) {
    notify(error.message, true);
    return false;
  }
}

// Notes sit under the last line they cover, in the scope (whole PR or one commit) they were written against.
function noteRow(file, side, line, before, after) {
  if (line === undefined || line === null) return "";
  const scope = noteScope();
  const notes = prNotes().filter((note) => note.file === file.path && note.side === side && note.end === line && note.commit === scope);
  if (!notes.length) return "";
  const cards = notes.map((note) => `<div class="code-note" data-note="${note.id}"><p>${escapeHtml(note.body)}</p><span class="code-note-meta">${note.status === "draft" ? "Local draft" : escapeHtml(note.status)} · ${noteRange(note)}<button type="button" data-note-edit="${note.id}">Edit</button><button type="button" data-note-delete="${note.id}">Delete</button></span></div>`).join("");
  return `<tr class="code-diff-note">${before}${cards}${after}</tr>`;
}

// The selected lines, when the selection starts and ends in code cells of one table and one side.
function selectedLines() {
  const selection = getSelection();
  if (!diff.pr || !selection.rangeCount || selection.isCollapsed) return null;
  const cellOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest("td[data-l]");
  const [first, last] = [cellOf(selection.anchorNode), cellOf(selection.focusNode)];
  if (!first || !last || first.closest("table") !== last.closest("table") || !diffDialog.contains(first)) return null;
  const [side, a] = first.dataset.l.split(":");
  const [otherSide, b] = last.dataset.l.split(":");
  if (side !== otherSide) return null;
  const section = first.closest("[data-diff-section]");
  const file = diff.files?.[section ? Number(section.dataset.diffSection) : diff.index];
  // A drag that starts past the end of a line or ends at the start of one covers it only by its line break.
  const text = selection.toString();
  const quote = text.replace(/^[^\S\n]*\n/g, "").replace(/\s+$/, "");
  if (!file || !quote.trim()) return null;
  const top = Math.min(a, b) + (text.match(/^\s*/)[0].match(/\n/g) || []).length;
  const bottom = Math.max(a, b) - (text.match(/\s*$/)[0].match(/\n/g) || []).length;
  // Anchored where the selection ends (its last line box), next to the pointer after a drag.
  const boxes = [...selection.getRangeAt(0).getClientRects()].filter((box) => box.width);
  const box = boxes[boxes.length - 1] || selection.getRangeAt(0).getBoundingClientRect();
  return { file: file.path, side, line: Math.min(top, bottom), end: Math.max(top, bottom), quote, rect: { left: box.right - 40, bottom: box.bottom } };
}

function placeFloating(element, rect) {
  const width = element.offsetWidth;
  element.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left))}px`;
  element.style.top = `${Math.min(innerHeight - element.offsetHeight - 8, rect.bottom + 6)}px`;
}

function showNoteButton() {
  const button = diffDialog.querySelector("[data-note-new]");
  const target = selectedLines();
  button.hidden = !target;
  if (target) placeFloating(button, target.rect);
}

// One composer for new notes and edits; it holds typed text, so only Cancel or an empty Escape dismisses it.
function openComposer(target, note = null) {
  if (diff.scope === "stack" && !note) return notify("Notes belong to one PR. Open All changes or a commit to add one.");
  const composer = diffDialog.querySelector(".code-note-composer");
  composer.note = note ? { id: note.id } : { ...target, rect: undefined, commit: noteScope() };
  const where = note || target;
  composer.querySelector("[data-composer-where]").textContent = `${where.file.split("/").pop()} · ${noteRange(where)}${noteScope() ? ` · commit ${noteScope().slice(0, 7)}` : ""}`;
  const quote = composer.querySelector("blockquote");
  quote.textContent = where.quote || "";
  quote.hidden = !where.quote;
  const text = composer.querySelector("textarea");
  text.value = note?.body || "";
  composer.hidden = false;
  diffDialog.querySelector("[data-note-new]").hidden = true;
  placeFloating(composer, target?.rect || diffDialog.querySelector(`[data-note="${note.id}"]`).getBoundingClientRect());
  sizeComposer(text);
  text.focus({ preventScroll: true });
}

const sizeComposer = (text) => { text.style.height = "auto"; text.style.height = `${Math.min(320, text.scrollHeight + 2)}px`; };
const composerDirty = () => { const composer = diffDialog?.querySelector(".code-note-composer"); return Boolean(composer && !composer.hidden && composer.querySelector("textarea").value.trim()); };
const closeComposer = () => { diffDialog.querySelector(".code-note-composer").hidden = true; pickLines(null); diffDialog.focus({ preventScroll: true }); };

// Click a line number to note that line, or drag down the numbers to note a range, as on GitHub. The picked code cells
// stay tinted while the composer is open.
let picking = null;
const gutterCode = (gutter) => {
  if (!gutter || gutter.matches("[data-l]") || !diff.pr) return null;
  const next = gutter.nextElementSibling;
  return next?.matches("td[data-l]") ? next : gutter.parentElement.querySelector(":scope > td[data-l]");
};

function pickLines(range) {
  for (const cell of diffDialog.querySelectorAll("td.is-picked")) cell.classList.remove("is-picked");
  if (!range) return [];
  const [low, high] = [Math.min(range.from, range.to), Math.max(range.from, range.to)];
  const cells = [...range.table.querySelectorAll(`td[data-l^="${range.side}:"]`)].filter((cell) => { const line = Number(cell.dataset.l.split(":")[1]); return line >= low && line <= high; });
  for (const cell of cells) cell.classList.add("is-picked");
  return cells;
}

function startPick(event) {
  const code = gutterCode(event.target.closest?.("td"));
  if (!code || event.button !== 0) return false;
  event.preventDefault(); // a drag picks lines instead of selecting text
  getSelection().removeAllRanges();
  const [side, line] = code.dataset.l.split(":");
  picking = { table: code.closest("table"), side, from: Number(line), to: Number(line) };
  pickLines(picking);
  const move = (moveEvent) => {
    const over = gutterCode(document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest("td")) || document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest("td[data-l]");
    if (!over || over.closest("table") !== picking.table || !over.dataset.l.startsWith(`${picking.side}:`)) return;
    picking.to = Number(over.dataset.l.split(":")[1]);
    pickLines(picking);
  };
  const up = () => {
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
    const range = picking;
    picking = null;
    const cells = pickLines(range);
    const section = range.table.closest("[data-diff-section]");
    const file = diff.files?.[section ? Number(section.dataset.diffSection) : diff.index];
    if (!file || !cells.length) return pickLines(null);
    const box = cells[cells.length - 1].getBoundingClientRect();
    openComposer({ file: file.path, side: range.side, line: Math.min(range.from, range.to), end: Math.max(range.from, range.to), quote: cells.map((cell) => cell.textContent).join("\n").replace(/\s+$/, ""), rect: { left: box.left + 24, bottom: box.bottom } });
    cells.forEach((cell) => cell.classList.add("is-picked")); // openComposer doesn't clear them; closeComposer does
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
  return true;
}

async function saveComposer() {
  const composer = diffDialog.querySelector(".code-note-composer");
  const body = composer.querySelector("textarea").value;
  if (!body.trim()) return;
  const saved = await changeNote(composer.note.id ? { op: "update", id: composer.note.id, note: { body } } : { op: "add", note: { ...composer.note, body } });
  if (saved) { closeComposer(); getSelection().removeAllRanges(); }
}

// A whole-file note, anchored under that file's header button.
function noteOnFile(index) {
  const button = [...diffDialog.querySelectorAll(`[data-note-file="${index}"]`)].find((candidate) => candidate.getClientRects().length);
  const box = (button || diffDialog.querySelector('[data-d="body"]')).getBoundingClientRect();
  openComposer({ file: diff.files[index].path, side: "new", line: 0, end: 0, quote: "", rect: { left: box.right - 460, bottom: button ? box.bottom : box.top + 8 } });
}

function jumpToNote(id) {
  const note = prNotes().find((candidate) => candidate.id === id);
  const index = diff.files?.findIndex((file) => file.path === note?.file) ?? -1;
  if (!note) return;
  if ((note.commit || "all") !== diff.scope) selectScope(note.commit || "all");
  const reveal = () => {
    const at = diff.files?.findIndex((file) => file.path === note.file) ?? -1;
    if (at < 0) return;
    focusFile(at);
    // "All files" renders sections as they near the viewport, so look for the card after a couple of frames.
    setTimeout(() => diffDialog.querySelector(`[data-note="${id}"]`)?.scrollIntoView({ block: "center" }), 120);
  };
  if (index >= 0 && (note.commit || "all") === diff.scope) reveal(); else setTimeout(reveal, 600);
}

function notesSection(pr, workspace) {
  const notes = prNotes();
  const drafts = notes.filter((note) => note.status === "draft").length;
  const list = notes.map((note) => `<li><button type="button" class="code-diff-scope" data-note-jump="${note.id}"><b>${note.status === "draft" ? "" : "✓"}</b><span><code>${escapeHtml(note.file.split("/").pop())}${note.line ? `:${note.line}` : ""}</code> ${escapeHtml(note.body.split("\n")[0])}</span></button></li>`).join("");
  const file = diff.notes?.path && notes.length ? `<a class="code-icon-button" href="/?path=${encodeURIComponent(diff.notes.path)}" target="_blank" rel="noreferrer" data-tip="Open the notes file" aria-label="Open the notes file">${icon("external")}</a>` : "";
  const target = `data-url="${escapeHtml(pr.url || "")}" data-path="${escapeHtml(workspace)}"`;
  const actions = drafts && pr.url ? iconButton("comment", `Post ${drafts} draft${drafts === 1 ? "" : "s"} as a pending GitHub review in ${appName()}`, `data-code-skill="notes-post" ${target}`) + iconButton("discuss", `Work through the drafts in ${appName()}`, `data-code-skill="notes-work" ${target}`) : "";
  const meta = notes.length ? `${drafts} draft${drafts === 1 ? "" : "s"}${notes.length > drafts ? `, ${notes.length - drafts} posted` : ""}` : "select code, press <kbd>C</kbd>";
  return `<section>${sideHead("Notes", meta, `<span class="code-side-tools">${actions}${file}</span>`)}${list ? `<ol class="code-diff-scopes code-notes-list">${list}</ol>` : ""}</section>`;
}

const lineHtml = (line) => {
  const html = line.html ?? escapeHtml(line.text);
  return (line.marks || ((line.kind === "add" || line.kind === "del") && /^\s|\s$/.test(line.text)) ? decorate(html, lineClasses(line)) : html) || " ";
};

// A symlink's "content" is its target path, which reads like a one-line text file; show it as a link instead.
function symlinkBody(file) {
  const target = (kind) => file.lines.find((line) => line.kind === kind)?.text;
  const from = target("del");
  const to = target("add");
  const path = (text, kind) => `<code class="code-symlink-target is-${kind}">${escapeHtml(text)}</code>`;
  const what = file.status === "A" ? "New symbolic link" : file.status === "D" ? "Removed symbolic link" : "Symbolic link";
  const targets = from && to ? `${path(from, "del")} → ${path(to, "add")}` : to ? path(to, "add") : from ? path(from, "del") : "target unchanged";
  return `<p class="code-symlink">${icon("link")}<b>${what}</b> → ${targets}</p>`;
}

function diffTable(file) {
  if (file.binary) return `<p class="code-muted">Binary file.</p>`;
  if (file.symlink) return symlinkBody(file);
  if (!file.lines.length) return `<p class="code-muted">${file.status === "R" ? "Renamed without changes." : "No textual changes."}</p>`;
  highlightFile(file);
  if (!file.marked) { file.marked = true; markWords(file.lines); }
  // ponytail: renders every line; very large generated files (lockfiles) are slow but still finish.
  // A new or deleted file has nothing on one side, so split would waste half the width.
  if (diffLayout === "split" && file.status !== "A" && file.status !== "D") return splitTable(file);
  const top = noteRow(file, "new", 0, "<td colspan=\"3\">", "</td>");
  const rows = top + file.lines.map((line) => {
    if (line.kind === "hunk") return `<tr class="code-diff-hunk"><td colspan="3">${escapeHtml(line.text)}</td></tr>`;
    const side = line.kind === "del" ? "old" : "new";
    return `<tr class="code-diff-${line.kind}"><td>${line.old ?? ""}</td><td>${line.new ?? ""}</td><td data-l="${side}:${line[side]}">${lineHtml(line)}</td></tr>${noteRow(file, side, line[side], "<td></td><td></td><td>", "</td>")}`;
  }).join("");
  return `<table class="code-diff-table"><colgroup><col><col><col></colgroup><tbody>${rows}</tbody></table>`;
}

// Side by side: each run of deletions pairs line-for-line with the additions that follow it.
function splitTable(file) {
  const { lines } = file;
  const cell = (line, side) => line ? `<td class="code-diff-${line.kind}">${line[side] ?? ""}</td><td class="code-diff-${line.kind}" data-l="${side}:${line[side]}">${lineHtml(line)}</td>` : `<td class="code-diff-empty"></td><td class="code-diff-empty"></td>`;
  const top = noteRow(file, "new", 0, "<td colspan=\"4\">", "</td>");
  const notes = (left, right) => noteRow(file, "old", left?.old, "<td></td><td>", "</td><td></td><td></td>") + noteRow(file, "new", right?.new, "<td></td><td></td><td></td><td>", "</td>");
  const rows = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === "hunk") { rows.push(`<tr class="code-diff-hunk"><td colspan="4">${escapeHtml(line.text)}</td></tr>`); index++; continue; }
    if (line.kind === "ctx") { rows.push(`<tr>${cell(line, "old")}${cell(line, "new")}</tr>${notes(line, line)}`); index++; continue; }
    const dels = [];
    const adds = [];
    while (lines[index]?.kind === "del") dels.push(lines[index++]);
    while (lines[index]?.kind === "add") adds.push(lines[index++]);
    for (let row = 0; row < Math.max(dels.length, adds.length); row++) rows.push(`<tr>${cell(dels[row], "old")}${cell(adds[row], "new")}</tr>${notes(dels[row], adds[row])}`);
  }
  return `<table class="code-diff-table code-diff-split-table"><colgroup><col><col><col><col></colgroup><tbody>${top}${rows.join("")}</tbody></table>`;
}

const diffSegment = (attr, current, options) => `<div class="code-segment">${Object.entries(options).map(([id, label]) => `<button type="button" ${attr}="${id}" aria-pressed="${current === id}">${label}</button>`).join("")}</div>`;
const viewedBox = (file) => subject() ? `<label class="code-diff-viewed"><input type="checkbox" data-diff-viewed="${diff.files.indexOf(file)}" ${isViewed(file) ? "checked" : ""}> Viewed</label>` : "";
const fileHeadInner = (file, controls = "") => `<b>${escapeHtml(file.path)}</b>${file.symlink ? '<span class="code-muted">symlink</span>' : ""}${file.status === "R" ? `<span class="code-muted code-diff-from" title="from ${escapeHtml(file.old)}">from ${escapeHtml(file.old)}</span>` : ""}${copyButton(file.path, "Copy path")}${isGenerated(file) ? '<span class="code-muted">generated</span>' : ""}<span class="code-spacer"></span>${controls}${diff.pr && !file.binary ? iconButton("comment", "Note on the whole file", `data-note-file="${diff.files.indexOf(file)}"`) : ""}<span class="code-ftree-delta"><b class="code-file-add">+${file.additions}</b><b class="code-file-del">−${file.deletions}</b></span>`;
let lastBodyKey = "";

function renderDiffFiles() {
  const files = diff.files;
  const current = isDocScope() ? null : files?.[diff.index];
  const shown = files && visibleFileIndexes().map((index) => files[index]);
  const done = allViewed();
  const hidden = hidingViewed() && files ? files.filter((file, index) => isViewed(file) && index !== diff.index && fileMatches(file)).length : 0;
  const toggle = diffDialog.querySelector("[data-diff-hide]");
  toggle.hidden = !subject();
  toggle.setAttribute("aria-pressed", String(hideViewed));
  toggle.dataset.tip = `${hideViewed ? "Show" : "Hide"} viewed files (U)`;
  toggle.innerHTML = `${icon("review")}${hidingViewed() ? `${hidden} hidden` : "All shown"}`;
  diffRegion("listmode", diffSegment("data-diff-list", fileListMode, { list: "List", map: "Map" }));
  const map = fileListMode === "map";
  diffDialog.querySelector(".code-diff-split").classList.toggle("is-map", map);
  if (map && files?.length) {
    diffRegion("files", changeMap(files, current));
    // The moves row wraps, so the space above the canvas is only known once drawn; redraw once if the guess was off.
    const chrome = diffDialog.querySelector(".code-map-canvas")?.offsetTop;
    if (chrome !== undefined && Math.abs(chrome - mapChrome) > 1) { mapChrome = chrome; diffRegion("files", changeMap(files, current)); }
    restoreMapHover();
    return syncViewUrl();
  }
  diffRegion("files", !files ? `<p class="code-muted">Loading files…</p>`
    : shown.length ? `${fileTree(shown, (item) => `data-diff-file="${files.indexOf(item)}"`, current, subject() ? isViewed : null)}${done ? `<p class="code-muted code-ftree-done">All ${files.length} files viewed.</p>` : ""}`
    : `<p class="code-muted">${!files.length ? (diff.error ? "No files." : "No changed files.") : `No ${hidingViewed() ? "unviewed " : ""}files match “${escapeHtml(diff.filter.trim())}”.`}</p>`);
  diffDialog.querySelector('[data-d="files"] [aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  syncViewUrl();
}

function setFileListMode(mode) {
  fileListMode = mode;
  if (mode !== "map" && mapFull) toggleMapFull();
  storage.set("code-diff-files", mode);
  renderDiffFiles();
}

// The map fills the files column, so it is laid out for that column's size and redrawn when the column resizes.
function changeMap(files, current) {
  const region = diffDialog.querySelector('[data-d="files"]');
  const key = JSON.stringify(diff.params);
  const loaded = lineCounts.get(key);
  if (!loaded) {
    const params = diff.params;
    const paths = [...new Set(files.flatMap((file) => [file.path, file.old]).filter(Boolean))];
    lineCounts.set(key, { pending: true });
    fetch("/api/code/line-counts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params, paths }) })
      .then((response) => response.ok ? response.json() : null).catch(() => null)
      .then((counts) => { lineCounts.set(key, { counts: counts && Object.keys(counts.before).length + Object.keys(counts.after).length ? counts : null }); if (diff.params === params && fileListMode === "map") renderDiffFiles(); });
  }
  const counts = loaded?.counts || null;
  const crumbs = ["", ...(diff.zoom ? diff.zoom.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/")) : [])];
  const crumbHtml = crumbs.map((path) => `<button type="button" class="code-map-crumb" data-map-zoom="${escapeHtml(path)}" aria-current="${path === diff.zoom}">${escapeHtml(path ? path.split("/").pop() : (diff.pr?.slug || diff.wt?.path || "").split("/").pop() || "root")}</button>`).join("<span>/</span>");
  const sizing = loaded?.pending ? "Counting lines…" : counts ? "Size: lines" : "Size: lines changed";
  const legend = `<span class="code-map-legend"><i class="is-a"></i>Added <i class="is-m"></i>Modified <i class="is-r"></i>Renamed <i class="is-ghost"></i>Old path <i class="is-d"></i>Deleted · ${sizing}</span>`;
  const moves = moveGroups(files);
  const folder = (path) => `<span>${escapeHtml(path ? path.split("/").pop() : "(root)")}/</span>`;
  const moveHtml = moves.length ? `<div class="code-map-moves"><span class="code-map-moves-label">Moved</span>${moves.slice(0, 8).map((move) => `<button type="button" class="code-map-move" data-map-move="${move.id}" aria-pressed="${diff.move === move.id}" aria-label="${escapeHtml(`${move.count} renamed from ${move.from || "(root)"}/ to ${move.to || "(root)"}/`)}">${folder(move.from)}<i>→</i>${folder(move.to)}<b>×${move.count}</b></button>`).join("")}${moves.length > 8 ? `<span class="code-muted" title="${escapeHtml(moves.slice(8).map((move) => `${move.from}/ → ${move.to}/ (${move.count})`).join("\n"))}">+${moves.length - 8} more · hover a tile to see its move</span>` : ""}</div>` : "";
  const pad = getComputedStyle(region);
  const width = Math.max(120, region.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight));
  const height = Math.max(120, region.clientHeight - mapChrome - parseFloat(pad.paddingBottom));
  const canvas = mapHtml(files, counts, width, height, { zoom: diff.zoom, current, viewed: subject() ? isViewed : null, matches: diff.filter.trim() ? fileMatches : null, edges: mapEdges });
  const edges = moves.length ? `<button type="button" class="code-map-edges" data-map-edges aria-pressed="${mapEdges}" aria-label="Draw a ribbon for each move (E)">Edges <kbd>E</kbd></button>` : "";
  const copyButton = mapFull ? `<button type="button" class="code-bar-button code-map-copy" data-map-export="copy">${icon("copy")}Copy image</button>` : iconButton("copy", "Copy this map as an image, to paste into a PR", 'data-map-export="copy"');
  const exports = `${edges}${copyButton}${iconButton(mapFull ? "shrink" : "expand", mapFull ? "Shrink the map (F or Esc)" : "Expand the map to resize it (F)", "data-map-full")}${iconButton("download", "Download this map as PNG", 'data-map-export="download"')}`;
  return `<div class="code-map"><div class="code-map-bar"><nav class="code-map-crumbs">${crumbHtml}</nav>${legend}${exports}</div>${moveHtml}${canvas}<div class="code-map-card" hidden></div></div>`;
}

// The map as a PNG at the current zoom: titled with the PR (or branch) and folder, sized like the map on screen.
function exportMap(button, how) {
  const canvas = diffDialog.querySelector(".code-map-canvas");
  const info = diff.pr ? prInfo(diff.pr.slug, diff.pr.number) : null;
  const repo = (diff.pr?.slug || diff.wt?.path || "").split("/").pop();
  const title = diff.pr ? `#${diff.pr.number} ${info?.title || ""}` : diffDialog.querySelector(".code-diff-title h3")?.textContent.trim() || "Change map";
  const scope = diffDialog.querySelector(".code-diff-title p")?.textContent.split(" · ").slice(1, 2).join("") || "";
  const shown = diff.zoom ? diff.files.filter((file) => [file.path, file.old].some((path) => path?.startsWith(`${diff.zoom}/`))) : diff.files;
  const sum = (key) => shown.reduce((total, file) => total + file[key], 0);
  const move = diff.move === null ? null : moveGroups(diff.files)[diff.move];
  const subtitle = `${repo}${diff.zoom ? `/${diff.zoom}` : ""} · ${scope ? `${scope} · ` : ""}${shown.length} files · +${sum("additions").toLocaleString()} −${sum("deletions").toLocaleString()}${move ? ` · highlighting ${move.count} moved from ${move.from || "(root)"}/ to ${move.to || "(root)"}/` : ""}`;
  const svg = mapSvg(diff.files, lineCounts.get(JSON.stringify(diff.params))?.counts, canvas.offsetWidth, canvas.offsetHeight, { zoom: diff.zoom, edges: mapEdges, title, subtitle, move: diff.move });
  const png = svgToPng(svg);
  const download = () => png.then((blob) => {
    const name = `${diff.pr ? `pr-${diff.pr.number}` : repo}${diff.zoom ? `-${diff.zoom.replace(/\//g, "-")}` : ""}-change-map.png`;
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return name;
  }, (error) => notify(error.message, true));
  if (how !== "copy") return download();
  // A browser that blocks image clipboard writes still gets the picture, as a download.
  navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(() => copied(button), () => download().then((name) => name && notify(`The clipboard is blocked here, so the map was downloaded as ${name}.`)));
}

// Pinning a move keeps its folders lit; one whose folders sit outside the zoom zooms out to the folder holding both.
function pinMove(id) {
  diff.move = diff.move === id ? null : id;
  const move = diff.move === null ? null : moveGroups(diff.files)[id];
  if (move && diff.zoom && move.within !== diff.zoom && !move.within.startsWith(`${diff.zoom}/`)) diff.zoom = move.within;
  renderDiffFiles();
}

function toggleMapFull() {
  mapFull = !mapFull;
  const files = diffDialog.querySelector(".code-diff-files");
  files.style.width = files.style.height = ""; // a new expand opens at the full overlay again
  diffDialog.querySelector(".code-diff-split").classList.toggle("is-map-full", mapFull);
  renderDiffFiles();
}

function toggleEdges() {
  mapEdges = !mapEdges;
  storage.set("code-map-edges", mapEdges ? "on" : "off");
  renderDiffFiles();
}

// Lights one move: its old and new folders outlined, its ghosts and files ringed, everything else faded.
function focusMove(id) {
  const region = diffDialog.querySelector('[data-d="files"]');
  const map = region.querySelector(".code-map");
  if (!map) return;
  for (const lit of map.querySelectorAll(".is-move, .is-move-from, .is-move-to")) lit.classList.remove("is-move", "is-move-from", "is-move-to");
  map.classList.toggle("has-move", id !== null && id !== undefined);
  if (id === null || id === undefined) return;
  for (const element of map.querySelectorAll(`[data-move="${id}"], [data-map-move="${id}"]`)) element.classList.add("is-move");
  for (const dir of map.querySelectorAll("[data-move-from]")) if (dir.dataset.moveFrom.split(" ").includes(String(id))) dir.classList.add("is-move-from");
  for (const dir of map.querySelectorAll("[data-move-to]")) if (dir.dataset.moveTo.split(" ").includes(String(id))) dir.classList.add("is-move-to");
}

function mapHover(event) {
  mapPointer = event.type === "pointerleave" ? null : { x: event.clientX, y: event.clientY };
  mapHoverAt(event.currentTarget, event.type === "pointerleave" ? null : event.target);
}

// Redrawing replaces the elements under the cursor without a new pointer event, so re-apply the hover from where it is.
function restoreMapHover() {
  const region = diffDialog.querySelector('[data-d="files"]');
  const target = mapPointer && document.elementFromPoint(mapPointer.x, mapPointer.y);
  mapHoverAt(region, target && region.contains(target) ? target : null);
}

// Hovering a tile shows its card and lights its rename partner and its move; a hovered move previews over the pinned one.
function mapHoverAt(region, target) {
  const tile = target?.closest?.("[data-map-tile]");
  const card = region.querySelector(".code-map-card");
  const moveButton = target?.closest?.("[data-map-move]");
  const preview = moveButton ? Number(moveButton.dataset.mapMove) : tile?.dataset.move !== undefined ? Number(tile.dataset.move) : diff.move;
  const map = region.querySelector(".code-map");
  if (map && map.dataset.preview !== String(preview)) { focusMove(preview); map.dataset.preview = String(preview); }
  for (const lit of region.querySelectorAll(".is-linked")) lit.classList.remove("is-linked");
  if (!tile || !card) { if (card) card.hidden = true; return; }
  const index = tile.dataset.mapTile;
  for (const twin of region.querySelectorAll(`[data-map-tile="${index}"]`)) twin.classList.add("is-linked");
  card.innerHTML = tileCard(diff.files[Number(index)], lineCounts.get(JSON.stringify(diff.params))?.counts, "mapGhost" in tile.dataset);
  card.hidden = false;
  const box = region.getBoundingClientRect();
  const at = tile.getBoundingClientRect();
  const left = Math.max(4, Math.min(box.width - card.offsetWidth - 4, at.left - box.left + region.scrollLeft));
  const below = at.bottom - box.top + 4;
  card.style.left = `${left}px`;
  card.style.top = `${below + card.offsetHeight < box.height ? below : Math.max(4, at.top - box.top - card.offsetHeight - 4)}px`;
}

// Once every file is viewed there is nothing left to hide, so the whole list comes back with a note under it.
const allViewed = () => Boolean(subject() && diff.files?.length && diff.files.every(isViewed));
const hidingViewed = () => hideViewed && Boolean(subject()) && !allViewed();
const fileMatches = (file) => diff.filter.toLowerCase().split(/\s+/).filter(Boolean).every((term) => file.path.toLowerCase().includes(term));

// J/K and X walk the files the filter (and Hide viewed) leave visible, in tree order.
function visibleFileIndexes() {
  const hide = hidingViewed();
  return (diff.files || []).flatMap((file, index) => (fileMatches(file) && !(hide && isViewed(file) && index !== diff.index) ? [index] : []));
}

function toggleHideViewed() {
  hideViewed = !hideViewed;
  storage.set("code-diff-hide-viewed", hideViewed ? "on" : "off");
  renderDiffFiles();
}

function stepFile(step) {
  const visible = visibleFileIndexes();
  if (!visible.length) return;
  const at = visible.indexOf(diff.index);
  const next = at < 0 ? visible.find((index) => (step > 0 ? index > diff.index : index < diff.index)) ?? visible[step > 0 ? visible.length - 1 : 0] : visible[Math.max(0, Math.min(visible.length - 1, at + step))];
  focusFile(next);
}

function focusFile(index) {
  if (isDocScope()) diff.scope = "all"; // the file list under Description / Local files is the whole change
  diff.index = index;
  renderDiff();
  scrollToFile();
}

// Scroll anchoring keeps the target still while sections above it render and grow.
function scrollToFile() {
  if (diffView !== "all") return;
  const body = diffDialog.querySelector('[data-d="body"]');
  const align = () => {
    const section = body.querySelector(`[data-diff-section="${diff.index}"]`);
    if (section) body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top;
  };
  jumpedAt = Date.now();
  align();
  requestAnimationFrame(() => requestAnimationFrame(align));
}

// "all" renders each file's table only as it nears the viewport; very long files wait for a click.
function renderSection(placeholder, force = false) {
  const index = Number(placeholder?.dataset.diffLazy);
  const file = diff.files?.[index];
  if (!file || !placeholder.isConnected) return;
  lazySections.unobserve(placeholder);
  placeholder.style.height = "";
  if (file.lines.length > BIG_FILE && !force) {
    placeholder.innerHTML = `<p class="code-muted code-diff-big">${file.lines.length.toLocaleString()} changed lines. <button type="button" class="code-more" data-diff-load="${index}">Show diff</button></p>`;
    return;
  }
  placeholder.dataset.rendered = "";
  placeholder.innerHTML = diffTable(file);
}

function refreshFile(file) {
  if (diffView === "all") {
    const placeholder = diffDialog?.querySelector(`[data-diff-lazy="${diff.files?.indexOf(file)}"][data-rendered]`);
    if (placeholder) placeholder.innerHTML = diffTable(file);
  } else if (diff.files?.[diff.index] === file) renderDiff();
}

function refreshAllFiles() {
  if (diffView !== "all") return renderDiff();
  for (const placeholder of diffDialog?.querySelectorAll("[data-diff-lazy][data-rendered]") || []) placeholder.innerHTML = diffTable(diff.files[Number(placeholder.dataset.diffLazy)]);
}

// Viewed and collapsed state is applied to the existing sections, so toggling one never rebuilds (or re-lays-out) the scroll.
function syncSections() {
  for (const section of diffDialog.querySelectorAll("[data-diff-section]")) {
    const file = diff.files[Number(section.dataset.diffSection)];
    const collapsed = isCollapsed(file);
    section.classList.toggle("is-collapsed", collapsed);
    section.querySelector("[data-diff-lazy]").hidden = collapsed;
    const box = section.querySelector("[data-diff-viewed]");
    if (box) box.checked = isViewed(file);
  }
}

function renderDiff() {
  if (!diffDialog) return;
  const { files, pr, wt } = diff;
  const description = Boolean(pr) && diff.scope === "description";
  const local = Boolean(wt) && diff.scope === "local";
  const all = diffView === "all" && !description && !local;
  const file = description || local ? null : files?.[diff.index];
  const markdown = !all && file && isMarkdown(file.path) && file.status !== "D";
  const rendered = markdown && diff.mode === "rendered";
  if (rendered) loadFileText(file);
  const text = file && diff.texts.get(file.path);
  const info = pr ? prInfo(pr.slug, pr.number) : null;
  const commits = info?.commits || [];
  const commit = pr ? commits.find((candidate) => candidate.sha === diff.scope) : null;
  const wtInfo = wt ? ui.detail.get(`tree:${wt.path}`) : null;
  const wtCommit = wt ? wtCommits().find((candidate) => candidate.sha === diff.scope) : null;
  const wtScope = { local: "Local files", all: wtInfo?.base ? `All changes vs ${wtInfo.base}` : "All changes", uncommitted: "Uncommitted" }[diff.scope];
  const title = wt ? `${icon("branch")} ${escapeHtml(wtInfo?.tree?.branch || shortPath(wt.path))}`
    : pr ? `<a class="code-pr-link" href="${escapeHtml(info.url || `https://github.com/${pr.slug}/pull/${pr.number}`)}" target="_blank" rel="noreferrer">#${pr.number}</a> ${escapeHtml(info.title || "")}` : escapeHtml(diff.title);
  const sub = wt ? `${escapeHtml(shortPath(wt.path))} · ${wtCommit ? `commit ${wtCommits().indexOf(wtCommit) + 1} of ${wtCommits().length} · ${escapeHtml(wtCommit.sha.slice(0, 7))} ${escapeHtml(wtCommit.subject)}` : wtScope || ""}`
    : pr ? `${escapeHtml(pr.slug.split("/")[1])} · ${commit ? `commit ${commits.indexOf(commit) + 1} of ${commits.length} · ${escapeHtml(commit.sha.slice(0, 7))} ${escapeHtml(commit.subject)}` : description ? "Description" : diff.scope === "stack" ? `Whole stack vs ${escapeHtml(prStack().stack[0]?.base || "")}` : "All changes"}` : escapeHtml(diff.sub) + (diff.params?.source === "commit" ? commitPlace(diff.context) : "");
  const viewedCount = subject() && files && !description && !local ? files.filter(isViewed).length : 0;
  const progress = subject() && files?.length && !description && !local
    ? ` · <span class="code-diff-progress${viewedCount === files.length ? " is-done" : viewedCount ? "" : " is-none"}">${viewedCount === files.length ? `All ${files.length} viewed` : `${viewedCount} of ${files.length} viewed`}</span>` : "";
  const hints = `<kbd>J</kbd><kbd>K</kbd> file${subject() ? ` · <kbd>X</kbd> viewed · <kbd>U</kbd> unviewed only · <kbd>D</kbd> views · <kbd>N</kbd><kbd>P</kbd> ${wt ? "scope" : "commit"}` : ""} · <kbd>/</kbd> filter · <kbd>T</kbd> map · <kbd>V</kbd> view · <kbd>S</kbd> layout${markdown ? " · <kbd>M</kbd> rendered" : ""}${pr ? " · <kbd>C</kbd> note" : ""}${pr && prStack().stack.length > 1 ? " · <kbd>[</kbd><kbd>]</kbd> stack" : ""}`;
  diffRegion("head", `<div class="code-diff-title"><h3>${title}</h3><p class="code-muted">${sub}${files && !description && !local && !progress ? ` · ${files.length} ${files.length === 1 ? "file" : "files"}` : ""}${progress}</p></div><span class="code-diff-hints code-muted">${hints}</span>${diffSegment("data-diff-view", diffView, { single: "One file", all: "All files" })}${diffSegment("data-diff-layout", diffLayout, { split: "Split", unified: "Unified" })}<button type="button" class="code-icon-button" data-diff-close aria-label="Close (Esc)">${icon("fail")}</button>`);
  diffDialog.querySelector(".code-diff-split").classList.toggle("has-pr", Boolean(subject()));
  diffDialog.toggleAttribute("data-notes", Boolean(pr));
  diffRegion("pr", wt ? wtColumn() : pr ? prColumn() : "");
  renderDiffFiles();
  diffRegion("filehead", file && !all ? `<div class="code-diff-file-head">${fileHeadInner(file, markdown ? diffSegment("data-diff-mode", rendered ? "rendered" : "diff", { rendered: "Rendered", diff: "Diff" }) : "")}${viewedBox(file)}</div>` : "");
  const body = local ? localFilesBody()
    : description ? (info.body ? `<div class="markdown code-diff-markdown">${prBodyHtml(pr.slug, pr.number, info.body)}</div>` : `<p class="code-muted">Loading…</p>`)
    : !files ? `<p class="code-muted">Loading diff…</p>`
    : diff.error ? `<p class="work-warning code-diff-error">Couldn't load this diff: ${escapeHtml(diff.error)}</p>`
    : !files.length ? `<p class="code-muted">No changes.</p>`
    : all ? `<div class="code-diff-all" data-layout="${diffLayout}">${files.map((item, index) => `<section class="code-diff-section" data-diff-section="${index}"><header class="code-diff-file-head"><button type="button" class="code-diff-chevron" data-diff-collapse="${index}" aria-label="Collapse or expand ${escapeHtml(item.path)}"></button>${fileHeadInner(item)}${subject() ? `<label class="code-diff-viewed"><input type="checkbox" data-diff-viewed="${index}"> Viewed</label>` : ""}</header><div data-diff-lazy="${index}" style="height:${Math.max(36, item.lines.length * ROW_PX)}px"></div></section>`).join("")}</div>`
    : rendered ? (text === null || text === undefined ? `<p class="code-muted">Loading…</p>` : text.error ? `<p class="work-warning">${escapeHtml(text.error)}</p>${diffTable(file)}` : `<div class="markdown code-diff-markdown">${renderMarkdown(text)}</div>`)
    : diffTable(file);
  const scroller = diffDialog.querySelector('[data-d="body"]');
  const replaced = diffRegion("body", body);
  const bodyKey = JSON.stringify([diff.params, diff.scope, all || diff.index, rendered, diff.local?.path]);
  if (bodyKey !== lastBodyKey) { scroller.scrollTop = 0; lastBodyKey = bodyKey; }
  if (replaced && all) {
    lazySections.disconnect();
    for (const placeholder of replaced.querySelectorAll("[data-diff-lazy]")) lazySections.observe(placeholder);
  }
  if (all && files?.length) syncSections();
  // Replacing markup can drop focus to <body>, where J/K/M would miss the overlay's key handler.
  if (diffDialog.open && !diffDialog.contains(document.activeElement)) diffDialog.focus({ preventScroll: true });
}

// ---------- cleanup ----------

const CLEANUP_LEVELS = { safe: "Safe to remove", review: "Review first", fresh: "Too new to remove", pending: "Still checking", keep: "Keep" };

function cleanupTone(reason) {
  if (/never used/.test(reason)) return "unused";
  if (/merged/.test(reason)) return "merged";
  if (/closed/.test(reason)) return "closed";
  if (/idle/.test(reason)) return "idle";
  if (/uncommitted/.test(reason)) return "dirty";
  if (/open/.test(reason)) return "open";
  return "";
}

// The cleanup actions live in the sticky toolbar so Remove stays in reach while scrolling 200 rows.
function cleanupControls() {
  const all = ui.data.worktrees.filter((tree) => tree.cleanup && !tree.main);
  const count = (name) => all.filter((tree) => level(tree) === name && !ui.removed.has(tree.path)).length;
  const progress = ui.removing
    ? `<div class="code-progress"><span style="transform:scaleX(${ui.removing.done / ui.removing.total})"></span></div><span class="code-progress-label">Removing ${ui.removing.done} of ${ui.removing.total}…</span>`
    : ui.removed.size ? `<span class="code-progress-label">${ui.removed.size} removed this session</span>` : "";
  return `<div class="code-cleanup-counts"><span class="code-count-safe"><b>${count("safe")}</b> safe</span><span class="code-count-review"><b>${count("review")}</b> review</span><span class="code-count-fresh"><b>${count("fresh")}</b> too new</span><span class="code-count-keep"><b>${count("keep")}</b> keep</span>${count("pending") ? `<span><b>${count("pending")}</b> checking</span>` : ""}</div>
    <div class="code-segment" data-tip="Keep worktrees created or touched recently out of the removable groups">${Object.entries({ off: "Any age", day: "Older than 1d", week: "Older than 1w" }).map(([id, label]) => `<button type="button" data-code-guard="${id}" aria-pressed="${cleanupGuard === id}">${label}</button>`).join("")}</div>
    <label class="code-check"><input type="checkbox" data-code-keep ${ui.showKeep ? "checked" : ""}> Show kept</label>
    <span class="code-spacer"></span>${progress}
    <button type="button" class="code-bar-button" data-code-select-level="safe">Select all safe</button>
    <button type="button" class="code-bar-button" data-code-select-none ${ui.selected.size ? "" : "disabled"}>Clear</button>
    <button type="button" class="code-bar-button code-agent-review" data-code-cleanup-agent data-tip="Draft a prompt that checks each one for unpushed commits and hand-made files first" ${ui.selected.size && !ui.removing ? "" : "disabled"}>${icon("session")}Agent review ${ui.selected.size || ""}</button>
    <button type="button" class="code-bar-button code-danger" data-code-remove data-tip="git worktree remove: branches and commits stay, dirty worktrees are refused, ignored files such as node_modules are deleted" ${ui.selected.size && !ui.removing ? "" : "disabled"}>${icon("trash")}Remove ${ui.selected.size || ""}</button>`;
}

function cleanupBody() {
  const all = ui.data.worktrees.filter((tree) => tree.cleanup && !tree.main);
  const bar = "";
  const groups = Object.keys(CLEANUP_LEVELS).filter((name) => name !== "keep" || ui.showKeep);
  const candidates = all.filter((tree) => matches(`${tree.branch} ${tree.path} ${tree.cleanup.reason}`));
  const body = groups.map((group) => {
    const rows = candidates.filter((tree) => level(tree) === group).sort((a, b) => a.activity - b.activity);
    if (!rows.length) return "";
    const selectable = group === "safe" || group === "review";
    const live = rows.filter((tree) => !ui.removed.has(tree.path));
    const allSelected = selectable && live.length && live.every((tree) => ui.selected.has(tree.path));
    return `<tbody><tr class="code-group-row"><th colspan="7">${selectable ? `<label class="code-group-toggle"><input type="checkbox" data-code-select-group="${group}" ${allSelected ? "checked" : ""}>${CLEANUP_LEVELS[group]} <span>${live.length}</span></label>` : `${CLEANUP_LEVELS[group]}${group === "fresh" ? ` <em>created or touched within ${cleanupGuard === "week" ? "a week" : "a day"}</em>` : ""} <span>${live.length}</span>`}</th></tr>${rows.map((tree) => {
      const removed = ui.removed.has(tree.path);
      return `<tr class="code-row${removed ? " is-removed" : ""}" data-code-row="tree:${escapeHtml(tree.path)}" aria-selected="${ui.sel === `tree:${tree.path}`}">
        <td class="code-col-check">${selectable && !removed ? `<input type="checkbox" data-code-select="${escapeHtml(tree.path)}" ${ui.selected.has(tree.path) ? "checked" : ""} aria-label="Select ${escapeHtml(tree.branch)}">` : ""}</td>
        <td class="code-col-main"><div class="code-line">${branchChip(tree.branch, "code-branch")}${removed ? '<span class="code-tag code-tag-removed">removed</span>' : ""}</div></td>
        <td class="code-col-reason"><span class="code-tag code-tag-${cleanupTone(tree.cleanup.reason)}">${escapeHtml(tree.cleanup.reason)}</span></td>
        <td class="code-col-ab">${aheadBehind(tree)}</td>
        <td class="code-col-when">${when(tree.activity)}</td>
        <td class="code-col-path"><button type="button" class="code-path" data-code-copy="${escapeHtml(tree.path)}" data-tip="Copy path">${escapeHtml(shortPath(tree.path))}</button></td>
        <td class="code-col-actions">${removed ? "" : treeActions(tree)}</td></tr>`;
    }).join("")}</tbody>`;
  }).join("");
  return `${bar}${body ? `<table class="code-table">${tableHead([["code-col-check", ""], ["code-col-main", "Branch"], ["code-col-reason", "Why"], ["code-col-ab", "vs main"], ["code-col-when", "Changed"], ["code-col-path", "Path"], ["code-col-actions", "Open"]])}${body}</table>` : `<p class="code-empty">Nothing to clean up.</p>`}`;
}

// ---------- detail pane ----------

function selectedItem() {
  if (!ui.sel || !host?.querySelector(`[data-code-row="${CSS.escape(ui.sel)}"]`)) return {};
  if (ui.sel.startsWith("tree:")) return { kind: "tree", tree: ui.data.worktrees.find((tree) => `tree:${tree.path}` === ui.sel) };
  if (ui.sel.startsWith("pr:")) return { kind: "pr", pr: ui.data.prs.find((pr) => `pr:${pr.slug}#${pr.number}` === ui.sel) };
  if (ui.sel.startsWith("commit:")) return { kind: "commit", commit: commitFor(ui.sel) };
  return {};
}

// Porcelain "XY path" entries as tree files; untracked "??" shows as A.
const statusFiles = (entries) => entries.map((entry) => ({ path: entry.slice(3), status: entry.slice(0, 2).trim().replace("??", "A") || "M" }));

// `where` ({ repo, slug }) lets each SHA open its diff; the server falls back to GitHub when a PR commit isn't local.
function commitList(commits, empty, where) {
  if (!commits) return `<p class="code-muted">Loading…</p>`;
  if (!commits.length) return `<p class="code-muted">${empty}</p>`;
  return `<ol class="code-commits">${commits.map((commit) => `<li><button type="button" class="code-commit-sha" data-code-commit-diff="${escapeHtml(commit.sha)}" data-repo="${escapeHtml(where.repo)}" data-slug="${escapeHtml(where.slug || "")}" data-subject="${escapeHtml(commit.subject)}" data-tip="Open diff">${escapeHtml(commit.sha.slice(0, 7))}</button><span>${escapeHtml(commit.subject)}</span>${when(commit.time)}</li>`).join("")}</ol>`;
}

const commitTarget = (params, subject, sub, context = null) => ({ params: { source: "commit", ...params }, title: subject || params.sha.slice(0, 8), sub, context });

function treeDetail(tree) {
  const pr = prFor(tree);
  const extra = ui.detail.get(`tree:${tree.path}`);
  const ages = [tree.created && `created ${ago(tree.created)} ago`, tree.commitTime && `last commit ${ago(tree.commitTime)} ago`, tree.ownCommits !== undefined && `${tree.ownCommits} own ${tree.ownCommits === 1 ? "commit" : "commits"}`].filter(Boolean).join(" · ");
  const review = pr && REVIEW[pr.reviewDecision];
  return `<header class="code-detail-head"><h3>${escapeHtml(tree.branch)}</h3><span class="code-side-tools">${iconButton("expand", "Worktree overview (Enter)", "data-code-wt-overlay")}${copyButton(tree.branch, "Copy branch")}</span></header>
    ${sideFacts([
      ["Path", `<button type="button" class="code-path code-side-path" data-code-copy="${escapeHtml(tree.path)}" data-tip="${escapeHtml(tree.path)} · click to copy">${escapeHtml(shortPath(tree.path))}</button>`],
      ["Status", `${tree.main ? "Main checkout" : `<span data-tip="Commits ahead of and behind origin/main">↑${tree.ahead ?? "?"} ↓${tree.behind ?? "?"} vs main</span>`}<span class="${tree.dirty ? "code-side-pending" : "code-muted"}">${tree.dirty === null ? "checking…" : tree.dirty ? `${tree.dirty} uncommitted` : "clean"}</span><span class="code-muted">changed ${ago(tree.activity)} ago</span>`],
      ["History", ages && `<span class="code-muted">${ages}</span>`],
      ["PR", pr ? `<button type="button" class="code-side-pr" data-code-goto-pr="${escapeHtml(`pr:${pr.slug}#${pr.number}`)}" data-tip="Inspect the pull request">${ciBadge(pr)}<b>#${pr.number}</b><span>${escapeHtml(pr.title || "")}</span></button>${review ? `<span class="code-muted">${review[1]}</span>` : ""}` : historyChip(tree)],
      ["Cleanup", tree.cleanup ? `<span class="code-side-cleanup code-side-${{ safe: "pass", review: "pending", keep: "quiet", pending: "quiet" }[tree.cleanup.level] || "quiet"}">${escapeHtml(tree.cleanup.reason)}</span>` : ""],
      [appName(), pr ? sideSkills(pr, tree.path, tree) : ""],
      ["Open", `<span class="code-side-tools">${treeActions(tree)}</span>`],
    ])}
    ${runSection(tree.path)}
    <section><h4>Uncommitted files <span>${tree.files?.length || 0}${tree.dirty > 40 ? ` of ${tree.dirty}` : ""}</span></h4>${tree.files?.length ? fileTree(statusFiles(tree.files), diffFileLink) : `<p class="code-muted">${tree.dirty === null ? "Checking…" : "Working tree clean."}</p>`}</section>
    <section><h4>${tree.main ? "Recent commits" : "Commits not on main"}</h4>${commitList(extra?.commits.slice(0, 15), "None. Everything here is on main.", { repo: tree.repo, slug: ui.data.slugs?.[tree.repo] })}</section>
    <section><h4>Ignored local files <span>${extra ? extra.ignoredCount : ""}</span></h4>${!extra ? `<p class="code-muted">Loading…</p>` : extra.ignored.length ? `<ul class="code-files code-files-ignored">${extra.ignored.map((file) => `<li><span class="code-file-code code-file-ign">!!</span><span>${escapeHtml(file.path)}</span><span class="code-ignored-size">${file.path.endsWith("/") ? `${file.files.toLocaleString()} ${file.files === 1 ? "file" : "files"} · ` : ""}${file.truncated ? "≥ " : ""}${bytes(file.bytes)}${file.newest ? ` · ${ago(file.newest)}` : ""}</span></li>`).join("")}</ul><p class="code-muted">Removing the worktree deletes these. Dependency and build caches are not listed.</p>` : `<p class="code-muted">Only dependency and build caches. Nothing hand-made.</p>`}</section>`;
}

// The running (or exited) local server's URL and the tail of its output.
function runSection(path) {
  const run = runFor(path);
  if (!run) return "";
  const state = run.state === "exited" ? `exited ${run.exitCode}` : run.state;
  const lines = (ui.runLogs.get(path) || []).slice(-24).join("\n");
  return `<section class="code-run"><h4>Local server <span class="code-run-state" data-run-state="${run.state}">${escapeHtml(state)}</span></h4>
    <p>${run.url ? `<a href="${escapeHtml(run.url)}" target="_blank" rel="noreferrer">${escapeHtml(run.url)}</a>` : `<span class="code-muted">Waiting for a localhost URL…</span>`}<span class="code-muted"> · started ${ago(run.startedAt)} ago</span></p>
    <pre class="code-run-log">${escapeHtml(lines)}</pre></section>`;
}

function prDetail(pr) {
  const tree = worktreeFor(pr);
  const extra = ui.detail.get(`pr:${pr.slug}#${pr.number}`);
  return `<header class="code-detail-head">${ciBadge(pr)}<h3><a class="code-pr-link" href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">#${pr.number}</a> ${escapeHtml(pr.title)}</h3><span class="code-side-tools">${iconButton("expand", "PR overview (Enter)", "data-code-pr-overlay")}${ui.data.previews?.includes(pr.repo) ? previewButton(pr) : ""}${copyButton(pr.url, "Copy PR link")}</span></header>
    ${prFacts(pr, tree, tree?.path)}
    ${runSection(tree?.path)}
    ${stackSection(pr)}
    <section><h4>Files <span>${extra?.files?.length ?? ""}</span></h4>${extra ? fileTree(extra.files, diffFileLink) : `<p class="code-muted">Loading…</p>`}</section>
    <section><h4>Commits <span>${extra ? extra.commits.length : ""}</span></h4>${commitList(extra?.commits.slice(-15).reverse(), "No commits.", { repo: pr.repo, slug: pr.slug })}</section>
    ${extra?.body ? descriptionSection(pr, extra.body) : ""}`;
}

// Changed files as a folder tree; single-child folder chains collapse into one row, as in VS Code.
// Folder-tree order for a flat file list; single-child folder chains collapse into one row, as in VS Code.
function treeWalk(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    // Untracked folders arrive from `git status` as "dir/"; keep them as one entry named "dir/".
    const parts = file.path.replace(/\/$/, "").split("/");
    const name = parts.pop() + (file.path.endsWith("/") ? "/" : "");
    let node = root;
    for (const part of parts) node = node.dirs.get(part) || node.dirs.set(part, { dirs: new Map(), files: [] }).get(part);
    node.files.push({ file, name });
  }
  const rows = [];
  const walk = (node, depth) => {
    for (let [name, child] of node.dirs) {
      while (child.dirs.size === 1 && !child.files.length) { const [[next, inner]] = child.dirs; name += `/${next}`; child = inner; }
      rows.push({ dir: true, name, depth });
      walk(child, depth + 1);
    }
    for (const { file, name } of node.files) rows.push({ file, name, depth });
  };
  walk(root, 0);
  return rows;
}

const statusTone = (code) => code === "??" || /A/.test(code) ? "new" : /D/.test(code) ? "del" : "mod";

// The one file list used everywhere (inspector, uncommitted, diff overlay): indent guides and folders on the
// left, a status letter and type badge when known, and +/- counts right-aligned. `attrs(file)` makes a row a link.
// `viewed`, when given, adds a fixed check slot so viewed files line up whatever their name length.
function fileTree(files, attrs, current = null, viewed = null) {
  const rows = treeWalk(files).map((row) => {
    const guides = `<span class="code-ftree-guides">${"<i></i>".repeat(row.depth)}</span>`;
    if (row.dir) return `<li class="is-dir">${guides}<span class="code-ftree-name">${escapeHtml(row.name)}/</span></li>`;
    const { file } = row;
    const status = file.status ? `<b class="code-file-code code-file-${statusTone(file.status)}">${escapeHtml(file.status)}</b>` : "";
    const delta = file.additions === undefined ? "" : `<span class="code-ftree-delta"><b class="code-file-add">+${file.additions}</b><b class="code-file-del">−${file.deletions}</b></span>`;
    const seen = viewed?.(file);
    const check = viewed ? `<span class="code-ftree-viewed" aria-label="${seen ? "Viewed" : ""}">${seen ? "✓" : ""}</span>` : "";
    return `<li class="is-link${seen ? " is-viewed" : ""}" ${attrs(file)} aria-current="${file === current}" title="${escapeHtml(file.path)}">${guides}${status}${file.symlink ? '<span class="code-ftype" style="--ft:#0f8a8a">link</span>' : fileType(file.path)}<span class="code-ftree-name">${escapeHtml(row.name)}</span>${delta}${check}</li>`;
  });
  return `<ul class="code-ftree">${rows.join("")}</ul>`;
}
const diffFileLink = (file) => `data-code-diff-file="${escapeHtml(file.path)}"`;

// A small colored extension badge, so file types read at a glance in the diff file tree.
const FILE_TYPES = { md: "#3b6fd4", mdx: "#3b6fd4", py: "#c69214", ts: "#2f74c0", tsx: "#2f74c0", js: "#b8a000", jsx: "#b8a000", json: "#7a5bd1", css: "#c2417a", html: "#d4572e", svg: "#d4572e", sh: "#3c8a4a", yml: "#8a5a2b", yaml: "#8a5a2b", toml: "#8a5a2b", sql: "#0f8a8a", rs: "#b4492b", go: "#1f8fb3" };
const fileType = (path) => {
  if (path.endsWith("/")) return `<span class="code-ftype" style="--ft:#8792a4">dir</span>`;
  const name = path.split("/").pop();
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return `<span class="code-ftype" style="--ft:${FILE_TYPES[ext] || "#8792a4"}">${escapeHtml(ext.slice(0, 4) || "·")}</span>`;
};

function stackSection(pr) {
  const stack = stackOf(pr);
  if (stack.length < 2) return "";
  return `<section><h4>Stack <span>${stack.indexOf(pr) + 1} of ${stack.length} · on ${escapeHtml(stack[0].base)}</span></h4><ol class="code-stack-list">${stack.map((item, index) => `<li class="${item === pr ? "is-current" : ""}"><b class="code-stack-n">${index + 1}</b>${prChip(item)}<span>${escapeHtml(item.title)}</span></li>`).join("")}</ol></section>`;
}

// A PR body's attached images load through the server, which can sign in to GitHub for them.
const prBodyHtml = (slug, number, body) => renderMarkdown(body.replace(/https:\/\/github\.com\/user-attachments\/assets\/([0-9a-f-]{36})/g, (_, id) => `/api/github-image?${new URLSearchParams({ slug, number, id })}`));

// Long PR bodies collapse to a short preview; the toggle remembers per PR so background refreshes keep it open.
function descriptionSection(pr, body) {
  const key = `${pr.slug}#${pr.number}`;
  const open = ui.openDescriptions.has(key);
  const long = body.length > 600 || body.split("\n").length > 12;
  return `<section><h4>Description</h4><div class="markdown code-description${long && !open ? " is-collapsed" : ""}">${prBodyHtml(pr.slug, pr.number, body)}</div>${long ? `<button type="button" class="code-more" data-code-description="${escapeHtml(key)}">${open ? "Show less" : "Show full description"}</button>` : ""}</section>`;
}

async function loadDetail(key) {
  if (ui.detail.has(key)) return;
  ui.detail.set(key, null);
  ui.detailErrors.delete(key);
  try {
    const commit = key.startsWith("commit:") && commitFor(key);
    const url = commit ? `/api/code/commit?${new URLSearchParams({ repo: commit.repo, sha: commit.sha })}`
      : key.startsWith("tree:") ? `/api/code/worktree?path=${encodeURIComponent(key.slice(5))}`
      : `/api/code/pr?slug=${encodeURIComponent(key.slice(3).split("#")[0])}&number=${key.split("#")[1]}`;
    const response = await fetch(url);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load details.");
    ui.detail.set(key, body);
  } catch (error) {
    ui.detail.delete(key);
    ui.detailErrors.set(key, error.message.split("\n")[0]);
    notify(error.message, true);
  }
  if (ui.sel === key) renderDetail();
  if (diffDialog?.open) renderDiff(); // the overview shows the same details
}

function renderDetail({ animate = false } = {}) {
  const pane = host?.querySelector(".code-detail");
  if (!pane) return;
  const item = selectedItem();
  const html = item.tree ? treeDetail(item.tree) : item.pr ? prDetail(item.pr) : item.commit ? commitDetailPane(item.commit) : `<p class="code-detail-empty">${host.querySelector("[data-code-row]") ? "Select a row to see its commits, files, and actions." : "Nothing to inspect while the list is empty."}<br><br><kbd>↑</kbd><kbd>↓</kbd> or <kbd>J</kbd><kbd>K</kbd> move · <kbd>Enter</kbd> or double-click overview · <kbd>E</kbd> VS Code · <kbd>X</kbd> terminal · <kbd>Y</kbd> copy · <kbd>D</kbd> deployment · <kbd>L</kbd> local server · <kbd>S</kbd> new session · <kbd>1</kbd>–<kbd>4</kbd> review or discuss · <kbd>F</kbd> filter</p>`;
  if (lastHtml.get(pane) !== html) {
    lastHtml.set(pane, html);
    pane.innerHTML = html;
    if (animate) { pane.scrollTop = 0; fadeIn(pane, 160); }
  }
  if (ui.sel) loadDetail(ui.sel);
}

// ---------- page ----------

function toolbar() {
  const count = (value) => ` <span class="code-count">${value}</span>`;
  const segment = (attr, current, options) => `<div class="code-segment">${Object.entries(options).map(([id, label]) => `<button type="button" ${attr}="${id}" aria-pressed="${current === id}">${label}</button>`).join("")}</div>`;
  const trees = ui.data.worktrees.filter((tree) => !ui.removed.has(tree.path));
  const counts = { worktrees: trees.length, prs: ui.data.prs.length, commits: commitsInScope()?.length ?? "…", cleanup: trees.filter((tree) => level(tree) === "safe").length };
  const tabs = `<div class="code-segment code-tabs">${Object.entries(TABS).map(([id, label]) => `<button type="button" data-code-tab="${id}" aria-pressed="${ui.tab === id}">${label}${count(counts[id])}</button>`).join("")}</div>`;
  // Scope counts replace the old stat tiles; uncommitted counts wait for the scan.
  const pending = ui.data.scanning && trees.some((tree) => tree.dirty === null);
  let controls = "";
  if (ui.tab === "worktrees") controls = segment("data-code-tree-scope", ui.treeScope, {
    all: `All${count(trees.length)}`,
    today: `24h${count(trees.filter((tree) => Date.now() - tree.activity < DAY).length)}`,
    week: `Week${count(trees.filter((tree) => Date.now() - tree.activity < 7 * DAY).length)}`,
    dirty: `Uncommitted${count(pending ? "…" : trees.filter((tree) => tree.dirty > 0).length)}`,
    pr: `Open PR${count(trees.filter((tree) => prFor(tree)).length)}`,
  });
  if (ui.tab === "prs") controls = segment("data-code-scope", ui.prScope, {
    all: `All${count(ui.data.prs.length)}`,
    requested: `Review requested${count(ui.data.prs.filter((pr) => pr.requestedOfMe).length)}`,
  })
    + authorTrigger()
    + segment("data-code-sort", ui.prSort, { updated: "Updated", created: "Oldest", size: "Largest" })
    + `<label class="code-check"><input type="checkbox" data-code-drafts ${ui.hideDrafts ? "checked" : ""}> No drafts</label><label class="code-check"><input type="checkbox" data-code-failing ${ui.failingOnly ? "checked" : ""}> Failing CI${count(ui.data.prs.filter((pr) => ["FAILURE", "ERROR"].includes(pr.ci)).length)}</label>`;
  if (ui.tab === "commits") controls = commitControls();
  if (ui.tab === "cleanup") controls = cleanupControls();
  const day = ui.day ? `<button type="button" class="code-day-chip" data-code-day="${ui.day}">${new Date(`${ui.day}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })} ×</button>` : "";
  // Sized to its content, with the activity strip spanning both rows; scanning shows as the spinning refresh icon, so nothing shifts.
  return `<div class="code-toolbar"><div class="code-toolbar-rows"><div class="code-toolbar-row">${tabs}<label class="code-filter"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.75"/><path d="m10.5 10.5 3 3"/></svg><input type="search" data-code-filter placeholder="Filter  (F)" value="${escapeHtml(ui.filter)}" spellcheck="false"></label><span class="code-spacer"></span>${iconButton("refresh", ui.data.scanning ? "Scanning worktrees, CI, and PR history…" : "Refresh everything  (R)", `data-code-refresh class="code-icon-button${ui.data.scanning ? " is-spinning" : ""}"`)}${iconButton("settings", `Tracked repositories (${ui.data.repos.length})`, 'popovertarget="code-settings" data-code-settings')}</div>${controls || day ? `<div class="code-controls">${day}${controls}</div>` : ""}</div>${activityStrip(trees)}</div>`;
}

// Tracked repositories live in a settings popover opened from the toolbar gear.
function repoBar() {
  const repos = ui.data.repos.map((repo) => `<li><span><b>${escapeHtml(repoName(repo))}</b><code>${escapeHtml(repo.replace(/^\/Users\/[^/]+/, "~"))}</code></span><button type="button" class="code-icon-button" data-code-remove-repo="${escapeHtml(repo)}" data-tip="Stop tracking (nothing on disk changes)" aria-label="Stop tracking ${escapeHtml(repo)}">${icon("trash")}</button></li>`).join("");
  return `<h3>Tracked repositories</h3><p class="code-muted">Worktrees and open PRs come from these checkouts. Stored in <code>${escapeHtml(config().code.reposFile)}</code>.</p><ul class="code-repo-list">${repos || '<li class="code-muted">None yet.</li>'}</ul><form class="code-repo-add" data-code-add-repo><input name="path" placeholder="~/repos/my-app" autocomplete="off" spellcheck="false" aria-label="Repository path"><button type="submit" class="code-bar-button">Add</button></form>`;
}

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Fade swapped content in from an already-visible start, so big swaps read as one change instead of a flash.
function fadeIn(element, duration = 180) {
  element.animate(reducedMotion()
    ? [{ opacity: 0.4 }, { opacity: 1 }]
    : [{ opacity: 0.4, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration, easing: EASE_OUT });
}

// Replace a region only when its markup changed; background polls that change nothing touch nothing.
const lastHtml = new WeakMap();
function patch(region, html) {
  const element = host.querySelector(`[data-region="${region}"]`);
  if (lastHtml.get(element) === html) return null;
  lastHtml.set(element, html);
  element.innerHTML = html;
  return element;
}

function render({ animate = false } = {}) {
  if (!host || !ui.data || !host.querySelector(".code-surface, .code-loading")) return;
  if (!host.querySelector(".code-surface")) {
    host.innerHTML = `<section class="code-surface" aria-label="Code dashboard"><div data-region="toolbar"></div><div data-region="errors"></div><div class="code-split"><div class="code-list" data-region="list"></div><aside class="code-detail" data-region="detail" aria-live="polite"></aside></div><div id="code-settings" class="code-settings" popover data-region="repos" aria-label="Code dashboard settings"></div><div id="code-branches" class="code-settings code-branch-pop" popover aria-label="Filter by branch"><label class="code-filter"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.75"/><path d="m10.5 10.5 3 3"/></svg><input type="search" data-branch-query placeholder="Find a branch" spellcheck="false" autocomplete="off"></label><ul class="code-branch-list" data-branch-list></ul><div class="code-branch-actions" data-branch-actions></div><p class="code-muted"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> toggle · <kbd>Shift</kbd>+<kbd>Enter</kbd> only this · <kbd>Esc</kbd> close</p></div><div id="code-authors" class="code-settings code-branch-pop code-author-pop" popover aria-label="Filter by author"><label class="code-filter"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.75"/><path d="m10.5 10.5 3 3"/></svg><input type="search" data-author-query placeholder="Find an author" spellcheck="false" autocomplete="off"></label><ul class="code-branch-list code-author-list" data-author-list></ul><div class="code-branch-actions" data-author-actions></div><p class="code-muted"><kbd>↑</kbd><kbd>↓</kbd> · <kbd>Enter</kbd> toggle · <kbd>Shift</kbd>+<kbd>Enter</kbd> only · <kbd>Esc</kbd> close</p></div></section>`;
    animate = true;
    // The toolbar stays stuck at the top; table headers and the inspector stick just below its live height.
    new ResizeObserver(([entry]) => host.style.setProperty("--code-bar-h", `${Math.ceil(entry.borderBoxSize[0].blockSize)}px`)).observe(host.querySelector('[data-region="toolbar"]'));
  }
  const filter = host.querySelector("[data-code-filter]");
  const focused = document.activeElement === filter;
  const caret = filter?.selectionStart;
  if (ui.tab === "commits") loadCommits();
  const body = ui.tab === "prs" ? prsBody() : ui.tab === "commits" ? commitsBody() : ui.tab === "cleanup" ? cleanupBody() : worktreesBody();
  hideTip();
  patch("toolbar", toolbar());
  patch("errors", ui.data.errors.map((error) => `<p class="work-warning">${escapeHtml(error)}</p>`).join(""));
  const list = patch("list", body);
  if (list && animate) fadeIn(list);
  patch("repos", repoBar());
  renderDetail();
  if (focused) {
    const next = host.querySelector("[data-code-filter]");
    if (next !== document.activeElement) { next.focus(); next.setSelectionRange(caret, caret); }
  }
}

async function load(refresh = false) {
  window.clearTimeout(ui.poll);
  try {
    const response = await fetch(refresh ? "/api/code?refresh" : "/api/code");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load the code dashboard.");
    ui.data = data;
    const paths = new Set(data.worktrees.map((tree) => tree.path));
    for (const path of ui.selected) if (!paths.has(path)) ui.selected.delete(path);
    if (!ui.removing) for (const path of ui.removed) if (!paths.has(path)) ui.removed.delete(path);
    if (refresh) { ui.detail.clear(); ui.commits.clear(); }
    render();
    if (diffDialog?.open) renderDiff(); // an overview opened from the URL learns its worktree here
    // Agents wait on [data-code-state="ready"] instead of polling the table.
    if (host) host.dataset.codeState = data.scanning ? "scanning" : "ready";
    if (data.scanning && host?.isConnected) ui.poll = window.setTimeout(load, 2500);
    pollRuns();
  } catch (error) {
    notify(error.message, true);
  }
}

// Follows every local server the viewer started: state, URL and output, quickly while one is starting.
let runTimer = 0;
async function pollRuns() {
  window.clearTimeout(runTimer);
  const paths = Object.keys(ui.data?.runs || {});
  if (!paths.length || !host?.isConnected) return;
  const results = await Promise.all(paths.map((path) => fetch(`/api/code/run?path=${encodeURIComponent(path)}`).then((response) => response.json()).catch(() => null)));
  paths.forEach((path, index) => {
    const next = results[index];
    if (!next) return;
    if (next.state === "stopped") { delete ui.data.runs[path]; ui.runLogs.delete(path); return; }
    if (next.url && !ui.data.runs[path]?.url) notify(`Local server for ${shortPath(path)} is up at ${next.url}`);
    const { log, command, ...run } = next;
    ui.data.runs[path] = run;
    ui.runLogs.set(path, log);
  });
  render();
  if (diffDialog?.open) renderDiff();
  const live = Object.values(ui.data.runs).filter((run) => run.state !== "exited");
  if (live.length) runTimer = window.setTimeout(pollRuns, live.some((run) => run.state === "starting") ? 1000 : 4000);
}

async function startRun({ path, repo, branch }) {
  notify(path ? `Starting the local server in ${shortPath(path)}…` : `Checking out ${branch} into a new worktree, then starting its local server. Setup can take a few minutes.`);
  const run = await post("run", path ? { path } : { repo, branch });
  ui.data.runs = { ...ui.data.runs, [run.path]: run };
  if (!path) await load(); // the new worktree joins the list
  else pollRuns();
}

async function stopRun(path) {
  await post("stop-run", { path });
  delete ui.data.runs[path];
  ui.runLogs.delete(path);
  render();
  if (diffDialog?.open) renderDiff();
}

function syncUrl() {
  const url = new URL(location.href);
  url.search = new URLSearchParams({ view: "code", ...(ui.tab === "prs" ? {} : { tab: ui.tab }), ...(ui.authors.size ? { author: [...ui.authors].join(",") } : {}) });
  history.replaceState(null, "", url);
}

function resetFilters() {
  Object.assign(ui, { filter: "", day: "", treeScope: "all", prScope: "all", hideDrafts: false, failingOnly: false });
  ui.branches.clear(); ui.prefixes.clear(); ui.authors.clear(); syncUrl();
  const input = host?.querySelector("[data-code-filter]");
  if (input) input.value = "";
}

// Keyboard moves (scroll = true) stay instant; a click fades the pane in.
function select(key, scroll = false) {
  ui.sel = key;
  const { pr } = selectedItem();
  if (pr) prefetchPr(pr.slug, pr.number);
  for (const row of host.querySelectorAll("[data-code-row]")) row.setAttribute("aria-selected", String(row.dataset.codeRow === key));
  if (scroll) host.querySelector(`[data-code-row="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
  renderDetail({ animate: !scroll });
}

async function copy(button, value) {
  try {
    await navigator.clipboard.writeText(value);
    copied(button);
  } catch {
    notify("Could not copy. Select the text and copy it manually.", true);
  }
}

// Confirms a copy in place: the button's icon becomes a check for a moment.
function copied(button) {
  button.classList.remove("is-copied");
  void button.offsetWidth;
  button.classList.add("is-copied");
  const svg = button.querySelector(".code-icon");
  const original = svg?.innerHTML;
  if (svg) svg.innerHTML = ICONS.check;
  window.setTimeout(() => { button.classList.remove("is-copied"); if (svg) svg.innerHTML = original; }, 1100);
}

async function removeSelected() {
  const paths = [...ui.selected];
  if (!confirm(`Remove ${paths.length} worktree folders with \`git worktree remove\`?\n\nBranches and commits stay. Git refuses any worktree with uncommitted or untracked changes. Ignored files (node_modules, local config) in those folders are deleted.`)) return;
  ui.removing = { done: 0, total: paths.length };
  const failed = [];
  render();
  // Small batches so the progress bar moves and one slow `rm` of node_modules doesn't hold the whole request.
  for (let index = 0; index < paths.length; index += 4) {
    try {
      const { results } = await post("remove-worktrees", { paths: paths.slice(index, index + 4) });
      for (const result of results) {
        ui.selected.delete(result.path);
        if (result.ok) ui.removed.add(result.path);
        else failed.push(`${repoName(result.path)}: ${result.error}`);
      }
    } catch (error) {
      failed.push(error.message);
    }
    ui.removing.done = Math.min(paths.length, index + 4);
    render();
  }
  ui.removing = null;
  notify(failed.length ? `Removed ${paths.length - failed.length}. Git refused ${failed.length}: ${failed.slice(0, 4).join("; ")}${failed.length > 4 ? "…" : ""}` : `Removed ${paths.length} worktrees. Branches are untouched.`, failed.length > 0);
  await load();
}

async function handleClick(event) {
  const branchRow = event.target.closest("[data-branch-row]");
  if (branchRow && !event.target.closest("[data-branch-only]")) { event.preventDefault(); return toggleBranch(branchRow.dataset.branchRow); }
  const authorRow = event.target.closest("[data-author-row]");
  if (authorRow && !event.target.closest("[data-author-only]")) { event.preventDefault(); return toggleAuthor(authorRow.dataset.authorRow); }
  const target = event.target.closest("button, input[type=checkbox], a");
  const row = event.target.closest("[data-code-row]");
  const diffFile = event.target.closest("[data-code-diff-file]");
  if (diffFile && !target) {
    const { pr, tree } = selectedItem();
    if (pr) return openPrOverlay(pr.slug, pr.number, diffFile.dataset.codeDiffFile);
    if (tree) return openWorktreeOverlay(tree.path, diffFile.dataset.codeDiffFile, "uncommitted");
    return openDiff(diffFile.dataset.codeDiffFile);
  }
  if (!target) {
    if (!row) return;
    select(row.dataset.codeRow);
    return;
  }
  if (target.matches("a")) return;
  const { dataset } = target;
  try {
    if (dataset.codeCopy !== undefined) return copy(target, dataset.codeCopy);
    if (dataset.codeTab) { ui.tab = codeTab(dataset.codeTab); syncUrl(); return render({ animate: true }); }
    if (dataset.codeDay) { ui.day = ui.day === dataset.codeDay ? "" : dataset.codeDay; ui.tab = "worktrees"; ui.treeScope = "all"; syncUrl(); return render({ animate: true }); }
    if (dataset.codeGuard) {
      cleanupGuard = dataset.codeGuard;
      storage.set("code-cleanup-guard", cleanupGuard);
      for (const path of ui.selected) { const tree = ui.data.worktrees.find((candidate) => candidate.path === path); if (tree && level(tree) === "fresh") ui.selected.delete(path); }
      return render({ animate: true });
    }
    if ("codeReset" in dataset) { resetFilters(); return render({ animate: true }); }
    if (dataset.codeTreeScope) { ui.treeScope = dataset.codeTreeScope; return render({ animate: true }); }
    if (dataset.codeCommitScope) { ui.commitScope = dataset.codeCommitScope; return render({ animate: true }); }
    if (dataset.codeBranchFilter) return toggleBranch(dataset.codeBranchFilter);
    if (dataset.codeAuthorFilter) return toggleAuthor(dataset.codeAuthorFilter);
    if (dataset.authorOnly) { toggleAuthor(dataset.authorOnly, true); return host.querySelector("#code-authors").hidePopover(); }
    if ("codeAuthorClear" in dataset) { ui.authors.clear(); syncUrl(); render({ animate: true }); return renderAuthorList(); }
    if (dataset.branchOnly) { toggleBranch(dataset.branchOnly, true); return host.querySelector("#code-branches").hidePopover(); }
    if (dataset.codePrefix) { ui.prefixes.has(dataset.codePrefix) ? ui.prefixes.delete(dataset.codePrefix) : ui.prefixes.add(dataset.codePrefix); return render({ animate: true }); }
    if ("codeBranchClear" in dataset) { ui.branches.clear(); ui.prefixes.clear(); render({ animate: true }); return renderBranchList(); }
    if ("branchAll" in dataset) {
      for (const row of host.querySelectorAll("#code-branches [data-branch-row]")) ui.branches.add(row.dataset.branchRow);
      render({ animate: true });
      return renderBranchList();
    }
    if ("codeViewDiff" in dataset) return openDiff();
    if ("codePrOverlay" in dataset) { const { pr } = selectedItem(); return pr && openPrOverlay(pr.slug, pr.number); }
    if ("codeWtOverlay" in dataset) { const { tree } = selectedItem(); return tree && openWorktreeOverlay(tree.path); }
    if (dataset.diffWt) return openWorktreeOverlay(dataset.diffWt);
    if (dataset.codeGotoPr) { ui.tab = "prs"; ui.prScope = "all"; syncUrl(); render({ animate: true }); return select(dataset.codeGotoPr, true); }
    if (dataset.codeCommitDiff) {
      const params = { repo: dataset.repo, sha: dataset.codeCommitDiff, ...(dataset.slug ? { slug: dataset.slug } : {}) };
      return openDiff("", commitTarget(params, dataset.subject, `${dataset.codeCommitDiff.slice(0, 8)} · ${repoName(dataset.repo)}`));
    }
    if (dataset.codeRowDiff) { select(dataset.codeRowDiff); return openDiff(); }
    if (dataset.codeScope) { ui.prScope = dataset.codeScope; return render({ animate: true }); }
    if (dataset.codeSort) { ui.prSort = dataset.codeSort; return render({ animate: true }); }
    if ("codeDrafts" in dataset) { ui.hideDrafts = target.checked; return render({ animate: true }); }
    if ("codeFailing" in dataset) { ui.failingOnly = target.checked; return render({ animate: true }); }
    if ("codeKeep" in dataset) { ui.showKeep = target.checked; return render({ animate: true }); }
    if ("codeRefresh" in dataset) { target.classList.add("is-spinning"); return load(true); }
    if (dataset.codeSelect) { target.checked ? ui.selected.add(dataset.codeSelect) : ui.selected.delete(dataset.codeSelect); return render(); }
    if (dataset.codeSelectGroup || dataset.codeSelectLevel) {
      const name = dataset.codeSelectGroup || dataset.codeSelectLevel;
      const on = dataset.codeSelectLevel ? true : target.checked;
      for (const tree of ui.data.worktrees.filter((candidate) => level(candidate) === name && !ui.removed.has(candidate.path) && matches(`${candidate.branch} ${candidate.path} ${candidate.cleanup.reason}`))) {
        on ? ui.selected.add(tree.path) : ui.selected.delete(tree.path);
      }
      return render();
    }
    if (dataset.codeDescription) {
      ui.openDescriptions.has(dataset.codeDescription) ? ui.openDescriptions.delete(dataset.codeDescription) : ui.openDescriptions.add(dataset.codeDescription);
      return renderDetail();
    }
    if ("codeSelectNone" in dataset) { ui.selected.clear(); return render(); }
    if ("codeRun" in dataset) return startRun({ path: dataset.path, repo: dataset.repo, branch: dataset.branch });
    if (dataset.codeStopRun) return stopRun(dataset.codeStopRun);
    if (dataset.codePreview) { notify(`Opening the PR #${dataset.codePreview} deployment…`); await post("preview", { repo: dataset.repo, number: dataset.codePreview }); return; }
    if (dataset.codeOpen) { await post("open", { kind: dataset.codeOpen, path: dataset.path }); return; }
    if ("codeSession" in dataset) { await post("session", { app: agentApp(), path: dataset.path }); notify(`Opened a ${appName()} session in ${shortPath(dataset.path)}.`); return; }
    if (dataset.codeSkill) {
      await post("agent", { app: agentApp(), skill: dataset.codeSkill, url: dataset.url, path: dataset.path });
      notify(`Drafted ${dataset.codeSkill} in ${appName()}. Review it and press Enter to send.`);
      return;
    }
    if (dataset.codeRemoveRepo) {
      if (!confirm(`Stop tracking ${dataset.codeRemoveRepo}? Nothing on disk changes.`)) return;
      await post("remove-repo", { path: dataset.codeRemoveRepo });
      return load();
    }
    if ("codeCleanupAgent" in dataset) {
      await post("cleanup-agent", { app: agentApp(), paths: [...ui.selected] });
      notify(`Drafted a cleanup review of ${ui.selected.size} worktrees in ${appName()}.`);
      return;
    }
    if ("codeRemove" in dataset) return removeSelected();
  } catch (error) {
    notify(error.message, true);
  }
}

function move(step) {
  const rows = [...host.querySelectorAll("[data-code-row]:not(.is-removed)")];
  if (!rows.length) return;
  const index = rows.findIndex((row) => row.dataset.codeRow === ui.sel);
  const next = rows[Math.max(0, Math.min(rows.length - 1, index < 0 ? 0 : index + step))];
  select(next.dataset.codeRow, true);
}

// Page keys run before the global shortcuts (which skip prevented events), so J/K move rows here instead of sections.
function handleKey(event) {
  if (!host?.querySelector(".code-surface") || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
  if (document.querySelector("dialog[open], :popover-open:not(.code-tip)")) return;
  const filter = event.target.matches?.("[data-code-filter]");
  if (event.target.closest?.("input, textarea, select, [contenteditable]")) {
    // Esc clears the search; on an empty list it also clears the filters, as the empty state's button says
    if (filter && event.key === "Escape") { if (host.querySelector("[data-code-reset]")) resetFilters(); ui.filter = ""; event.target.value = ""; event.target.blur(); render(); event.preventDefault(); }
    if (filter && event.key === "ArrowDown") { event.target.blur(); move(1); event.preventDefault(); }
    return;
  }
  const key = event.key.toLowerCase();
  const item = selectedItem();
  const tree = item.tree || (item.pr && worktreeFor(item.pr)) || (item.commit?.worktree && ui.data.worktrees.find((candidate) => candidate.path === item.commit.worktree));
  const skill = (index) => item.pr && post("agent", { app: agentApp(), skill: ui.data.skills[index].id, url: item.pr.url, path: tree?.path || item.pr.repo }).then(() => notify(`Drafted ${ui.data.skills[index].id} in ${appName()}. Review it and press Enter to send.`));
  const copyText = (text) => navigator.clipboard.writeText(text).then(() => notify(`Copied ${text}`));
  const actions = {
    arrowdown: () => move(1), j: () => move(1), arrowup: () => move(-1), k: () => move(-1),
    f: () => host.querySelector("[data-code-filter]")?.focus(),
    r: () => { host.querySelector("[data-code-refresh]")?.classList.add("is-spinning"); return load(true); },
    escape: () => { if (!host.querySelector("[data-code-reset]")) return; resetFilters(); render({ animate: true }); },
    b: () => ui.tab === "commits" && host.querySelector("#code-branches")?.showPopover(),
    a: () => host.querySelector("#code-authors")?.showPopover(),
    enter: () => item.commit ? openDiff() : item.pr ? openPrOverlay(item.pr.slug, item.pr.number) : item.tree && openWorktreeOverlay(item.tree.path),
    e: () => tree && post("open", { kind: "vscode", path: tree.path }),
    x: () => tree && post("open", { kind: "terminal", path: tree.path }),
    s: () => tree && post("session", { app: agentApp(), path: tree.path }).then(() => notify(`Opened a ${appName()} session in ${shortPath(tree.path)}.`)),
    y: () => copyText(item.commit ? item.commit.sha : item.pr ? item.pr.url : tree.path),
    d: () => { const pr = item.pr || prFor(item.tree); if (!pr || !ui.data.previews?.includes(pr.repo)) return; notify(`Opening the PR #${pr.number} deployment…`); return post("preview", { repo: pr.repo, number: String(pr.number) }); },
    l: () => {
      const pr = item.pr || (item.tree && prFor(item.tree));
      const repo = tree?.repo || pr?.repo;
      if (!ui.data.runnable?.includes(repo)) return;
      const run = runFor(tree?.path);
      if (run && run.state !== "exited") return stopRun(tree.path);
      if (tree || config().code.run?.worktree) return startRun({ path: tree?.path, repo, branch: tree?.branch || pr.branch });
    },
    1: () => skill(0), 2: () => skill(1), 3: () => skill(2), 4: () => skill(3),
  };
  const always = ["arrowdown", "arrowup", "j", "k", "f", "r", "a", "b", "escape"];
  if (key === "a" && !["prs", "commits"].includes(ui.tab)) return; // elsewhere A stays the global Tasks shortcut
  if (!actions[key] || (!always.includes(key) && !item.tree && !item.pr && !item.commit)) return;
  event.preventDefault();
  Promise.resolve(actions[key]()).catch((error) => notify(error.message, true));
}

// One tooltip element on <body>, clamped to the viewport, so tips escape scrolling panes and never cause overflow.
let tip = null;
let tipHiddenAt = 0;
function showTip(target) {
  tip ||= Object.assign(document.body.appendChild(document.createElement("div")), { className: "code-tip", role: "tooltip", popover: "manual" });
  // A popover sits in the top layer; reopening it puts it above any overlay opened since.
  if (!tip.classList.contains("is-visible")) { if (tip.matches(":popover-open")) tip.hidePopover(); tip.showPopover(); }
  tip.classList.toggle("is-instant", tip.classList.contains("is-visible") || Date.now() - tipHiddenAt < 300);
  tip.textContent = target.dataset.tip;
  tip.classList.add("is-visible");
  const anchor = target.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  const left = Math.max(8, Math.min(innerWidth - box.width - 8, anchor.left + anchor.width / 2 - box.width / 2));
  const above = anchor.top - box.height - 6;
  tip.style.left = `${left}px`;
  tip.style.top = `${above >= 8 ? above : anchor.bottom + 6}px`;
}
const hideTip = () => { if (tip?.classList.contains("is-visible")) { tip.classList.remove("is-visible"); tipHiddenAt = Date.now(); } };

// ---------- hover cards (whole app) ----------

// Shared by the link card (app.js) and the commit card: `+12,040 −9,600 · 1,031 files`, a zero side muted.
export const diffSize = ({ additions = 0, deletions = 0, files = 0 }) => `<span class="hover-card-diff"><b${additions ? "" : ' class="is-zero"'}>+${additions.toLocaleString()}</b> <i${deletions ? "" : ' class="is-zero"'}>−${deletions.toLocaleString()}</i> · ${files.toLocaleString()} file${files === 1 ? "" : "s"}</span>`;
export const modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
const defaultFirst = (branches) => [...branches].sort((a, b) => /^(main|master)$/.test(b) - /^(main|master)$/.test(a));

// ---------- commit hover cards (whole app) ----------

// Any commit link (github.com/<github.owner>/<repo>/commit/<sha>) gets a hover card with a terse summary; clicking the
// card opens the diff overlay. A manual popover, so it also sits above an open dialog.
export const commitLinkMatch = (href) => config().github.owner && href?.match(new RegExp(`github\\.com/${escapeRegExp(config().github.owner)}/([\\w.-]+)/commit/([0-9a-f]{7,40})`));
const summaries = new Map();
let card = null;
let cardFor = null;
let cardTimer = 0;

function commitCard() {
  if (card) return card;
  card = Object.assign(document.body.appendChild(document.createElement("div")), { className: "hover-card code-hovercard", popover: "manual" });
  card.addEventListener("pointerenter", () => window.clearTimeout(cardTimer));
  card.addEventListener("pointerleave", () => hideCardSoon());
  card.addEventListener("click", () => {
    if (card.classList.contains("is-error")) return; // nothing to open; ⌘-click the link for GitHub
    const { name, sha } = card.dataset;
    hideCard();
    openCommit(name, sha);
  });
  return card;
}

function hideCard() { window.clearTimeout(cardTimer); cardFor = null; if (card?.matches(":popover-open")) card.hidePopover(); }
function hideCardSoon() { window.clearTimeout(cardTimer); cardTimer = window.setTimeout(hideCard, 180); }

function fillCard(name, sha) {
  const summary = summaries.get(`${name}@${sha}`);
  const box = commitCard();
  box.dataset.name = name;
  box.dataset.sha = sha;
  box.dataset.subject = summary?.subject || "";
  box.classList.toggle("is-error", Boolean(summary?.error));
  // Same anatomy as the link card: source and where it came from, title, facts, then what a click does.
  const note = summary && !summary.error && !summary.local ? '<span class="hover-card-note">Not on this machine</span>' : "";
  const head = `<div class="hover-card-head">${SERVICE_ICONS.github}<span class="hover-card-name">${escapeHtml(name)}@${escapeHtml(sha.slice(0, 8))}</span>${note}</div>`;
  const line = (html) => `<div class="hover-card-line">${html}</div>`;
  const hint = `<div class="hover-card-hint">Click to open the diff · ${modKey}-click opens GitHub</div>`;
  box.innerHTML = !summary ? `${head}<div class="hover-card-skeleton is-title"></div><div class="hover-card-skeleton"></div><div class="hover-card-skeleton"></div>${hint}` // a loaded card's height, so it doesn't jump
    : summary.error ? `${head}<div class="hover-card-line is-wrap">${escapeHtml(summary.error)}</div><div class="hover-card-hint">${modKey}-click opens GitHub</div>`
    : `${head}<div class="hover-card-title">${escapeHtml(summary.subject)}</div>${line(`${escapeHtml(summary.author)} · ${ago(summary.time)} ago · ${diffSize(summary)}`)}${commitPlaceLine(summary)}${hint}`;
}

// "#1940 · Merged into main · Title", else the branches that contain it (default branch first). State and base lead so
// the title, not the state, is what truncates; the overlay's one-line version names the title only on the PR button's tip.
function commitPlaceLine(summary) {
  const text = summary.prs?.length ? summary.prs.map((pr) => `#${pr.number} · ${pr.state} into ${pr.base} · ${pr.title}`).join("; ")
    : summary.branches?.length ? `On ${defaultFirst(summary.branches).join(", ")}` : "";
  return text ? `<div class="hover-card-line">${escapeHtml(text)}</div>` : "";
}
function commitPlace(context) {
  if (context?.prs?.length) return ` · in ${context.prs.map((pr) => `<button type="button" class="code-pr-link code-commit-pr-button" data-commit-pr="${escapeHtml(`${pr.slug}#${pr.number}`)}" data-tip="${escapeHtml(`${pr.title} · open the PR overview`)}">#${pr.number}</button> ${escapeHtml(pr.state.toLowerCase())} into ${escapeHtml(pr.base)}`).join("; ")}`;
  return context?.branches?.length ? ` · on ${defaultFirst(context.branches).map(escapeHtml).join(", ")}` : "";
}

async function commitSummaryFor(name, sha) {
  const key = `${name}@${sha}`;
  if (summaries.has(key)) return summaries.get(key);
  try {
    const response = await fetch(`/api/code/commit-summary?${new URLSearchParams({ name, sha })}`);
    const body = await response.json();
    summaries.set(key, response.ok ? body : { error: body.error || "Commit not found." });
  } catch {
    summaries.set(key, { error: "Could not load the commit." });
  }
  return summaries.get(key);
}

// Opens a commit named in a document (`<repo>@<sha>`) in the diff overlay at once; its subject and PR arrive after.
export async function openCommit(name, sha) {
  loadHighlighter();
  const label = `${name}@${sha.slice(0, 8)}`;
  const known = summaries.get(`${name}@${sha}`);
  const target = (summary) => commitTarget({ name, sha }, summary?.subject, summary?.author ? `${label} · ${summary.author} · ${ago(summary.time)} ago` : label, summary?.error ? null : summary);
  const opening = openDiff("", target(known));
  if (known) return opening;
  const summary = await commitSummaryFor(name, sha);
  const params = diff.params;
  if (diffDialog?.open && params?.source === "commit" && params.sha === sha && params.name === name) { Object.assign(diff, target(summary), { params }); renderDiff(); }
}

function placeCard(link) {
  const box = commitCard();
  if (!box.matches(":popover-open")) box.showPopover();
  const anchor = link.getBoundingClientRect();
  const size = box.getBoundingClientRect();
  box.style.left = `${Math.max(12, Math.min(innerWidth - size.width - 12, anchor.left))}px`; // same 12px gutter as the link card
  box.style.top = `${anchor.bottom + 6 + size.height > innerHeight ? anchor.top - size.height - 6 : anchor.bottom + 6}px`;
}

async function showCard(link, name, sha) {
  cardFor = link;
  fillCard(name, sha);
  placeCard(link);
  if (summaries.has(`${name}@${sha}`)) return;
  await commitSummaryFor(name, sha);
  if (cardFor === link) { fillCard(name, sha); placeCard(link); }
}

export function installCommitCards({ showNotice } = {}) {
  if (showNotice && notify === noop) notify = showNotice;
  document.addEventListener("pointerover", (event) => {
    const link = event.target.closest?.("a[href]");
    const match = commitLinkMatch(link?.href);
    if (!match) return;
    window.clearTimeout(cardTimer);
    if (cardFor === link) return;
    cardTimer = window.setTimeout(() => showCard(link, match[1], match[2]), 200);
  });
  document.addEventListener("pointerout", (event) => {
    const link = event.target.closest?.("a[href]");
    if (commitLinkMatch(link?.href) && !link.contains(event.relatedTarget)) { if (cardFor === link) hideCardSoon(); else window.clearTimeout(cardTimer); }
  });
  // Keyboard focus shows the same card; Esc dismisses it.
  document.addEventListener("focusin", (event) => {
    const link = event.target.closest?.("a[href]");
    const match = commitLinkMatch(link?.href);
    if (match && cardFor !== link) showCard(link, match[1], match[2]);
  });
  document.addEventListener("focusout", (event) => { if (cardFor && cardFor === event.target.closest?.("a[href]")) hideCard(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && cardFor) hideCard(); });
  document.addEventListener("scroll", () => { if (cardFor) hideCard(); }, { capture: true, passive: true });
}

export function renderCodePage(container, { tab, showNotice }) {
  notify = showNotice;
  ui.tab = codeTab(tab);
  if (host !== container) {
    host = container;
    ui.authors = new Set((new URLSearchParams(location.search).get("author") || "").split(",").filter(Boolean));
    container.addEventListener("click", (event) => { if (container.querySelector(".code-surface")) handleClick(event); });
    // Double-click a row to open what Enter opens: the PR or worktree overview, or a commit's diff.
    container.addEventListener("dblclick", (event) => {
      const row = event.target.closest("[data-code-row]");
      if (!row || event.target.closest("button, a, input, label")) return;
      window.getSelection()?.removeAllRanges(); // the double-click also selected a word
      select(row.dataset.codeRow);
      const { pr, tree, commit } = selectedItem();
      if (pr) openPrOverlay(pr.slug, pr.number);
      else if (tree) openWorktreeOverlay(tree.path);
      else if (commit) openDiff();
    });
    container.addEventListener("input", (event) => {
      if (!event.target.matches("[data-code-filter]")) return;
      ui.filter = event.target.value;
      render();
    });
    container.addEventListener("input", (event) => {
      if (!event.target.matches("[data-branch-query]")) return;
      ui.branchQuery = event.target.value;
      ui.branchActive = 0;
      renderBranchList();
    });
    container.addEventListener("keydown", (event) => { if (event.target.matches("[data-branch-query]")) branchKeys(event); });
    container.addEventListener("input", (event) => {
      if (!event.target.matches("[data-author-query]")) return;
      ui.authorQuery = event.target.value;
      ui.authorActive = 0;
      renderAuthorList();
    });
    container.addEventListener("keydown", (event) => { if (event.target.matches("[data-author-query]")) authorKeys(event); });
    container.addEventListener("submit", async (event) => {
      if (!event.target.matches("[data-code-add-repo]")) return;
      event.preventDefault();
      try {
        const { repo } = await post("add-repo", { path: event.target.elements.path.value.trim() });
        notify(`Tracking ${repo}.`);
        await load();
      } catch (error) {
        notify(error.message, true);
      }
    });
    window.addEventListener("keydown", handleKey, true);
    container.addEventListener("toggle", (event) => {
      if (event.newState !== "open" || !["code-settings", "code-branches", "code-authors"].includes(event.target.id)) return;
      const authors = event.target.id === "code-authors";
      const branches = authors || event.target.id === "code-branches";
      const anchor = container.querySelector(authors ? "[data-code-author-trigger]" : branches ? "[data-code-branch-trigger]" : "[data-code-settings]").getBoundingClientRect();
      const panel = event.target;
      // The pickers follow their trigger through CSS anchors (styles.css); settings, and older browsers, get placed once here.
      if (!branches || !CSS.supports("anchor-name: --a")) {
        panel.style.top = `${anchor.bottom + 6}px`;
        panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, branches ? anchor.left : anchor.right - panel.offsetWidth))}px`;
      }
      const input = panel.querySelector("input");
      input?.focus();
      if (authors) { input.select(); ui.authorActive = 0; renderAuthorList(); }
      else if (branches) { input.select(); ui.branchActive = 0; renderBranchList(); }
    }, true);
    container.addEventListener("pointerover", (event) => {
      const target = event.target.closest("[data-tip]");
      if (target && !target.closest("a[href]") && container.querySelector(".code-surface")) showTip(target); else hideTip();
    });
    container.addEventListener("pointerleave", hideTip);
    window.addEventListener("scroll", hideTip, { capture: true, passive: true });
  }
  container.dataset.codeState = "loading";
  container.innerHTML = `<section class="code-loading"><p class="code-scan">Loading worktrees and pull requests…</p></section>`;
  if (ui.data) render();
  load();
}

// Pieces the Issues page shares, so an issue reads like a PR: icons, tooltips, the facts grid, avatars, PR chips.
export { icon, iconButton, avatar, sideFacts, sideHead, sideStatus, showTip, hideTip, fadeIn, when, heat, ciBadge, prChip, copied };
