// The Steps page (`?view=steps`): every open step of every unfinished task, grouped by who makes the next move, with an
// inspector for the selected step. The Outbox is the same page filtered to outbound kinds (`&kind=outbound`).
import { isSettled, renderWorkGraph, settledWork, showDoneToggle, workStatusIcon } from "./actions.js";
import { GLYPHS } from "./icons.js";
import { escapeHtml } from "./markdown.js";
import { outboundIcon, outboundKindLabel, outboundPanel } from "./outbound.js";

export const MOVES = {
  "you-decide": { group: "You decide", label: "You" },
  "you-act": { group: "You act · friction", label: "You" },
  agent: { group: "Agent", label: "Agent" },
  others: { group: "Others", label: "Others" },
  blocked: { group: "Blocked", label: "Blocked" },
  unclassified: { group: "Needs a kind", label: "Unclassified" },
};
const ORDER = ["you-decide", "you-act", "agent", "others", "blocked", "unclassified"];
const HIDDEN = new Set(["blocked", "unclassified"]);
const OUTBOUND = new Set(["jira-issue", "jira-comment", "jira-edit", "jira-transition", "slack", "pr", "pr-comment", "review-request", "email"]);
export const MOVE_FILTERS = { you: ["you-decide", "you-act"], agent: ["agent"], others: ["others"], all: ORDER };
export const KIND_FILTERS = {
  any: ["Any kind", () => true],
  outbound: ["Outbound", (s) => OUTBOUND.has(s.kind)],
  decision: ["Decisions and choices", (s) => ["decision", "pick-one", "pick-any"].includes(s.kind)],
  agent: ["Agent work", (s) => ["agent", "check-in"].includes(s.kind)],
  byron: ["Only you", (s) => s.kind === "byron"],
  none: ["No kind yet", (s) => !s.kind],
};
const KIND_LABELS = { agent: "Agent", "check-in": "Check-in", decision: "Decision", "pick-one": "Choice", "pick-any": "Choice", "do-all": "Group", byron: "Only you" };
export const kindLabel = (kind) => KIND_LABELS[kind] || (OUTBOUND.has(kind) ? outboundKindLabel(kind) : kind || "—");
export const stepKey = (step) => `${step.task}:${step.id}`;

export function visibleSteps(steps, { move = "all", kind = "any", hidden = false } = {}) {
  const moves = MOVE_FILTERS[move] || ORDER;
  const test = KIND_FILTERS[kind]?.[1] || (() => true);
  return steps.filter((step) => moves.includes(step.move) && test(step) && (hidden || move !== "all" || !HIDDEN.has(step.move)));
}

export function moveCounts(steps, kind = "any") {
  const test = KIND_FILTERS[kind]?.[1] || (() => true);
  const of = (moves) => steps.filter((step) => moves.includes(step.move) && test(step)).length;
  return { you: of(MOVE_FILTERS.you), agent: of(MOVE_FILTERS.agent), others: of(MOVE_FILTERS.others), all: of(ORDER.filter((m) => !HIDDEN.has(m))) };
}

const pill = (step) => {
  const tone = step.move === "you-act" ? "friction" : step.move === "you-decide" ? "you" : step.move;
  const short = step.move === "you-act" ? (step.draft ? "send by hand" : "act") : step.reason.length > 16 ? "decide" : step.reason;
  const text = step.move === "agent" ? `Agent · ${step.running ? "running" : step.reason}` : step.move.startsWith("you") ? `You · ${short}` : MOVES[step.move].label;
  return `<span class="step-move step-move-${tone}" title="${escapeHtml(step.reason)}">${escapeHtml(text)}</span>`;
};

function row(step, selected) {
  const friction = step.move === "you-act" ? `<span class="step-friction-line">${escapeHtml(step.reason)}${step.fix ? ` · fix: ${escapeHtml(step.fix)}` : ""}</span>` : "";
  return `<tr data-select-step="${escapeHtml(stepKey(step))}" aria-selected="${selected}">
    <td class="step-col-title"><button class="task-row-select" type="button" data-select-step="${escapeHtml(stepKey(step))}">${step.move === "you-act" ? '<span class="step-friction-mark" aria-label="Friction">▲</span>' : ""}${escapeHtml(step.title.split(" — ")[0])}</button>${friction}</td>
    <td class="step-col-move">${pill(step)}</td>
    <td class="step-col-kind">${OUTBOUND.has(step.kind) ? outboundIcon(step.kind) : ""}${escapeHtml(kindLabel(step.kind))}</td>
    <td class="step-col-work"><button class="task-list-id" type="button" data-task-path="${escapeHtml(step.path)}" title="${escapeHtml(step.taskTitle)}">${escapeHtml(step.task)}</button> <span class="step-id">${escapeHtml(step.id)}</span></td>
    <td class="step-col-size">${step.size ? `<span class="step-size">${escapeHtml(step.size)}</span>` : '<span class="step-size is-none" title="No size yet">·</span>'}</td>
    <td class="step-col-age">${step.running ? "running" : step.age ? `${step.age}d` : "today"}</td>
  </tr>`;
}

