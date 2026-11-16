// Steps: every open work-breakdown line across the workspace's tasks, with who makes the next move. A step stores its
// status, prerequisites and an optional `{kind, size}`; everything else here is derived. Outbound drafts and other
// machinery files (task assets whose front matter names a `step:`) supply the kind when the line doesn't.
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parseActions, parseWorkBreakdown, STEP_FLAGS, STEP_SIZES } from "./public/actions.js";
import { config, withNote } from "./public/config.js";
import { draftFromText, outboundFields, type OutboundDraft } from "./outbound.ts";

export const OUTBOUND_KINDS = new Set(["jira-issue", "jira-comment", "jira-edit", "jira-transition", "slack", "pr", "pr-comment", "review-request", "email"]);
const CHOICES = new Set(["pick-one", "pick-any"]);
export type Priority = "p1" | "p2" | "p3";
export type Move = "you-decide" | "you-act" | "agent" | "others" | "blocked" | "unclassified";

export interface StepOption { id: string; title: string; tradeoff: string; recommended: boolean; status: string }
export interface Step {
  key: string; task: string; taskTitle: string; path: string; id: string; title: string; status: string;
  kind: string; size: string; deps: string[]; next: boolean; move: Move; reason: string; fix?: string; running?: boolean;
  prompt?: string; actionTitle?: string; draft?: OutboundDraft; machinery?: { path: string; fields: Record<string, string> };
  options?: StepOption[]; age: number; order: number;
  priority: Priority; unblocks: number; score: number; scoreParts?: ScorePart[]; planned?: "" | "task" | "step";
  noteFor?: string; notes?: { path: string; title: string }[];
}

interface TaskInput { path: string; id: string; title: string; status: string; updated: string; markdown: string }

