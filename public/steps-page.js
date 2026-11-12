// The Steps page (`?view=steps`): every open step of every unfinished task, grouped by who makes the next move, with an
// inspector for the selected step. The Outbox is the same page filtered to outbound kinds (`&kind=outbound`).
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
  const text = step.move === "agent" ? `Agent · ${step.running ? "running" : step.reason}` : step.move.startsWith("you") ? `You · ${step.reason}` : MOVES[step.move].label;
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
export function stepActionsHtml(step, { startConfigured = false, runConfigured = false, freeSlots = 0 } = {}) {
  const f = step.machinery?.fields || {};
  if (step.move === "agent" && !step.draft && !step.running) {
    const why = !startConfigured ? "Set steps.start in viewer.config.json" : freeSlots < 1 ? "All agent slots are in use" : "";
    return `<div class="outbound-actions step-actions">${button("start", "Start", true, why)}<span class="step-choice-note">${step.prompt ? "Runs its prompt as a local agent session." : "No prompt: the agent gets the step title and the task."}</span></div>`;
  }
  if (step.running) return `<p class="outbound-note">An agent is running this step.</p>`;
  if (f.apply) return `<div class="step-run"><h5>Allow rule</h5><pre><code>${escapeHtml(f.apply)}</code></pre></div><div class="outbound-actions step-actions">${button("apply", "Apply", true)}<span class="step-choice-note">Adds it to the workspace's Claude settings.</span></div>`;
  if (step.move === "you-act") {
    if (f.run && readOnly(f.run)) return `<div class="outbound-actions step-actions">${button("run", "Approve and run", true, runConfigured ? "" : "Set steps.run in viewer.config.json")}${button("done", "Mark done")}</div>`;
    return `<div class="outbound-actions step-actions">${f.run ? button("copy-statement", "Copy statement", true) : ""}${button("done", "Mark done", !f.run)}</div>`;
  }
  if (step.move === "you-decide" && step.kind === "decision") return `<div class="outbound-actions step-actions">${button("done", "Mark decided")}<span class="step-choice-note">Record the decision in the task, then mark it.</span></div>`;
  return "";
}

function machineryHtml(step) {
  const f = step.machinery?.fields || {};
  return `${f.run ? `<div class="step-run"><h5>Statement${readOnly(f.run) ? " · read-only" : " · changes data"}</h5><pre><code>${escapeHtml(f.run)}</code></pre>${f.target ? `<p class="outbound-note">Runs as ${escapeHtml(f.target)}${f.undo ? ` · undo: <code>${escapeHtml(f.undo)}</code>` : ""}</p>` : ""}</div>` : ""}
    ${step.machinery ? `<p class="outbound-note"><a class="markdown-document-link" href="?path=${encodeURIComponent(step.machinery.path)}" data-document-path="${escapeHtml(step.machinery.path)}" data-document-anchor="">Open ${escapeHtml(step.machinery.path.split("/").pop())}</a></p>` : ""}`;
}

export function stepInspectorHtml(step, extra = "", context = {}) {
  if (!step) return `<p class="task-detail-empty">Select a step to see its draft, prompt or options.</p>`;
  const head = `<header class="task-detail-head"><div class="task-detail-badges"><button class="task-list-id" type="button" data-task-path="${escapeHtml(step.path)}">${escapeHtml(step.task)}</button><span class="step-id">${escapeHtml(step.id)}</span>${pill(step)}</div>
      <span class="task-detail-buttons"><button class="task-detail-open" type="button" data-task-path="${escapeHtml(step.path)}">Workstream <span aria-hidden="true">→</span></button></span></header>
    <h3>${escapeHtml(step.title.split(" — ")[0])}</h3>
    <p class="task-detail-meta"><span>${escapeHtml(kindLabel(step.kind))}</span><span>${step.size ? `Size ${escapeHtml(step.size)}` : "No size yet"}</span><span>${escapeHtml(step.status)}</span><span>${escapeHtml(step.taskTitle)}</span></p>`;
  const friction = step.move === "you-act" && !step.draft ? `<p class="step-friction"><strong>Friction:</strong> ${escapeHtml(step.reason)}.${step.fix ? ` <strong>Fix:</strong> ${escapeHtml(step.fix)}.` : ""}</p>` : "";
  const blocked = step.move === "blocked" ? `<p class="outbound-note">Waits on ${escapeHtml(step.reason.replace(/^after /, ""))} in ${escapeHtml(step.task)}.</p>` : "";
  const body = step.options ? optionsHtml(step)
    : step.draft ? outboundPanel(step.draft, { showBody: true })
    : step.machinery ? machineryHtml(step)
    : "";
  const prompt = step.prompt ? `<section class="task-detail-section"><h4>Prompt${step.actionTitle ? ` <span class="step-action-title">${escapeHtml(step.actionTitle)}</span>` : ""}</h4><pre class="step-prompt">${escapeHtml(step.prompt)}</pre></section>` : "";
  const untyped = step.move === "unclassified" ? `<p class="outbound-note">No kind and no prompt: add <code>{kind, size}</code> to its line, or a prompt under Next actions with <code>Work item: ${escapeHtml(step.id)}</code>.</p>` : "";
  return `${head}${friction}${blocked}${untyped}${extra}${body}${stepActionsHtml(step, context)}${prompt}`;
}

