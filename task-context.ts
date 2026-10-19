// Compact task context for agents: `npm run task -- TASK-0044`.
// Prints the outcome, open work with readiness, next action prompts, chats, assets, latest update and
// the documents that reference the task, so a resuming agent need not read the whole history.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { listDocuments, loadDocument, ROOT } from "./server.ts";

const id = process.argv[2]?.toUpperCase();
if (!id || !/^TASK-\d{4}$/.test(id)) {
  console.error("Usage: npm run task -- TASK-NNNN");
  process.exit(1);
}
const doc = await loadDocument(`tasks/${id}.md`);
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

const latest = section(/^updates$/i).split(/\n(?=- )/).filter(Boolean).at(-1);
if (latest) out.push("## Latest update", latest, "");
if (doc.chatLinks.length) out.push("## Chats", ...doc.chatLinks.map((chat) => `- ${chat.label}: ${chat.href}`), "");
const assets = await readdir(join(ROOT, "tasks", `${id}-assets`)).catch(() => []);
if (assets.length) out.push("## Assets", ...assets.filter((name) => !name.startsWith(".")).map((name) => `- tasks/${id}-assets/${name}`), "");
const referencedBy = (await listDocuments()).find((entry) => entry.path === doc.path)?.backlinks || [];
if (referencedBy.length) out.push("## Referenced by", ...referencedBy.slice(-10).map((path) => `- ${path}`), "");
console.log(out.join("\n").trimEnd());