const section = (markdown: string, name: string) => markdown.match(new RegExp(`^## ${name}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "mi"))?.[1] || "";
const daysSince = (date: string, now: number) => Math.max(0, Math.floor((now - Date.parse(date)) / 86_400_000));
const splitOption = (title: string) => { const [head, ...rest] = title.split(" — "); return { title: head.trim(), tradeoff: rest.join(" — ").trim() }; };

// Priority: one number per step, so the most important work sorts first everywhere steps are listed. The task's
// `priority:` (p1, p2 or p3; p2 when absent) carries importance, and the rest is derived: a task named in today's plan,
// how many open steps finishing this one unblocks (`after:` dependents, transitively, through scope parents), whether it
// waits on the operator (the one mover who holds everyone else up), its size, and its age. `{next}` still pins a step
// above every score. A step today's plan names by ID (`TASK-0140 W3.2`) counts more than a task it only mentions.
export const PRIORITY_POINTS: Record<Priority, number> = { p1: 30, p2: 0, p3: -20 };
const SIZE_POINTS: Record<string, number> = { S: 10, M: 4, L: 0, "": 4 };
export interface ScorePart { key: string; label: string; points: number; detail: string }
const SIZE_WORDS: Record<string, string> = { S: "small", M: "medium", L: "large", "": "no size yet" };
// The score's parts in the order a waterfall shows them, each with a short label and a detail line; the base is first.
// `unblocked` names the steps behind this one (titles), for the unblocks detail.
export function scoreParts(step: Pick<Step, "priority" | "unblocks" | "size" | "age" | "move">, today: "" | "task" | "step" = "", unblocked: string[] = []): ScorePart[] {
  const yours = step.move === "you-decide" || step.move === "you-act";
  const shown = [...unblocked.slice(0, 4), ...(unblocked.length > 4 ? [`and ${unblocked.length - 4} more`] : [])].join("\n");
  return [
    { key: "base", label: "Base", points: 20, detail: "" },
    { key: "priority", label: `Task priority ${step.priority.toUpperCase()}`, points: PRIORITY_POINTS[step.priority] ?? 0, detail: "" },
    { key: "today", label: today === "step" ? "Named in today's plan" : today === "task" ? "Task in today's plan" : "Not in today's plan", points: today === "step" ? 25 : today === "task" ? 8 : 0, detail: "" },
    { key: "unblocks", label: step.unblocks ? `Unblocks ${step.unblocks} ${step.unblocks === 1 ? "step" : "steps"}` : "Unblocks nothing", points: Math.round(10 * Math.log2(1 + step.unblocks)), detail: shown },
    { key: "yours", label: yours ? "Waits on you" : "Not waiting on you", points: yours ? 10 : 0, detail: "" },
    { key: "size", label: `Size: ${SIZE_WORDS[step.size] ?? step.size}`, points: SIZE_POINTS[step.size] ?? 4, detail: "" },
    { key: "age", label: `Age: ${step.age ? `${step.age} ${step.age === 1 ? "day" : "days"}` : "new"}`, points: Math.min(step.age, 14), detail: step.age > 14 ? "capped at 14" : "" },
  ];
}
export const totalOf = (parts: ScorePart[]) => Math.max(0, Math.min(99, parts.reduce((sum, part) => sum + part.points, 0)));
export const scoreStep = (step: Pick<Step, "priority" | "unblocks" | "size" | "age" | "move">, today: "" | "task" | "step" = "") => totalOf(scoreParts(step, today));
// Sets a step's score and the parts behind it.
function rank(step: Step, unblocked: string[] = []) {
  step.scoreParts = scoreParts(step, step.planned, unblocked);
  step.score = totalOf(step.scoreParts);
}

// Open steps that can't finish until this one does: work items whose `after:` names it or one of its scope parents,
// then everything under those and everything after them in turn. Counts open leaves only, so scope isn't counted twice.
export const downstreamCount = (nodes: { id: string; parent: string; deps: string[]; status: string }[], id: string) => downstreamSteps(nodes, id).length;
export function downstreamSteps(nodes: { id: string; parent: string; deps: string[]; status: string }[], id: string) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lineage = (x: string) => { const out: string[] = []; for (let n = byId.get(x); n; n = byId.get(n.parent)) out.push(n.id); return out; };
  const under = (x: string) => nodes.filter((n) => n.id !== x && lineage(n.id).includes(x)).map((n) => n.id);
  const live = (n: { status: string }) => !["completed", "deferred"].includes(n.status);
  const seen = new Set<string>(), queue = [id];
  while (queue.length) {
    const from = lineage(queue.shift()!);
    for (const n of nodes) {
      if (seen.has(n.id) || !live(n) || !n.deps.some((dep) => from.includes(dep))) continue;
      for (const y of [n.id, ...under(n.id)]) if (!seen.has(y)) { seen.add(y); queue.push(y); }
    }
  }
  seen.delete(id);
  return [...seen].filter((y) => live(byId.get(y)!) && !nodes.some((c) => c.parent === y));
}

// A work item's title as plain words for a detail line: the text before " — ", links as their labels, under 60 characters.
const plainTitle = (title: string) => {
  const text = title.split(" — ")[0].replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").trim();
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
};

export const taskPriority = (markdown: string): Priority => {
  const front = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
  return (front.match(/^priority:\s*["']?(p[123])["']?\s*$/mi)?.[1]?.toLowerCase() as Priority) || "p2";
};

// What today's plan names, in order of first mention: each task (`TASK-0140`) and each step written after it on the same
// line (`TASK-0140 W3.2`, `W1.2`), as one list deriveSteps reads for both the plan bonus and the tie-break order.
export function planMentions(markdown: string) {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    let task = "";
    for (const [token] of line.matchAll(/TASK-\d{4}|\bW\d+(?:\.\d+)*\b/g)) {
      if (token.startsWith("TASK-")) task = token;
      const entry = token.startsWith("TASK-") ? token : task && `${task} ${token}`;
      if (entry && !out.includes(entry)) out.push(entry);
    }
  }
  return out;
}

// Priority first (Up next above all), then today's plan order, then key, so equal scores stay put between reloads.
export const byPriority = (a: Step, b: Step) => Number(b.next) - Number(a.next) || b.score - a.score || a.order - b.order || a.key.localeCompare(b.key, undefined, { numeric: true });

// The pure derivation, tested on its own: tasks and machinery files in, open steps with their next move out.
export function deriveSteps(tasks: TaskInput[], machinery: { path: string; fields: Record<string, string>; draft?: OutboundDraft; modified: number }[], planOrder: string[] = [], now = Date.now()): Step[] {
  const byStep = new Map(machinery.filter((m) => m.fields.step).map((m) => [m.fields.step.trim().replace(/\s+/, " "), m]));
  const steps: Step[] = [];
  for (const task of tasks) {
    if (["completed", "deferred"].includes(task.status)) continue;
    const { nodes } = parseWorkBreakdown(section(task.markdown, "Work breakdown"));
    const prompts = new Map(parseActions(section(task.markdown, "Next actions"), task.path).filter((a: { workItem: string }) => a.workItem).map((a: { workItem: string; title: string; prompt: string }) => [a.workItem, a]));
    const byId = new Map(nodes.map((n: { id: string }) => [n.id, n]));
    const live = (status: string) => !["completed", "deferred"].includes(status);
    const priority = taskPriority(task.markdown);
    for (const node of nodes) {
      if (!live(node.status)) continue;
      const parent = byId.get(node.parent);
      if (parent && CHOICES.has(parent.kind)) continue; // options show inside their choice
      const children = nodes.filter((child: { parent: string }) => child.parent === node.id);
      const choice = CHOICES.has(node.kind);
      if (!choice && children.some((child: { status: string }) => live(child.status))) continue; // scope, not a step
      const key = `${task.id} ${node.id}`;
      const m = byStep.get(key);
      const action = prompts.get(node.id);
      const blockedBy = node.deps.filter((dep: string) => byId.get(dep)?.status !== "completed");
      const step: Step = {
        key, task: task.id, taskTitle: task.title, path: task.path, id: node.id, title: node.title, status: node.status,
        kind: node.kind || m?.fields.outbound || m?.fields.kind || (action ? (node.status === "waiting" ? "check-in" : "agent") : ""),
        size: node.size, deps: node.deps, next: node.flags.includes("next"), move: "unclassified", reason: "", prompt: action?.prompt, actionTitle: action?.title,
        age: daysSince(m?.modified ? new Date(m.modified).toISOString() : task.updated, now),
        order: planOrder.includes(task.id) ? planOrder.indexOf(task.id) : planOrder.length + 1,
        priority, unblocks: 0, score: 0,
      };
      if (m?.draft) step.draft = m.draft; else if (m) step.machinery = { path: m.path, fields: m.fields };
      if (choice) step.options = children.map((child: { id: string; title: string; flags: string[]; status: string }) => ({ id: child.id, ...splitOption(child.title), recommended: child.flags.includes("recommended"), status: child.status }));
      const [move, reason, fix] = nextMove(step, blockedBy);
      if (move === null) continue;
      Object.assign(step, { move, reason, ...(fix ? { fix } : {}), running: false });
      step.planned = planOrder.includes(key) ? "step" : planOrder.includes(task.id) ? "task" : "";
      const behind = downstreamSteps(nodes, node.id);
      step.unblocks = behind.length;
      rank(step, behind.map((id) => plainTitle(byId.get(id)!.title)));
      steps.push(step);
    }
  }
  return steps.sort(byPriority);
}

// [next move, why, the fix for friction]; null hides a step whose machinery says it's done.
function nextMove(step: Step, blockedBy: string[]): [Move, string, string?] | [null, ""] {
  if (blockedBy.length) return ["blocked", `after ${blockedBy.join(", ")}`];
  const { kind, draft } = step;
  if (CHOICES.has(kind)) return ["you-decide", kind === "pick-one" ? "pick one" : "pick any"];
  if (kind === "decision") return ["you-decide", "decide"];
  if (OUTBOUND_KINDS.has(kind)) {
    const status = draft?.fields.status;
    if (!draft) return ["agent", "draft it"];
    if (status === "sent" || status === "dropped") return [null, ""];
    if (status === "ready" && draft.fields.send === "manual") return ["you-act", "send by hand", "Add a Slack user token with chat:write so it sends on approval"];
    if (status === "ready") return ["you-decide", "approve"];
    if (status === "failed") return ["you-decide", "retry or send back"];
    if (status === "draft" && draft.fields.waits) return ["others", `waits: ${draft.fields.waits}`];
    return ["agent", status === "revise" ? "revising" : status === "approved" ? "sending" : "drafting"];
  }
  if (step.machinery?.fields.apply) return ["you-decide", "apply a rule"];
  if (kind === "byron") {
    const fields = step.machinery?.fields || {};
    return ["you-act", fields.why || "only you can do this", fields.fix || "Say what would remove this step"];
  }
  if (step.status === "waiting" || kind === "check-in") return ["others", step.prompt ? "watching" : "waiting"];
  if (kind === "agent" || step.prompt) return ["agent", step.status === "active" ? "in progress" : "ready"];
  return ["unclassified", "no kind or prompt"];
}

// Task assets whose front matter names a step (outbound drafts and `kind: byron` actions).
export async function listMachinery(root: string) {
  const out: { path: string; fields: Record<string, string>; draft?: OutboundDraft; modified: number }[] = [];
  const tasks = join(root, "tasks");
  for (const entry of await readdir(tasks, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^TASK-\d{4}-assets$/.test(entry.name)) continue;
    for (const file of await readdir(join(tasks, entry.name), { recursive: true }).catch(() => [] as string[])) {
      if (!String(file).endsWith(".md")) continue;
      const path = `tasks/${entry.name}/${file}`;
      const text = await readFile(join(root, path), "utf8").catch(() => "");
      if (!text.startsWith("---\n")) continue;
      const fields = outboundFields(text);
      if (fields.note || (!fields.step && !fields.outbound)) continue; // a note names its step too, but isn't machinery
      const modified = (await stat(join(root, path))).mtimeMs;
      out.push({ path, fields, draft: draftFromText(path, text, modified) || undefined, modified });
    }
  }
  return out;
}

export async function loadSteps(root: string, tasks: TaskInput[], planOrder: string[]) {
  const machinery = await listMachinery(root);
  // A note tied to a step doesn't replace it: the step stays as it is, waiting on an agent to process its notes and set
  // what comes next. A tied note whose step is gone (completed, renamed) still shows on its own.
  const notes = await listNotes(root);
  const derived = deriveSteps(tasks, machinery, planOrder);
  const keys = new Set(derived.map((step) => step.key));
  for (const step of derived) {
    const tied = notes.filter((note) => note.noteFor === step.key);
    if (tied.length) Object.assign(step, { move: "agent", reason: "notes to process", next: true, notes: tied.map(({ path, title }) => ({ path, title })) });
    if (tied.length) { // now an agent's move: re-rank, keeping the unblocked steps' names
      const unblocked = step.scoreParts?.find((part) => part.key === "unblocks")?.detail;
      rank(step, unblocked ? [unblocked] : []);
    }
  }
  derived.sort(byPriority); // a step with notes rises with the other Up next ones
  const steps = [...notes.filter((note) => !note.noteFor || !keys.has(note.noteFor)), ...derived];
  for (const step of steps) if (runs.has(step.key)) Object.assign(step, { move: "agent", running: true, reason: "running" });
  return {
    steps,
    drafts: machinery.flatMap((m) => m.draft ? [m.draft] : []),
    slots: config().steps.slots,
    runs: activeRuns(),
  };
}

// Pick on a choice: the choice completes, picked options stay open as ordinary steps, the rest are deferred as
// not picked, and the task gets a dated update. Only lines of that choice change.
export async function pickChoice(root: string, path: string, choiceId: string, picked: string[], user: string, today: string) {
  if (!/^tasks\/TASK-\d{4}\.md$/.test(path)) throw new Error("Only task files hold choices.");
  const absolute = resolve(root, path);
  if (!absolute.startsWith(resolve(root) + sep)) throw new Error("Invalid task path.");
  let markdown = await readFile(absolute, "utf8");
  const { nodes } = parseWorkBreakdown(section(markdown, "Work breakdown"));
  const choice = nodes.find((n: { id: string }) => n.id === choiceId);
  if (!choice || !CHOICES.has(choice.kind)) throw new Error(`${choiceId} isn't a choice.`);
  if (choice.status === "completed") throw new Error(`${choiceId} is already decided.`);
  const options = nodes.filter((n: { parent: string }) => n.parent === choiceId);
  if (picked.some((id) => !options.some((o: { id: string }) => o.id === id))) throw new Error("Pick one of the choice's options.");
  if (choice.kind === "pick-one" && picked.length !== 1) throw new Error("Pick exactly one option.");
  const rewrite = (id: string, status: string, addFlag = "") => {
    markdown = markdown.replace(new RegExp(`^(\\s*-\\s+${id.replace(/\./g, "\\.")}:\\s.*?)\\[(open|active|waiting|deferred|completed)\\](.*)$`, "m"), (_line, head, _status, tail) => {
      let rest = tail;
      if (addFlag) rest = /\{[^}]*\}\s*$/.test(rest) ? rest.replace(/\}\s*$/, `, ${addFlag}}`) : `${rest} {${addFlag}}`;
      return `${head}[${status}]${rest}`;
    });
  };
  rewrite(choiceId, "completed");
  for (const option of options) if (!picked.includes(option.id)) rewrite(option.id, "deferred", "not picked");
  const names = picked.map((id) => `${id} (${splitOption(options.find((o: { id: string }) => o.id === id).title).title})`).join(", ") || "none of the options";
  const line = `- **${today} — Picked ${names} for ${choiceId} (${user}, in the viewer):** ${splitOption(choice.title).title}.\n`;
  markdown = withUpdate(markdown, line).replace(/^updated: .*$/m, `updated: ${today}`);
  await writeFile(absolute, markdown);
  return { picked, choice: choiceId };
}

