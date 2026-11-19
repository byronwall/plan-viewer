// `plan-viewer migrate [--write]`: move a workspace from the older layout to the one in public/layout.js, in one shot.
//
//   tasks/TASK-0101.md, tasks/TASK-0101-assets/*  → tasks/TASK-0101/TASK-0101.md, tasks/TASK-0101/*
//   daily/2026/11/18/plan.md                      → daily/2026-11-18.md
//   plans/README.md, plans/<topic>/…              → reference/topics.md, reference/<topic>/…
//   reference/*.json, slack-channels.md, retired-tasks.md, viewer.config.json → config/
//
// Without --write it is a dry run: it prints the moves and a "Fix first" list, and exits 1 while that list has items.
// Each item says what to do, so an agent can fix it and run again. --write refuses until the list is empty, then moves
// files (git mv when tracked), rewrites relative links, backticked paths and config path values, and lists lines in
// agent guides, scripts and package.json that still name the old layout. This is the only code that knows that layout.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { promisify } from "node:util";

const ROOT = resolve(process.env.PLANNING_ROOT || process.cwd());
const args = process.argv.slice(2);
const write = args.includes("--write");
if (args.some((arg) => arg !== "--write")) throw new Error("Usage: plan-viewer migrate [--write]");

const run = (cmd: string, cmdArgs: string[]) => promisify(execFile)(cmd, cmdArgs, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
const OLD_ROOTS = ["tasks", "daily", "plans", "reference"];
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(entries.filter((entry) => !SKIP.has(entry.name)).map((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : Promise.resolve([path]);
  }));
  return found.flat();
}

// Where an old path (a file or a folder) lives in the new layout; unchanged paths map to themselves.
export function newPath(path: string) {
  let m;
  if ((m = path.match(/^tasks\/(TASK-\d{4})\.md$/))) return `tasks/${m[1]}/${m[1]}.md`;
  if ((m = path.match(/^tasks\/(TASK-\d{4})-assets(\/.*)?$/))) return `tasks/${m[1]}${m[2] || ""}`;
  if ((m = path.match(/^daily\/(\d{4})\/(\d{2})\/(\d{2})\/plan\.md$/))) return `daily/${m[1]}-${m[2]}-${m[3]}.md`;
  if (path === "plans/README.md") return "reference/topics.md";
  if ((m = path.match(/^plans(\/.*)?$/))) return `reference${m[1] || ""}`;
  if ((m = path.match(/^reference\/([^/]+\.json|slack-channels\.md|retired-tasks\.md)$/))) return `config/${m[1]}`;
  if (path === "viewer.config.json") return "config/viewer.json";
  return path;
}

const files = (await Promise.all(OLD_ROOTS.map(walk))).flat().sort();
if (existsSync(join(ROOT, "viewer.config.json"))) files.push("viewer.config.json");
const fileSet = new Set(files);
const fixFirst: string[] = [];

// Moves, and the problems an agent must settle before any of them can happen.
const moves = new Map<string, string>();
for (const path of files) {
  const to = newPath(path);
  if (to !== path) moves.set(path, to);
  const asset = path.match(/^tasks\/(TASK-\d{4})-assets\//);
  if (asset && !fileSet.has(`tasks/${asset[1]}.md`)) fixFirst.push(`${path}: its task file tasks/${asset[1]}.md does not exist. Create that task, or move the folder's files into another task's -assets folder.`);
  else if (path.startsWith("tasks/") && !/^tasks\/TASK-\d{4}(\.md|-assets\/.+)$/.test(path) && !/^tasks\/TASK-\d{4}\/.+/.test(path)) fixFirst.push(`${path}: only TASK-NNNN.md files and TASK-NNNN-assets/ folders belong in tasks/. Move it into a task's -assets folder or reference/.`);
  if (path.startsWith("daily/") && !/^daily\/\d{4}\/\d{2}\/\d{2}\/plan\.md$/.test(path) && !/^daily\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) fixFirst.push(`${path}: only plan.md belongs in a day folder. Move it into a task's -assets folder or reference/, or delete it.`);
}
const targets = new Map<string, string>();
for (const [from, to] of moves) {
  if (targets.has(to)) fixFirst.push(`${from} and ${targets.get(to)} would both move to ${to}. Rename one of them.`);
  else if (existsSync(join(ROOT, to)) && !moves.has(to)) fixFirst.push(`${from} would move to ${to}, which already exists. Merge or rename one of them.`);
  targets.set(to, from);
}
const nowAt = (path: string) => moves.get(path) || path;
const parents = (paths: Iterable<string>) => new Set([...paths].flatMap((path) => path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
const oldDirs = parents(files);
const newDirs = parents(files.map(nowAt));
const exists = (path: string) => fileSet.has(path) || oldDirs.has(path) || existsSync(join(ROOT, path));
const existsAfter = (path: string) => targets.has(path) || newDirs.has(path) || (!moves.has(path) && !oldDirs.has(path) && existsSync(join(ROOT, path)));

// Links: inline `](target)`, reference definitions `[x]: target`, and backticked repository paths.
const ROOT_LINK = /^(daily|tasks|plans|reference|config)\//;
function rewrite(doc: string, text: string, broken: string[]) {
  const to = nowAt(doc);
  const link = (target: string) => {
    if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("#")) return target;
    const [bare, hash = ""] = target.split(/(?=#)/);
    let decoded;
    try { decoded = decodeURIComponent(bare); } catch { return target; }
    const rooted = ROOT_LINK.test(decoded);
    const old = rooted ? posix.normalize(decoded) : posix.join(posix.dirname(doc), decoded);
    if (!exists(old.replace(/\/$/, ""))) return target;
    const after = newPath(old.replace(/\/$/, "")) + (decoded.endsWith("/") ? "/" : "");
    if (!rooted && after === old && to === doc) return target;
    const next = rooted ? after : (posix.relative(posix.dirname(to), after.replace(/\/$/, "")) || posix.basename(after)) + (decoded.endsWith("/") ? "/" : "");
    if (!existsAfter(after.replace(/\/$/, ""))) broken.push(`${doc}: link ${target} would point at ${after}, which will not exist. Fix the link by hand.`);
    return next.replaceAll(" ", "%20") + hash;
  };
  return text
    .replace(/(\]\()(<[^>]+>|[^)\s]+)/g, (_m, open, target) => open + (target.startsWith("<") ? `<${link(target.slice(1, -1))}>` : link(target)))
    .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/gm, (_m, open, target) => open + link(target))
    .replace(/`((?:daily|tasks|plans|reference)\/[^`\s]+|viewer\.config\.json)`/g, (match, path) => newPath(path) !== path && exists(path) ? `\`${newPath(path)}\`` : match);
}