export function stepsTableHtml(steps, filters, selected) {
  const shown = visibleSteps(steps, filters);
  if (!shown.length) return `<p class="task-empty">${filters.kind === "outbound" ? "Nothing waiting to go out." : "No open steps match."}</p>`;
  const groups = ORDER.map((move) => [move, shown.filter((step) => step.move === move)]).filter(([, list]) => list.length);
  return `<table class="task-table step-table">
    <thead><tr><th scope="col">Step</th><th scope="col">Next move</th><th scope="col">Kind</th><th scope="col">Workstream</th><th scope="col">Size</th><th scope="col">Age</th></tr></thead>
    ${groups.map(([move, list]) => `<tbody><tr class="step-group"><th colspan="6" scope="rowgroup">${escapeHtml(MOVES[move].group)} <span>${list.length}</span></th></tr>${list.map((step) => row(step, stepKey(step) === selected)).join("")}</tbody>`).join("")}
  </table>`;
}

export function stepsToolbarHtml(steps, filters, slots, runs = 0) {
  const counts = moveCounts(steps, filters.kind);
  const seg = (key, label) => `<button type="button" class="step-seg" data-step-move="${key}" aria-pressed="${filters.move === key}">${label} <span>${counts[key]}</span></button>`;
  const running = runs;
  const hiddenCount = steps.filter((step) => HIDDEN.has(step.move)).length;
  return `<div class="task-index-tools step-tools">
    <span class="step-segs" role="group" aria-label="Next move">${seg("you", "Next move: You")}${seg("agent", "Agent")}${seg("others", "Others")}${seg("all", "All")}</span>
    <select class="step-kind" data-step-kind aria-label="Kind">${Object.entries(KIND_FILTERS).map(([key, [label]]) => `<option value="${key}"${filters.kind === key ? " selected" : ""}>${label}</option>`).join("")}</select>
    ${filters.move === "all" && hiddenCount ? `<label class="show-done"><input type="checkbox" data-step-hidden${filters.hidden ? " checked" : ""}> Show ${hiddenCount} blocked or without a kind</label>` : ""}
    <span class="step-slots" title="Agent runs started from this page">${running} of ${slots} agent slots in use</span>
  </div>`;
}

// The shared step list (today's plan, a task's Steps panel, the World's Today column, the step dialog's rail): one line per
// step, a short state pill only where it says who moves next, the full title, and right-aligned gray meta. Every row opens
// the step dialog (`data-open-step`); none navigates.
const PILLS = { "you-decide": ["you", "Decide"], "you-act": ["friction", "Friction"], agent: ["agent", "Agent"], others: ["others", "Waiting"], blocked: ["blocked", "Blocked"], unclassified: ["unclassified", "No kind"] };
export const movePill = (step) => {
  const [tone, label] = PILLS[step.move] || PILLS.unclassified;
  return `<span class="step-move step-move-${tone}" title="${escapeHtml(step.reason)}">${step.running ? "Running" : label}</span>`;
};
const TOGGLE_LABELS = { you: "You", agent: "Agent", others: "Others", all: "All" };
// A thin segmented control; `counts` adds a number to each segment, `keys` picks the segments.
export const stepToggleHtml = (move, counts = null, keys = Object.keys(TOGGLE_LABELS)) => `<span class="step-toggle" role="group" aria-label="Next move">${keys.map((key) => `<button type="button" data-step-list-move="${key}" aria-pressed="${move === key}">${TOGGLE_LABELS[key]}${counts && key !== "all" ? ` <span>${counts[key]}</span>` : ""}</button>`).join("")}</span>`;
// Every segment's rows are rendered into one grid cell and only the chosen one is visible, so the panel is always as tall as
// its fullest segment and switching never moves what follows it. `layers` maps a segment to its HTML.
export const stepStackHtml = (move, layers) => `<div class="step-stack">${Object.entries(layers).map(([key, html]) => `<div class="step-layer" data-step-layer="${key}"${key === move ? "" : " inert"}>${html}</div>`).join("")}</div>`;
// Shows one segment of a stack rendered by stepStackHtml; the caller keeps the choice in the URL.
export function showStepLayer(panel, move) {
  for (const button of panel.querySelectorAll("[data-step-list-move]")) button.setAttribute("aria-pressed", String(button.dataset.stepListMove === move));
  for (const layer of panel.querySelectorAll("[data-step-layer]")) layer.inert = layer.dataset.stepLayer !== move;
}
export const stepRowHtml = ({ key, lead = "", pill = "", title, note = "", meta = "", className = "" }) => `<button type="button" class="step-row${className}" data-open-step="${escapeHtml(key)}"><span class="step-row-lead">${lead}</span><span class="step-row-title">${pill}${escapeHtml(title)}${note ? `<span class="step-row-note">${escapeHtml(note)}</span>` : ""}</span><span class="step-row-meta">${meta}</span></button>`;

