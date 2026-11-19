// Every prompt the viewer sends to an agent, as a Markdown template. The defaults ship in the viewer's prompts/ folder;
// a file of the same name in the workspace's config/prompts/ overrides one. Code fills the `{slots}` (the source file,
// the user's commentary, a step's facts); the words around them come from the file, so the Setup page shows exactly
// what a button sends. A slot the code does not fill stays as written.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath } from "./public/layout.js";

export const DEFAULTS = fileURLToPath(new URL("prompts", import.meta.url));
export const OVERRIDES = configPath("prompts");
const IDS = readdirSync(DEFAULTS).filter((name) => name.endsWith(".md")).map((name) => basename(name, ".md")).sort();

// Front matter (title, sent) and the body. One blank line after the front matter and the file's final newline are not
// part of the prompt.
export function parsePrompt(text: string) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n\n?/);
  const meta = Object.fromEntries((match?.[1] || "").split("\n").map((line) => line.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((m) => [m![1], m![2]]));
  return { title: meta.title || "", sent: meta.sent || "", routine: meta.routine === "true", body: text.slice(match?.[0].length || 0).replace(/\n$/, "") };
}

const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const known = (id: string) => { if (!IDS.includes(id)) throw new Error(`No prompt named ${id}.`); };

export function promptTemplate(root: string, id: string) {
  known(id);
  const fallback = parsePrompt(read(join(DEFAULTS, `${id}.md`))!);
  const own = read(join(root, OVERRIDES, `${id}.md`));
  return own === null ? { ...fallback, fallback: fallback.body, customized: false } : { ...fallback, body: parsePrompt(own).body, fallback: fallback.body, customized: true };
}

export const slots = (body: string) => [...new Set([...body.matchAll(/\{([a-z][\w-]*)\}/g)].map((match) => match[1]))];

// Fills a prompt's slots in one pass, so text the values bring in is never filled again. `{chat-links}` is itself a
// prompt and fills in on its own.
export function fillPrompt(root: string, id: string, values: Record<string, string | number>) {
  const all: Record<string, string | number> = { "chat-links": id === "chat-links" ? "" : promptTemplate(root, "chat-links").body, ...values };
  return promptTemplate(root, id).body.replace(/\{([a-z][\w-]*)\}/g, (match, key) => key in all ? String(all[key]) : match);
}

export function listPrompts(root: string) {
  return IDS.map((id) => {
    const template = promptTemplate(root, id);
    return { id, title: template.title, sent: template.sent, routine: template.routine, body: template.body, fallback: template.fallback, customized: template.customized, slots: slots(template.fallback), path: `${OVERRIDES}/${id}.md` };
  });
}

// Customize copies the default into config/prompts/ so the user (or an agent) can edit it; Reset deletes the copy.
export async function customizePrompt(root: string, id: string) {
  known(id);
  const file = join(root, OVERRIDES, `${id}.md`);
  if (existsSync(file)) return `${OVERRIDES}/${id}.md`;
  await mkdir(join(root, OVERRIDES), { recursive: true });
  await writeFile(file, readFileSync(join(DEFAULTS, `${id}.md`), "utf8"));
  return `${OVERRIDES}/${id}.md`;
}

export async function resetPrompt(root: string, id: string) {
  known(id);
  await rm(join(root, OVERRIDES, `${id}.md`), { force: true });
}