// New contents for every Markdown file that changes, keyed by its old path.
const contents = new Map<string, string>();
const broken: string[] = [];
for (const path of files.filter((file) => file.endsWith(".md"))) {
  const text = await readFile(join(ROOT, path), "utf8");
  const next = rewrite(path, text, broken);
  if (next !== text) contents.set(path, next);
}
fixFirst.push(...broken);

// Path values in viewer.config.json, such as code.reposFile and code.prNotesDir.
if (fileSet.has("viewer.config.json")) {
  const text = await readFile(join(ROOT, "viewer.config.json"), "utf8");
  const next = text.replace(/"((?:daily|tasks|plans|reference)\/[^"]*|plans)"/g, (match, value) => newPath(value) !== value ? `"${newPath(value)}"` : match);
  if (next !== text) contents.set("viewer.config.json", next);
}

// Text outside the documents that still names the old layout, for an agent to update after --write.
const OLD_TEXT = /TASK-(?:\d{4}|NNNN)-assets|tasks\/TASK-(?:\d{4}|NNNN)\.md|daily\/(?:\d{4}|YYYY)\/(?:\d{2}|MM)\/(?:\d{2}|DD)|viewer\.config\.json|reference\/[\w.-]+\.json|reference\/(?:slack-channels|retired-tasks)\.md|(?<![\w.-])plans\/[\w<-]/;
async function leftovers() {
  const candidates = ["AGENTS.md", "CLAUDE.md", "README.md", "package.json", ...(await walk("scripts")), ...(await walk("hooks"))];
  const found: string[] = [];
  for (const path of candidates) {
    const text = contents.get(path) ?? await readFile(join(ROOT, path), "utf8").catch(() => "");
    text.split("\n").forEach((line, index) => { if (OLD_TEXT.test(line)) found.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`); });
  }
  return found;
}

const dirty = (await run("git", ["status", "--porcelain"]).then(({ stdout }) => stdout.trim(), () => null));
console.log(moves.size ? `Moves (${moves.size}):` : "Nothing to move: this workspace already uses the current layout.");
for (const [from, to] of moves) console.log(`  ${from} → ${to}`);
if (contents.size) console.log(`Rewrites: links or path values in ${contents.size} file(s).`);
if (write && dirty) fixFirst.push("The git working tree has uncommitted changes. Commit them first, so the migration is one reviewable diff.");
if (fixFirst.length) {
  console.log(`\nFix first (${fixFirst.length}):`);
  for (const item of fixFirst) console.log(`  ${item}`);
  console.log(`\nFix the list above, then run plan-viewer migrate again.${write ? " Nothing was changed." : ""}`);
  process.exit(1);
}
if (!write) {
  const left = await leftovers();
  if (left.length) console.log(`\nAfter --write, update these lines that name the old layout (${left.length}):\n${left.map((line) => `  ${line}`).join("\n")}`);
  console.log(`\nDry run; nothing changed.${moves.size ? ` Run plan-viewer migrate --write to apply.${dirty ? " Commit your changes first." : ""}` : ""}`);
  process.exit(0);
}

const tracked = new Set((await run("git", ["ls-files", "-z"]).then(({ stdout }) => stdout, () => "")).split("\0"));
for (const [from, to] of moves) {
  await mkdir(join(ROOT, dirname(to)), { recursive: true });
  if (tracked.has(from)) await run("git", ["mv", from, to]);
  else await rename(join(ROOT, from), join(ROOT, to));
}
for (const [path, text] of contents) await writeFile(join(ROOT, nowAt(path)), text);
// Remove the folders the moves emptied: old day folders, -assets folders, plans/.
async function prune(dir: string) {
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await prune(`${dir}/${entry.name}`);
  if (dir.includes("/") || dir === "plans") await rmdir(join(ROOT, dir)).catch(() => {});
}
for (const dir of ["tasks", "daily", "plans"]) await prune(dir);
if ((await stat(join(ROOT, "plans")).catch(() => null))?.isDirectory()) console.log("plans/ still holds files the migration did not move (such as .DS_Store); remove it by hand.");

const left = await leftovers();
console.log(`\nMigrated ${moves.size} file(s) and rewrote ${contents.size}.`);
if (left.length) console.log(`\nUpdate these lines that still name the old layout (${left.length}):\n${left.map((line) => `  ${line}`).join("\n")}`);
console.log("\nNext: run plan-viewer lint and plan-viewer links, review git diff --stat, then commit.");
