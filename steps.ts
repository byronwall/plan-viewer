// Steps: every open work-breakdown line across the workspace's tasks, with who makes the next move. A step stores its
// status, prerequisites and an optional `{kind, size}`; everything else here is derived. Outbound drafts and other
// machinery files (task assets whose front matter names a `step:`) supply the kind when the line doesn't.
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseActions, parseWorkBreakdown } from "./public/actions.js";
import { config } from "./public/config.js";
import { draftFromText, outboundFields, type OutboundDraft } from "./outbound.ts";

export const OUTBOUND_KINDS = new Set(["jira-issue", "jira-comment", "jira-edit", "jira-transition", "slack", "pr", "pr-comment", "review-request", "email"]);
const CHOICES = new Set(["pick-one", "pick-any"]);
export type Move = "you-decide" | "you-act" | "agent" | "others" | "blocked" | "unclassified";

export interface StepOption { id: string; title: string; tradeoff: string; recommended: boolean; status: string }
export interface Step {
  key: string; task: string; taskTitle: string; path: string; id: string; title: string; status: string;
  kind: string; size: string; deps: string[]; move: Move; reason: string; fix?: string; running?: boolean;
  prompt?: string; actionTitle?: string; draft?: OutboundDraft; machinery?: { path: string; fields: Record<string, string> };
  options?: StepOption[]; age: number; order: number;
}

interface TaskInput { path: string; id: string; title: string; status: string; updated: string; markdown: string }

const section = (markdown: string, name: string) => markdown.match(new RegExp(`^## ${name}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "mi"))?.[1] || "";
const daysSince = (date: string, now: number) => Math.max(0, Math.floor((now - Date.parse(date)) / 86_400_000));
const splitOption = (title: string) => { const [head, ...rest] = title.split(" — "); return { title: head.trim(), tradeoff: rest.join(" — ").trim() }; };

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
        size: node.size, deps: node.deps, move: "unclassified", reason: "", prompt: action?.prompt, actionTitle: action?.title,
        age: daysSince(m?.modified ? new Date(m.modified).toISOString() : task.updated, now),
        order: planOrder.includes(task.id) ? planOrder.indexOf(task.id) : planOrder.length + 1,
      };
      if (m?.draft) step.draft = m.draft; else if (m) step.machinery = { path: m.path, fields: m.fields };
      if (choice) step.options = children.map((child: { id: string; title: string; flags: string[]; status: string }) => ({ id: child.id, ...splitOption(child.title), recommended: child.flags.includes("recommended"), status: child.status }));
      const [move, reason, fix] = nextMove(step, blockedBy);
      if (move === null) continue;
      Object.assign(step, { move, reason, ...(fix ? { fix } : {}), running: move === "agent" && node.status === "active" });
      steps.push(step);
    }
  }
  return steps.sort((a, b) => a.order - b.order || b.age - a.age || a.key.localeCompare(b.key, undefined, { numeric: true }));
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
  if (kind === "byron") {
    const fields = step.machinery?.fields || {};
    return ["you-act", fields.why || "only you can do this", fields.fix || "Say what would remove this step"];
  }
  if (step.status === "waiting" || kind === "check-in") return ["others", step.prompt ? "watching" : "waiting"];
  if (kind === "agent" || step.prompt) return ["agent", step.status === "active" ? "running" : "ready"];
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
      if (!fields.step && !fields.outbound) continue;
      const modified = (await stat(join(root, path))).mtimeMs;
      out.push({ path, fields, draft: draftFromText(path, text, modified) || undefined, modified });
    }
  }
  return out;
}

export async function loadSteps(root: string, tasks: TaskInput[], planOrder: string[]) {
  const machinery = await listMachinery(root);
  return {
    steps: deriveSteps(tasks, machinery, planOrder),
    drafts: machinery.flatMap((m) => m.draft ? [m.draft] : []),
    slots: config().steps.slots,
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
  markdown = /^## Updates\s*\n\n/m.test(markdown) ? markdown.replace(/^## Updates\s*\n\n/m, (head) => head + line) : `${markdown.trimEnd()}\n\n## Updates\n\n${line}`;
  markdown = markdown.replace(/^updated: .*$/m, `updated: ${today}`);
  await writeFile(absolute, markdown);
  return { picked, choice: choiceId };
}
