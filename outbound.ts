// Outbound drafts: task assets whose front matter says what to send, where, and whether the user approved it.
// The viewer reads them, records the user's Approve / Send back / Drop on the exact text shown, and runs the
// workspace's configured send command. It never sends anything itself; `outbound.send` in viewer.config.json does.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { config } from "./public/config.js";

export type OutboundFields = Record<string, string>;
export interface OutboundDraft {
  path: string;
  fields: OutboundFields;
  sha: string;
  body: string;
  title: string;
  modified: number;
}

const FRONT = /^---\n([\s\S]*?)\n---\n/;
const BODY = /<!-- (jira|send):start -->\n?([\s\S]*?)\n?<!-- \1:end -->/;
const DRAFT_PATH = /^tasks\/TASK-\d{4}-assets\/.+\.md$/;

export function outboundFields(text: string): OutboundFields {
  const match = text.match(FRONT);
  if (!match) return {};
  return Object.fromEntries([...match[1].matchAll(/^([a-z_]+):[ \t]*(.*)$/gm)].map((m) => [m[1], m[2]]));
}

export const outboundBody = (text: string) => text.match(BODY)?.[2].trim() || "";

// 12 hex digits over the send line and the body between the markers. Mirrors sha() in the workspace's outbound.py,
// so the hash the page shows is the one the sender checks.
export const outboundHash = (text: string) => createHash("sha256").update(`${outboundFields(text).send || ""}\n${outboundBody(text)}`).digest("hex").slice(0, 12);