// --- Removing friction: completing a step, Approve and run, Apply, and Start with agent slots. ---

const READ_ONLY = /^\s*\(*\s*(select|with|show|describe|desc)\b/i;
export const isReadOnlyStatement = (sql: string) => READ_ONLY.test(sql) && !sql.trim().replace(/;\s*$/, "").includes(";");

function taskFile(root: string, path: string) {
  if (!/^tasks\/TASK-\d{4}\.md$/.test(path)) throw new Error("Not a task file.");
  const absolute = resolve(root, path);
  if (!absolute.startsWith(resolve(root) + sep)) throw new Error("Invalid task path.");
  return absolute;
}

function assetFile(root: string, path: string) {
  if (!/^tasks\/TASK-\d{4}-assets\/.+\.md$/.test(path) || path.includes("..")) throw new Error("Not a task asset.");
  return resolve(root, path);
}

// Rewrites one work item's status and adds a dated update, newest first, the way agents write them.
export function withStepStatus(markdown: string, id: string, status: string, update = "", today = "") {
  const next = markdown.replace(new RegExp(`^(\\s*-\\s+${id.replace(/\./g, "\\.")}:\\s.*?)\\[(open|active|waiting|deferred|completed)\\]`, "m"), `$1[${status}]`);
  if (next === markdown && !new RegExp(`^\\s*-\\s+${id.replace(/\./g, "\\.")}:.*\\[${status}\\]`, "m").test(markdown)) throw new Error(`${id} isn't in the work breakdown.`);
  if (!update) return next;
  const dated = withUpdate(next, `- **${today} — ${update}**\n`);
  return today ? dated.replace(/^updated: .*$/m, `updated: ${today}`) : dated;
}

// Adds a dated update line to `## Updates` in the order the task already uses: newest first under a bare heading, or
// at the section's end when it opens with "Append dated events below". Mirrors add_update in the workspace's outbound.py.
export function withUpdate(markdown: string, line: string) {
  const heading = /^## Updates[ \t]*\n/m.exec(markdown);
  if (!heading) return `${markdown.trimEnd()}\n\n## Updates\n\n${line}`;
  const start = heading.index + heading[0].length;
  const end = start + (/^## /m.exec(markdown.slice(start))?.index ?? markdown.length - start);
  const body = markdown.slice(start, end), rest = markdown.slice(end);
  const section = /^\n*Append dated events below/.test(body)
    ? `${body.trimEnd()}\n${line}${rest ? "\n" : ""}`
    : `\n${line}${body.replace(/^\n+/, "")}`;
  return markdown.slice(0, start) + section + rest;
}

async function completeStep(root: string, step: string, update: string, today: string) {
  const [, task, id] = step.trim().match(/^(TASK-\d{4})\s+(\S+)$/) || [];
  if (!task) return;
  const absolute = taskFile(root, `tasks/${task}.md`);
  await writeFile(absolute, withStepStatus(await readFile(absolute, "utf8"), id, "completed", update, today));
}

export async function markStepDone(root: string, path: string, id: string, user: string, today: string) {
  const absolute = taskFile(root, path);
  await writeFile(absolute, withStepStatus(await readFile(absolute, "utf8"), id, "completed", `${id} done (${user}, in the viewer).`, today));
}

// A task's `priority:` in its front matter: p1 and p3 are written after `status:`, p2 (the default) removes the line.
export function withTaskPriority(markdown: string, priority: Priority) {
  const front = markdown.match(/^---\r?\n[\s\S]*?\r?\n---/)?.[0];
  if (!front) throw new Error("The task has no front matter.");
  if (!(priority in PRIORITY_POINTS)) throw new Error(`Unknown priority ${priority}.`);
  let next = front.replace(/^priority:.*\r?\n/m, "");
  if (priority !== "p2") next = next.replace(/^(status:.*\r?\n)/m, `$1priority: ${priority}\n`);
  return markdown.replace(front, next);
}
export async function setTaskPriority(root: string, path: string, priority: Priority) {
  const absolute = taskFile(root, path);
  await writeFile(absolute, withTaskPriority(await readFile(absolute, "utf8"), priority));
}

// Up next: adds or removes the `next` flag in a step's `{…}` suffix, leaving its kind and size as they are.
export function withStepFlag(markdown: string, id: string, flag: string, on: boolean) {
  const line = new RegExp(`^(\\s*-\\s+${id.replace(/\./g, "\\.")}:\\s.*?\\[(?:open|active|waiting|deferred|completed)\\](?:\\s+\\(after:[^)]*\\))?)(?:\\s+\\{([^}]*)\\})?[ \\t]*$`, "m");
  if (!line.test(markdown)) throw new Error(`${id} isn't in the work breakdown.`);
  return markdown.replace(line, (_all, head, suffix = "") => {
    const parts = suffix.split(",").map((part: string) => part.trim()).filter((part: string) => part && part !== flag);
    if (on) parts.push(flag);
    return parts.length ? `${head} {${parts.join(", ")}}` : head;
  });
}

// Inline edits from the Steps table: a step line's title, status, kind or size, rewritten in place. Everything else on the
// line (its ID, indent, `(after:)` and flags such as `next`) stays as written. Completing goes through markStepDone, which
// also records an update; this refuses it.
export const EDITABLE_KINDS = ["agent", "check-in", "decision", "byron", "pick-one", "pick-any", "do-all", ...OUTBOUND_KINDS];
const STATUSES = ["open", "active", "waiting", "deferred"];
export function withStepEdit(markdown: string, id: string, edit: { title?: string; status?: string; kind?: string; size?: string }) {
  const line = new RegExp(`^(\\s*-\\s+${id.replace(/\./g, "\\.")}:\\s+)(.+?)((?:\\s+\\(after:[^)]*\\))?)\\s+\\[(open|active|waiting|deferred|completed)\\]((?:\\s+\\(after:[^)]*\\))?)(?:\\s+\\{([^}]*)\\})?[ \\t]*$`, "m");
  if (!line.test(markdown)) throw new Error(`${id} isn't in the work breakdown.`);
  if (edit.title !== undefined && (!edit.title.trim() || /[\r\n]/.test(edit.title) || /\[(open|active|waiting|deferred|completed)\]/.test(edit.title))) throw new Error("A step title is one line of text, without a [status].");
  if (edit.status !== undefined && !STATUSES.includes(edit.status)) throw new Error(edit.status === "completed" ? "Use Mark done to complete a step." : `Unknown status ${edit.status}.`);
  if (edit.kind !== undefined && edit.kind && !EDITABLE_KINDS.includes(edit.kind)) throw new Error(`Unknown kind ${edit.kind}.`);
  if (edit.size !== undefined && edit.size && !["S", "M", "L"].includes(edit.size)) throw new Error(`Unknown size ${edit.size}.`);
  return markdown.replace(line, (_all, head, title, afterFirst, status, afterLast, suffix = "") => {
    const parts = suffix.split(",").map((part: string) => part.trim()).filter(Boolean);
    const flags = parts.filter((part: string) => STEP_FLAGS.has(part));
    const kind = edit.kind ?? parts.find((part: string) => !STEP_SIZES.has(part) && !STEP_FLAGS.has(part)) ?? "";
    const size = edit.size ?? parts.find((part: string) => STEP_SIZES.has(part)) ?? "";
    const next = [kind, size, ...flags].filter(Boolean);
    return `${head}${edit.title?.trim() ?? title}${afterFirst} [${edit.status ?? status}]${afterLast}${next.length ? ` {${next.join(", ")}}` : ""}`;
  });
}
export async function editStep(root: string, path: string, id: string, edit: { title?: string; status?: string; kind?: string; size?: string }) {
  const absolute = taskFile(root, path);
  await writeFile(absolute, withStepEdit(await readFile(absolute, "utf8"), id, edit));
}

export async function setStepNext(root: string, path: string, id: string, on: boolean) {
  const absolute = taskFile(root, path);
  await writeFile(absolute, withStepFlag(await readFile(absolute, "utf8"), id, "next", on));
}

// Approve and run: a `kind: byron` step's read-only statement, run by the workspace's configured runner on the user's
// click. Writes are refused here; their page shows the statement to copy instead.
export async function runStatement(root: string, path: string, user: string, today: string) {
  const absolute = assetFile(root, path);
  const text = await readFile(absolute, "utf8");
  const fields = outboundFields(text);
  if (!fields.run) throw new Error("This step has no statement to run.");
  if (!isReadOnlyStatement(fields.run)) throw new Error("Only a single read-only statement runs from the viewer; copy this one and run it yourself.");
  const command = config().steps.run || [];
  if (!command.length) throw new Error("No runner is configured: set steps.run in viewer.config.json.");
  const [file, ...args] = command.map((part: string) => part.replace(/\{(\w+)\}/g, (all, key) => ({ statement: fields.run, target: fields.target || "" } as Record<string, string>)[key] ?? all));
  let output = "", ok = true;
  try { output = (await promisify(execFile)(file, args, { cwd: root, timeout: 120_000, maxBuffer: 4_000_000 })).stdout; }
  catch (error) { ok = false; output = String((error as { stdout?: string }).stdout || "") + String((error as { stderr?: string }).stderr || (error as Error).message); }
  const shown = output.trim().slice(0, 4000);
  await writeFile(absolute, `${text.trimEnd()}\n\n## Run, ${new Date().toLocaleString("sv-SE").slice(0, 16)} (${user}, in the viewer)\n\n\`\`\`text\n${shown}\n\`\`\`\n`);
  if (ok && fields.step) await completeStep(root, fields.step, `Ran \`${fields.run}\` as ${fields.target || "the configured runner"} (${user}, in the viewer); output in [${path.split("/").pop()}](${path.replace(/^tasks\//, "")}).`, today);
  return { ok, output: shown };
}

// Apply: adds a drafted allow rule (`apply:`) to the workspace's Claude settings file, on the user's click.
export async function applyRule(root: string, path: string, user: string, today: string) {
  const absolute = assetFile(root, path);
  const fields = outboundFields(await readFile(absolute, "utf8"));
  const rule = fields.apply?.trim();
  if (!rule) throw new Error("This step has no rule to apply.");
  const target = config().steps.settingsFile;
  if (!target) throw new Error("No settings file is configured: set steps.settingsFile in viewer.config.json.");
  const settingsPath = resolve(root, target);
  if (!settingsPath.startsWith(resolve(root) + sep)) throw new Error("steps.settingsFile must be inside the workspace.");
  const settings = JSON.parse(await readFile(settingsPath, "utf8").catch(() => "{}"));
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  const added = !settings.permissions.allow.includes(rule);
  if (added) settings.permissions.allow.push(rule);
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  if (fields.step) await completeStep(root, fields.step, `Applied the allow rule \`${rule}\` to ${target} (${user}, in the viewer).`, today);
  return { added, rule, file: target };
}

// Start: one local agent run per step, at most `steps.slots` at once. A run's end frees its slot and, with
// `steps.refill`, starts the next ready agent step that has a prompt.
const runs = new Map<string, { started: number; pid: number }>();
export const activeRuns = () => [...runs].map(([key, run]) => ({ key, ...run }));

export async function startStep(root: string, step: Step, today: string, next?: () => Promise<Step | undefined>, note = ""): Promise<{ started: boolean; key: string; pid?: number }> {
  const command = config().steps.start || [];
  if (!command.length) throw new Error("No agent command is configured: set steps.start in viewer.config.json.");
  if (step.move !== "agent" || step.running) throw new Error(`${step.task} ${step.id} isn't ready for an agent.`);
  if (runs.has(step.key)) throw new Error(`${step.key} is already running.`);
  if (runs.size >= config().steps.slots) throw new Error(`All ${config().steps.slots} agent slots are in use.`);
  const prompt = withNote(step.prompt || `In ${root}, work on ${step.task} ${step.id}: ${step.title}. Read the task first, do only this step, record a dated update, and commit only the files you changed with git commit --only. Send, post or file nothing.`, note);
  const values: Record<string, string> = { prompt, task: step.task, step: step.id, title: step.title };
  const [file, ...args] = command.map((part: string) => part.replace(/\{(\w+)\}/g, (all, key) => values[key] ?? all));
  const absolute = taskFile(root, step.path);
  await writeFile(absolute, withStepStatus(await readFile(absolute, "utf8"), step.id, "active", "", today));
  const child = spawn(file, args, { cwd: root, detached: true, stdio: "ignore" });
  runs.set(step.key, { started: Date.now(), pid: child.pid ?? 0 });
  child.on("exit", async () => {
    runs.delete(step.key);
    if (!config().steps.refill || !next) return;
    const following = await next().catch(() => undefined);
    if (following) await startStep(root, following, today, next).catch(() => {});
  });
  child.unref();
  return { started: true, key: step.key, pid: child.pid };
}

// --- Notes: a composer request saved for later instead of opened in an agent. The note holds the whole prompt the agent
// would have received (source file, task, selection, the user's words, image paths), so it reads well days later. A
// task's notes live in its assets, the rest in reference/notes/. Open notes are Up next until marked done.

export const notesFolder = (task: string) => task ? `tasks/${task}-assets/notes` : "reference/notes";
const stamp = (date: Date) => date.toLocaleString("sv-SE").replace(" ", "-").replace(/:/g, "").slice(0, 17);

// The note copies a chunk of its source verbatim, so relative links and image paths are re-pointed from the source's
// folder to the note's. URLs, anchors, absolute and workspace-rooted (`tasks/…`) links resolve the same from anywhere.
export const relinkFrom = (text: string, source: string, note: string) => !source ? text : text.replace(/(\]\()([^)\s#]+)/g, (match, open, link) =>
  /^[a-z][\w+.-]*:/i.test(link) || link.startsWith("/") || /^(daily|tasks|plans|reference)\//.test(link) ? match
    : open + posix.relative(posix.dirname(note), posix.join(posix.dirname(source), link)));

// A launch button's prompt (Shakedown, Discuss, a cleanup review…) saved as an Up next note instead of opened as an
// agent chat (`/api/notes`). The comment typed in the popover goes on top (`withNote`); these notes aren't tied to a
// task, so they land in reference/notes/. Steps, the composer and diagrams save through /api/dispatch, which ties them.
export async function saveLaunchNote(root: string, body: Record<string, unknown>, user: string, now = new Date()) {
  const title = String(body.title || "").slice(0, 200), comment = String(body.comment || "").slice(0, 12_000);
  const prompt = withNote(String(body.prompt || "").slice(0, 60_000), comment, user);
  if (!prompt.trim()) throw new Error("Nothing to save.");
  return saveNote(root, { commentary: title || comment || "Note", prompt }, now);
}

// `step` (`TASK-0101 W2.1`) ties the note to a step: a decision voiced over, or direction for one step. While the note
// is open it stands in for that step, so the step leaves its mover's list.
export async function saveNote(root: string, { commentary, prompt, source = "", task = "", step = "", images = [] as string[] }, now = new Date()) {
  const title = commentary.trim().split("\n")[0].replace(/\s+/g, " ").slice(0, 90) || "Note";
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "note";
  const folder = notesFolder(task);
  const stem = `${stamp(now)}-${slug}`;
  await mkdir(join(root, folder), { recursive: true });
  // Pasted images move beside the note, so they last as long as it does (they arrive in the ignored tmp/).
  const kept: string[] = [];
  for (const [index, image] of images.entries()) {
    const to = join(root, folder, `${stem}-${index + 1}${extname(image)}`);
    await rename(image, to);
    kept.push(to);
  }
  const path = `${folder}/${stem}.md`;
  const front = [`note: open`, `created: ${now.toLocaleString("sv-SE").slice(0, 16)}`, source && `source: ${source}`, task && `task: ${task}`, step && `step: ${step}`].filter(Boolean).join("\n");
  prompt = relinkFrom(prompt, source, path);
  const body = kept.length ? `${prompt}\n\nAttached images (pasted with the note; open each file to view it):\n${kept.map((file) => `- ${file}`).join("\n")}` : prompt;
  await writeFile(join(root, path), `---\n${front}\n---\n\n# ${title}\n\n${body}\n`);
  return { path, title };
}

// Open notes as Up next steps: an agent reviews the note and works it into its source.
export async function listNotes(root: string): Promise<Step[]> {
  const folders = [notesFolder("")];
  for (const entry of await readdir(join(root, "tasks"), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && /^TASK-\d{4}-assets$/.test(entry.name)) folders.push(`tasks/${entry.name}/notes`);
  }
  const notes: Step[] = [];
  for (const folder of folders) {
    for (const name of await readdir(join(root, folder)).catch(() => [] as string[])) {
      if (!name.endsWith(".md")) continue;
      const path = `${folder}/${name}`;
      const text = await readFile(join(root, path), "utf8");
      const fields = outboundFields(text);
      if (fields.note !== "open") continue;
      const title = text.match(/^# (.+)$/m)?.[1] || name;
      const created = Date.parse(fields.created?.replace(" ", "T") || "") || Date.now();
      notes.push({
        key: `note ${path}`, task: fields.task || "", taskTitle: fields.source || "", path, id: fields.step?.split(" ")[1] || name.slice(0, 17), title, status: "open",
        kind: "note", size: "", deps: [], next: true, move: "agent", reason: "note", noteFor: fields.step?.trim().replace(/\s+/, " ") || undefined, prompt: text.replace(/^---\n[\s\S]*?\n---\n+/, "").replace(/^# .+\n+/, ""),
        age: Math.max(0, Math.floor((Date.now() - created) / 86_400_000)), order: -1, running: false, priority: "p2", unblocks: 0, score: 0,
      });
    }
  }
  for (const note of notes) rank(note);
  return notes.sort((a, b) => a.id.localeCompare(b.id));
}

export async function closeNote(root: string, path: string, user: string, today: string) {
  if (!/^(tasks\/TASK-\d{4}-assets|reference)\/notes\/[^/]+\.md$/.test(path)) throw new Error("Not a note.");
  const absolute = resolve(root, path);
  const text = await readFile(absolute, "utf8");
  if (outboundFields(text).note !== "open") throw new Error("That note is already closed.");
  await writeFile(absolute, `${text.replace(/^note: open$/m, "note: done").trimEnd()}\n\n- **${today} — Marked done (${user}, in the viewer).**\n`);
}

// --- Follow-through: a click that finishes a step (Approve and send, Mark sent, Mark done, Pick, Approve and run, Apply)
// does only that click. The ripple (the next action that named the step, steps waiting on it, a tracker to move, a
// thread to resolve) needs an agent, so with `steps.followUp` each such click leaves an open note tied to the step,
// and the step's draft or machinery can list what it already knows under `## After it's sent` (or `## After it's done`).
const AFTER = /^## (?:After it's (?:sent|done)|Follow-through)\s*$([\s\S]*?)(?=^## |(?![\s\S]))/mi;

export async function followUpNote(root: string, { step, did, source = "", result = "" }: { step: string; did: string; source?: string; result?: string }, now = new Date()) {
  if (!config().steps.followUp) return null;
  const [, task, id] = step.trim().match(/^(TASK-\d{4})\s+(\S+)$/) || [];
  if (!task) return null;
  const taskPath = `tasks/${task}.md`;
  const markdown = await readFile(join(root, taskPath), "utf8").catch(() => "");
  const node = parseWorkBreakdown(section(markdown, "Work breakdown")).nodes.find((n: { id: string }) => n.id === id);
  const machinery = source && source !== taskPath ? await readFile(join(root, source), "utf8").catch(() => "") : "";
  const known = machinery.match(AFTER)?.[1].trim() || "";
  const prompt = [
    `${config().user} ${did} in the viewer, which completed ${id}. The click did only that; reconcile what else should change now that it's done.`,
    "",
    `Planning workspace: ${resolve(root)}`,
    `Task: ${task}${markdown.match(/^title:\s*(.+)$/m) ? ` · ${markdown.match(/^title:\s*(.+)$/m)![1].replace(/^["']|["']$/g, "")}` : ""} (${taskPath})`,
    `Step: ${id}${node ? `: ${node.title}` : ""}`,
    source && source !== taskPath ? `Draft or machinery: ${source}` : "",
    result ? `Result: ${result}` : "",
    "",
    `Read the workspace AGENTS.md and the task first, then any task asset whose front matter names \`step: ${task} ${id}\`.`,
    known ? `\nThe draft listed this follow-through; do each item:\n\n${known}\n` : "",
    "Then check the ripple the click didn't touch:",
    `- The task: a dated update says what happened and links the result; Next actions that named ${id} are removed or rewritten (an active task keeps one ready action); steps that waited on ${id} (\`after:\`) are ready; the task's status, waiting and check-in still fit.`,
    "- Trackers, PRs and threads the step or its draft names: move or link what the workspace lets an agent change, and write anything that would leave the workspace as its own outbound draft instead of sending it.",
    "- Today's plan lists only what is still open.",
    "",
    "Record what you changed as a dated update on the task (one line saying nothing needed changing is fine). Then close this note: set `note: done` in its front matter and add a dated line saying what you did.",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
  return saveNote(root, { commentary: `Follow through on ${id}${node ? ` · ${node.title}` : ""}`, prompt, task, step: `${task} ${id}`, source: source || taskPath }, now);
}
