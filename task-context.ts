// Compact task context for agents: `npm run task -- TASK-0044`.
// Prints the outcome, open work with readiness, next action prompts, chats, assets, latest update and
// the documents that reference the task, so a resuming agent need not read the whole history.
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseUpdates } from "./public/markdown.js";
import { listDocuments, loadDocument, ROOT } from "./server.ts";
import { taskDir, taskFile } from "./public/layout.js";

const id = process.argv[2]?.toUpperCase();
if (!id || !/^TASK-\d{4}$/.test(id)) {
  console.error("Usage: npm run task -- TASK-NNNN");
  process.exit(1);
}
if (!await access(join(ROOT, taskFile(id))).then(() => true, () => false)) throw new Error(`${taskFile(id)} does not exist`);
const doc = await loadDocument(taskFile(id));
const section = (title: RegExp) => doc.chunks.find((chunk) => title.test(chunk.title))?.markdown.replace(/^#+ .*\n/, "").trim() || "";
const out: string[] = [];
const task = doc.task!;
out.push(`# ${id} — ${task.title}`, `status: ${task.status} · project: ${task.project} · updated: ${task.updated}`, `file: ${doc.absolutePath}`, "", task.summary, "");
out.push("## Outcome", section(/^outcome$/i) || "(none recorded)", "");

const byId = new Map(doc.work.nodes.map((node) => [node.id, node]));
const open = doc.work.nodes.filter((node) => ["open", "active", "waiting"].includes(node.status));
out.push(`## Open work (${open.length} of ${doc.work.nodes.length})`);
for (const node of open) {
  const waiting = node.deps.filter((dep: string) => byId.get(dep)?.status !== "completed");
  out.push(`- ${node.id}: ${node.title} [${node.status}]${node.ready ? " — ready" : waiting.length ? ` — after ${waiting.join(", ")}` : ""}`);
}
out.push(...doc.work.warnings.map((warning: string) => `warning: ${warning}`), ...doc.actionWarnings.map((warning) => `warning: ${warning}`), "");

out.push("## Next actions");
for (const action of doc.nextActions) {
  out.push(`### ${action.title}${action.workItem ? ` (${action.workItem})` : ""}${action.blocked ? ` — blocked: ${action.blockedReason}` : " — ready"}`, action.prompt, "");
}
if (!doc.nextActions.length) out.push("(none)", "");

const updates = doc.chunks.find((chunk) => /^updates$/i.test(chunk.title))?.markdown;
const [latest] = parseUpdates(updates).entries;
if (latest) out.push("## Latest update", `**${latest.date}${latest.title ? ` — ${latest.title}` : ""}**`, latest.body, "");
else if (updates) out.push("## Updates", updates, "");
if (doc.chatLinks.length) out.push("## Chats", ...doc.chatLinks.map((chat) => `- ${chat.label}: ${chat.href}`), "");
const assets = (await readdir(join(ROOT, taskDir(id))).catch(() => [])).filter((name) => !name.startsWith(".") && name !== `${id}.md`);
if (assets.length) out.push("## Assets", ...assets.map((name) => `- ${taskDir(id)}/${name}`), "");
const referencedBy = (await listDocuments()).find((entry) => entry.path === doc.path)?.backlinks || [];
if (referencedBy.length) out.push("## Referenced by", ...referencedBy.slice(-10).map((path) => `- ${path}`), "");
console.log(out.join("\n").trimEnd());