// A plan's Scheduled tasks section: one row per task bullet with the plan's note for it as plain text (whatever follows the
// task's link or ID, after a colon or dash; indented lines under it continue the note), and the section's other lines.
export function scheduledTasks(markdown) {
  const rows = [], rest = [];
  for (const line of markdown.split("\n")) {
    const id = /^[-*] /.test(line) && line.match(/TASK-\d{4}/)?.[0];
    if (id) rows.push({ id, note: line.replace(/^[-*]\s+(?:\[[^\]]*\]\([^)]*\)|\S*TASK-\d{4}\S*)\s*[:—–-]?\s*/, "") });
    else if (rows.length && /^\s+\S/.test(line)) rows.at(-1).note += ` ${line.trim().replace(/^[-*] /, "")}`;
    else rest.push(line);
  }
  for (const row of rows) row.note = row.note.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").trim();
  return { rows, rest: rest.join("\n") };
}

// A task's Steps panel (its page and its dock's Work panel): the toggle with this task's counts, then every step under a
// light header line per workstream (top-level item), each row with its ID, status icon, a pill only when it waits on you,
// the full title, and gray meta (`ready`, `after W1.2`, `running`, its note count). Completed and deferred steps sit behind
// one quiet toggle at the bottom. `tools` (the page, not the dock) adds Graph, a popover with the dependency graph, and World.
const CHOICE_KINDS = new Set(["pick-one", "pick-any"]);
export function taskStepsHtml({ taskId = "", work, steps = [], actions = [], noteCount = () => 0, showDone = false, move = "all", tools = true }) {
  const { nodes } = work;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = (id) => nodes.filter((n) => n.parent === id);
  const settled = settledWork(nodes);
  // A step is a leaf, a choice (its options show inside it), or a live item whose children are all settled.
  const isRow = (n) => !CHOICE_KINDS.has(byId.get(n.parent)?.kind) && (CHOICE_KINDS.has(n.kind) || !kids(n.id).length || (!settled.has(n.id) && kids(n.id).every((c) => settled.has(c.id))));
  const topOf = (n) => { while (byId.get(n.parent)) n = byId.get(n.parent); return n; };
  const stepOf = (id) => steps.find((step) => step.id === id);
  const rows = nodes.filter(isRow);
  const inLayer = (n, layer) => layer === "all" || (!settled.has(n.id) && MOVE_FILTERS[layer].includes(stepOf(n.id)?.move));
  const key = (n) => `${taskId}:${n.id}`;
  const meta = (n) => {
    const step = stepOf(n.id);
    const waiting = n.deps.filter((dep) => byId.get(dep)?.status !== "completed");
    const state = step?.running ? "running" : isSettled(n.status) || n.status === "waiting" ? n.status : waiting.length ? `after ${waiting.join(", ")}` : n.status === "active" ? "active" : n.ready ? "ready" : n.status;
    const notes = noteCount(n.id);
    return `${notes ? `<span class="step-row-notes" title="${notes} ${notes === 1 ? "update" : "updates"}"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS["message-square"]}</svg>${notes}</span>` : ""}${escapeHtml(state)}`;
  };
  const row = (n) => {
    const step = stepOf(n.id);
    return stepRowHtml({ key: key(n), lead: `<code class="step-row-id">${escapeHtml(n.id)}</code>${workStatusIcon(n, nodes)}`, pill: step?.move.startsWith("you") ? movePill(step) : "", title: n.title, meta: meta(n), className: settled.has(n.id) ? " is-settled" : "" });
  };
  const layer = (name) => {
    const html = nodes.filter((n) => !n.parent).map((top) => {
      const list = rows.filter((n) => topOf(n) === top && inLayer(n, name));
      if (!list.length) return "";
      const head = isRow(top) ? "" : `<button type="button" class="step-group-head${settled.has(top.id) ? " is-settled" : ""}" data-open-step="${escapeHtml(key(top))}"><code>${escapeHtml(top.id)}</code><span>${escapeHtml(top.title)}</span></button>`;
      return head + list.map(row).join("");
    }).join("");
    return `<div class="step-rows">${html || `<p class="step-rows-empty">No steps wait on ${name === "you" ? "you" : name === "agent" ? "an agent" : "others"}.</p>`}</div>`;
  };
  const count = (name) => rows.filter((n) => !settled.has(n.id) && inLayer(n, name)).length;
  const counts = { you: count("you"), agent: count("agent"), others: count("others") };
  const settledRows = rows.filter((n) => settled.has(n.id)).length;
  const graph = tools ? `<button type="button" class="code-bar-button" popovertarget="task-steps-graph" style="anchor-name: --task-steps-graph" aria-expanded="false">Graph</button>
    <div class="step-graph" id="task-steps-graph" popover style="position-anchor: --task-steps-graph" role="dialog" aria-label="Dependency graph"><header><strong>Dependency graph</strong><span>Prerequisite → dependent</span><button type="button" class="work-graph-expand" data-graph-expand aria-label="Expand dependency graph" title="Expand"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/></svg></button></header>${renderWorkGraph(work, actions, "steps", noteCount)}</div>
    ${taskId ? `<button type="button" class="code-bar-button" data-world-task-open="${escapeHtml(taskId)}" title="Everything filed for ${escapeHtml(taskId)} on one timeline (W)">World</button>` : ""}` : "";
  return `<div class="task-steps step-panel"${tools ? ' data-move-default="all"' : ""}>
    <div class="task-steps-tools">${stepToggleHtml(move, counts)}<span class="task-steps-spacer"></span>${graph}</div>
    ${stepStackHtml(move, Object.fromEntries(Object.keys(MOVE_FILTERS).map((name) => [name, layer(name)])))}
    ${settledRows ? showDoneToggle(settledRows, `data-show-done-work${showDone ? " checked" : ""}`) : ""}
  </div>`;
}

