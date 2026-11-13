// Steps: every open work-breakdown line across the workspace's tasks, with who makes the next move. A step stores its
// status, prerequisites and an optional `{kind, size}`; everything else here is derived. Outbound drafts and other
// machinery files (task assets whose front matter names a `step:`) supply the kind when the line doesn't.
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parseActions, parseWorkBreakdown } from "./public/actions.js";
import { config } from "./public/config.js";
import { draftFromText, outboundFields, type OutboundDraft } from "./outbound.ts";

export const OUTBOUND_KINDS = new Set(["jira-issue", "jira-comment", "jira-edit", "jira-transition", "slack", "pr", "pr-comment", "review-request", "email"]);
const CHOICES = new Set(["pick-one", "pick-any"]);
export type Move = "you-decide" | "you-act" | "agent" | "others" | "blocked" | "unclassified";

export interface StepOption { id: string; title: string; tradeoff: string; recommended: boolean; status: string }
export interface Step {
  key: string; task: string; taskTitle: string; path: string; id: string; title: string; status: string;
  kind: string; size: string; deps: string[]; next: boolean; move: Move; reason: string; fix?: string; running?: boolean;
  prompt?: string; actionTitle?: string; draft?: OutboundDraft; machinery?: { path: string; fields: Record<string, string> };
  options?: StepOption[]; age: number; order: number;
  noteFor?: string; notes?: { path: string; title: string }[];
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
        size: node.size, deps: node.deps, next: node.flags.includes("next"), move: "unclassified", reason: "", prompt: action?.prompt, actionTitle: action?.title,
        age: daysSince(m?.modified ? new Date(m.modified).toISOString() : task.updated, now),
        order: planOrder.includes(task.id) ? planOrder.indexOf(task.id) : planOrder.length + 1,
      };
      if (m?.draft) step.draft = m.draft; else if (m) step.machinery = { path: m.path, fields: m.fields };
      if (choice) step.options = children.map((child: { id: string; title: string; flags: string[]; status: string }) => ({ id: child.id, ...splitOption(child.title), recommended: child.flags.includes("recommended"), status: child.status }));
      const [move, reason, fix] = nextMove(step, blockedBy);
      if (move === null) continue;
      Object.assign(step, { move, reason, ...(fix ? { fix } : {}), running: false });
      steps.push(step);
    }
  }
  return steps.sort((a, b) => Number(b.next) - Number(a.next) || a.order - b.order || b.age - a.age || a.key.localeCompare(b.key, undefined, { numeric: true }));
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
  }
  derived.sort((a, b) => Number(b.next) - Number(a.next)); // stable: a step with notes rises with the other Up next ones
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
  markdown = /^## Updates\s*\n\n/m.test(markdown) ? markdown.replace(/^## Updates\s*\n\n/m, (head) => head + line) : `${markdown.trimEnd()}\n\n## Updates\n\n${line}`;
  markdown = markdown.replace(/^updated: .*$/m, `updated: ${today}`);
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
  const line = `- **${today} — ${update}**\n`;
  const dated = /^## Updates\s*\n\n/m.test(next) ? next.replace(/^## Updates\s*\n\n/m, (head) => head + line) : `${next.trimEnd()}\n\n## Updates\n\n${line}`;
  return today ? dated.replace(/^updated: .*$/m, `updated: ${today}`) : dated;
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

export async function startStep(root: string, step: Step, today: string, next?: () => Promise<Step | undefined>): Promise<{ started: boolean; key: string; pid?: number }> {
  const command = config().steps.start || [];
  if (!command.length) throw new Error("No agent command is configured: set steps.start in viewer.config.json.");
  if (step.move !== "agent" || step.running) throw new Error(`${step.task} ${step.id} isn't ready for an agent.`);
  if (runs.has(step.key)) throw new Error(`${step.key} is already running.`);
  if (runs.size >= config().steps.slots) throw new Error(`All ${config().steps.slots} agent slots are in use.`);
  const prompt = step.prompt || `In ${root}, work on ${step.task} ${step.id}: ${step.title}. Read the task first, do only this step, record a dated update, and commit only the files you changed with git commit --only. Send, post or file nothing.`;
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
        age: Math.max(0, Math.floor((Date.now() - created) / 86_400_000)), order: -1, running: false,
      });
    }
  }
  return notes.sort((a, b) => a.id.localeCompare(b.id));
}

export async function closeNote(root: string, path: string, user: string, today: string) {
  if (!/^(tasks\/TASK-\d{4}-assets|reference)\/notes\/[^/]+\.md$/.test(path)) throw new Error("Not a note.");
  const absolute = resolve(root, path);
  const text = await readFile(absolute, "utf8");
  if (outboundFields(text).note !== "open") throw new Error("That note is already closed.");
  await writeFile(absolute, `${text.replace(/^note: open$/m, "note: done").trimEnd()}\n\n- **${today} — Marked done (${user}, in the viewer).**\n`);
}