// What the draft's page renders: its notes, with the outgoing text replaced by a pointer, since the approval panel
// shows that text exactly (rendered once, between the markers it is hashed from).
export function stripFrontMatter(text: string) {
  if (!outboundFields(text).outbound) return text;
  const notes = text.replace(FRONT, "").replace(/^\s*#\s+.+\n/, "").replace(BODY, "*The text that goes out is in the panel above.*").trim();
  return /^## /m.test(notes) ? notes : `## Notes\n\n${notes}`;
}

export function setOutboundFields(text: string, updates: Record<string, string | null>) {
  const match = text.match(FRONT);
  if (!match) throw new Error("This draft has no front matter.");
  const lines = match[1].split("\n");
  for (const [key, value] of Object.entries(updates)) {
    const at = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (value === null) { if (at >= 0) lines.splice(at, 1); }
    else if (at < 0) lines.push(`${key}: ${value.replace(/\n/g, " ")}`);
    else lines[at] = `${key}: ${value.replace(/\n/g, " ")}`;
  }
  return `---\n${lines.join("\n")}\n---\n${text.slice(match[0].length)}`;
}

export function draftFromText(path: string, text: string, modified = 0): OutboundDraft | null {
  const fields = outboundFields(text);
  if (!fields.outbound) return null;
  const rest = text.replace(FRONT, "");
  return { path, fields, sha: outboundHash(text), body: outboundBody(text), title: rest.match(/^#\s+(.+)$/m)?.[1].trim() || path.split("/").pop()!, modified };
}

export async function listOutbound(root: string): Promise<OutboundDraft[]> {
  const drafts: OutboundDraft[] = [];
  const tasks = join(root, "tasks");
  for (const entry of await readdir(tasks, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^TASK-\d{4}-assets$/.test(entry.name)) continue;
    for (const file of await readdir(join(tasks, entry.name), { recursive: true }).catch(() => [] as string[])) {
      if (!String(file).endsWith(".md")) continue;
      const path = `tasks/${entry.name}/${file}`;
      const absolute = join(root, path);
      const text = await readFile(absolute, "utf8").catch(() => "");
      if (!text.startsWith("---\n")) continue;
      const { mtimeMs } = await stat(absolute);
      const draft = draftFromText(path, text, mtimeMs);
      if (draft) drafts.push(draft);
    }
  }
  return drafts;
}

function draftFile(root: string, path: string) {
  if (!DRAFT_PATH.test(path) || path.includes("..")) throw new Error("Not an outbound draft path.");
  const absolute = resolve(root, path);
  if (!absolute.startsWith(resolve(root) + sep)) throw new Error("Not an outbound draft path.");
  return absolute;
}

const fill = (command: string[], values: Record<string, string>) => command.map((part) => part.replace(/\{(\w+)\}/g, (all, key) => key in values ? values[key] : all));
const stamp = () => new Date().toLocaleString("sv-SE").replace(" ", "T"); // local time, like outbound.py

async function readDraft(root: string, path: string) {
  const absolute = draftFile(root, path);
  const text = await readFile(absolute, "utf8");
  if (!outboundFields(text).outbound) throw new Error("This file isn't an outbound draft.");
  return { absolute, text };
}

async function refreshed(root: string, path: string) {
  const { text } = await readDraft(root, path);
  return draftFromText(path, text)!;
}

// Approve and send: records the click on the exact text, then runs the configured sender, which checks the hash again.
export async function approveOutbound(root: string, path: string, sha: string) {
  const { absolute, text } = await readDraft(root, path);
  const fields = outboundFields(text);
  if (!["ready", "failed"].includes(fields.status)) throw new Error(`This draft is ${fields.status || "not ready"}, so it can't be approved.`);
  if (fields.send === "manual") throw new Error("This draft is sent by hand: copy it, send it, then mark it sent.");
  const command = config().outbound?.send || [];
  if (!command.length) throw new Error("No sender is configured: set outbound.send in viewer.config.json.");
  const current = outboundHash(text);
  if (current !== sha) {
    await writeFile(absolute, setOutboundFields(text, { status: "ready", approved: null, error: "Changed since you read it; read it again" }));
    return { changed: true, draft: await refreshed(root, path) };
  }
  await writeFile(absolute, setOutboundFields(text, { status: "approved", approved: `${stamp()} sha=${sha} by=viewer`, error: null }));
  let output = "";
  try {
    const [file, ...args] = fill(command, { file: path, sha });
    output = (await promisify(execFile)(file, args, { cwd: root, timeout: 180_000 })).stdout;
  } catch (error) {
    const after = outboundFields(await readFile(absolute, "utf8"));
    const message = String((error as { stderr?: string }).stderr || (error as Error).message).trim().split("\n").pop() || "The sender failed.";
    if (after.status === "approved") await writeFile(absolute, setOutboundFields(await readFile(absolute, "utf8"), { status: "failed", error: message.slice(0, 300) }));
  }
  return { changed: false, output: output.trim(), draft: await refreshed(root, path) };
}

// Send back: keeps the user's words with the draft, outside the markers, and starts the configured revision run.
export async function sendBackOutbound(root: string, path: string, feedback: string) {
  const text = feedback.trim();
  if (!text) throw new Error("Write what should change.");
  const draft = await readDraft(root, path);
  const when = stamp().replace("T", " ").slice(0, 16);
  const next = setOutboundFields(draft.text, { status: "revise", approved: null, error: null }).replace(/\n*$/, "\n") + `\n## ${config().user}'s feedback, ${when}\n\n${text}\n`;
  await writeFile(draft.absolute, next);
  const command = config().outbound?.revise || [];
  const dryRun = outboundFields(next).dry_run === "true";
  let started = false;
  if (command.length && !dryRun) {
    const [file, ...args] = fill(command, { file: path, feedback: text });
    spawn(file, args, { cwd: root, detached: true, stdio: "ignore" }).unref();
    started = true;
  }
  return { started, draft: await refreshed(root, path) };
}

export async function dropOutbound(root: string, path: string) {
  const draft = await readDraft(root, path);
  await writeFile(draft.absolute, setOutboundFields(draft.text, { status: "dropped", approved: null }));
  return { draft: await refreshed(root, path) };
}

// For drafts sent by hand (`send: manual`): the user says it went, optionally with its link.
export async function markOutboundSent(root: string, path: string, result: string) {
  const command = config().outbound?.mark || [];
  if (command.length) {
    const [file, ...args] = fill(command, { file: path, result: result || "sent by hand" });
    await promisify(execFile)(file, args, { cwd: root, timeout: 60_000 });
  } else {
    const draft = await readDraft(root, path);
    await writeFile(draft.absolute, setOutboundFields(draft.text, { status: "sent", sent: stamp(), result: result || "sent by hand" }));
  }
  return { draft: await refreshed(root, path) };
}