function optionsHtml(step) {
  const type = step.kind === "pick-one" ? "radio" : "checkbox";
  const ordered = [...step.options].sort((a, b) => b.recommended - a.recommended);
  return `<form class="step-choice" data-step-pick="${escapeHtml(stepKey(step))}">
    ${ordered.map((option) => `<label class="step-option"><input type="${type}" name="pick" value="${escapeHtml(option.id)}"${option.recommended && type === "radio" ? " checked" : ""}>
      <span><strong>${escapeHtml(option.title)}</strong>${option.recommended ? '<em class="step-recommended">Recommended</em>' : ""}${option.tradeoff ? `<span>${escapeHtml(option.tradeoff)}</span>` : ""}</span></label>`).join("")}
    <div class="outbound-actions"><button type="submit" class="outbound-primary">Pick</button><span class="step-choice-note">${step.kind === "pick-any" ? "Tick any; none is a choice too." : "One option becomes the next step."}</span></div>
  </form>`;
}

const READ_ONLY = /^\s*\(*\s*(select|with|show|describe|desc)\b/i;
const readOnly = (sql) => READ_ONLY.test(sql) && !sql.trim().replace(/;\s*$/, "").includes(";");
const button = (action, label, primary = false, disabled = "") => `<button type="button" class="${primary ? "outbound-primary" : "outbound-secondary"}" data-step-action="${action}"${disabled ? ` disabled title="${escapeHtml(disabled)}"` : ""}>${label}</button>`;

// What the inspector lets you do now: start an agent, run or copy a statement, apply a rule, or mark it done.
// `compact` (the step dialog's header) drops the explanatory notes beside the buttons.
export function stepActionsHtml(step, { startConfigured = false, runConfigured = false, freeSlots = 0, compact = false } = {}) {
  const f = step.machinery?.fields || {};
  const note = (text) => compact ? "" : `<span class="step-choice-note">${text}</span>`;
  if (step.draft) return ""; // an outbound step's panel has its own Approve, Mark sent and Drop
  if (step.move === "agent" && !step.draft && !step.running) {
    const why = !startConfigured ? "Set steps.start in viewer.config.json" : freeSlots < 1 ? "All agent slots are in use" : "";
    return `<div class="outbound-actions step-actions">${button("start", "Start", true, why)}${note(step.prompt ? "Runs its prompt as a local agent session." : "No prompt: the agent gets the step title and the task.")}</div>`;
  }
  if (step.running) return `<p class="outbound-note">An agent is running this step.</p>`;
  if (f.apply) return `<div class="outbound-actions step-actions">${button("apply", "Apply", true)}${note("Adds it to the workspace's Claude settings.")}</div>`;
  if (step.move === "you-act") {
    if (f.run && readOnly(f.run)) return `<div class="outbound-actions step-actions">${button("run", "Approve and run", true, runConfigured ? "" : "Set steps.run in viewer.config.json")}${button("done", "Mark done")}</div>`;
    return `<div class="outbound-actions step-actions">${f.run ? button("copy-statement", "Copy statement", true) : ""}${button("done", "Mark done", !f.run)}</div>`;
  }
  if (step.move === "you-decide" && step.kind === "decision") return `<div class="outbound-actions step-actions">${button("done", "Mark decided", compact)}${note("Record the decision in the task, then mark it.")}</div>`;
  return "";
}

function machineryHtml(step) {
  const f = step.machinery?.fields || {};
  return `${f.apply ? `<div class="step-run"><h5>Allow rule</h5><pre><code>${escapeHtml(f.apply)}</code></pre></div>` : ""}${f.run ? `<div class="step-run"><h5>Statement${readOnly(f.run) ? " · read-only" : " · changes data"}</h5><pre><code>${escapeHtml(f.run)}</code></pre>${f.target ? `<p class="outbound-note">Runs as ${escapeHtml(f.target)}${f.undo ? ` · undo: <code>${escapeHtml(f.undo)}</code>` : ""}</p>` : ""}</div>` : ""}
    ${step.machinery ? `<p class="outbound-note"><a class="markdown-document-link" href="?path=${encodeURIComponent(step.machinery.path)}" data-document-path="${escapeHtml(step.machinery.path)}" data-document-anchor="">Open ${escapeHtml(step.machinery.path.split("/").pop())}</a></p>` : ""}`;
}

// A choice's options, an outbound draft's approval panel, or its machinery (and a note when it has no kind yet). Shared by
// the Steps inspector and the step dialog, which each say why the step is where it is in their own way.
export function stepBodyHtml(step) {
  const untyped = step.move === "unclassified" ? `<p class="outbound-note">No kind and no prompt: add <code>{kind, size}</code> to its line, or a prompt under Next actions with <code>Work item: ${escapeHtml(step.id)}</code>.</p>` : "";
  const body = step.options ? optionsHtml(step)
    : step.draft ? outboundPanel(step.draft, { showBody: true })
    : step.machinery ? machineryHtml(step)
    : "";
  return `${untyped}${body}`;
}

export function stepInspectorHtml(step, extra = "", context = {}) {
  if (!step) return `<p class="task-detail-empty">Select a step to see its draft, prompt or options.</p>`;
  const head = `<header class="task-detail-head"><div class="task-detail-badges"><button class="task-list-id" type="button" data-task-path="${escapeHtml(step.path)}">${escapeHtml(step.task)}</button><span class="step-id">${escapeHtml(step.id)}</span>${pill(step)}</div>
      <span class="task-detail-buttons"><button class="task-detail-open" type="button" data-task-path="${escapeHtml(step.path)}">Workstream <span aria-hidden="true">→</span></button></span></header>
    <h3>${escapeHtml(step.title.split(" — ")[0])}</h3>
    <p class="task-detail-meta"><span>${escapeHtml(kindLabel(step.kind))}</span><span>${step.size ? `Size ${escapeHtml(step.size)}` : "No size yet"}</span><span>${escapeHtml(step.status)}</span><span>${escapeHtml(step.taskTitle)}</span></p>`;
  const friction = step.move === "you-act" && !step.draft ? `<p class="step-friction"><strong>Friction:</strong> ${escapeHtml(step.reason)}.${step.fix ? ` <strong>Fix:</strong> ${escapeHtml(step.fix)}.` : ""}</p>` : "";
  const blocked = step.move === "blocked" ? `<p class="outbound-note">Waits on ${escapeHtml(step.reason.replace(/^after /, ""))} in ${escapeHtml(step.task)}.</p>` : "";
  const prompt = step.prompt ? `<section class="task-detail-section"><h4>Prompt${step.actionTitle ? ` <span class="step-action-title">${escapeHtml(step.actionTitle)}</span>` : ""}</h4><pre class="step-prompt">${escapeHtml(step.prompt)}</pre></section>` : "";
  return `${head}${friction}${blocked}${extra}${stepBodyHtml(step)}${stepActionsHtml(step, context)}${prompt}`;
}
