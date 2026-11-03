// Move one planning file and repair links: `npm run move -- <from> <to | TASK-NNNN>`.
// TASK-NNNN moves the file into tasks/TASK-NNNN-assets/. Rewrites relative Markdown links and
// backticked repository paths that point at the file, and the moved file's own relative links.
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { listDocuments, repositoryLinkPath, ROOT } from "./server.ts";

const [fromArg, target, extra] = process.argv.slice(2);
if (!fromArg || !target || extra) {
  console.error("Usage: npm run move -- <from> <to | TASK-NNNN>");
  process.exit(1);
}
// Paths are relative to the workspace; an absolute path works when it points inside it.
const inside = (path: string) => {
  const rel = relative(ROOT, resolve(ROOT, path));
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside the workspace`);
  return rel.split(sep).join("/");
};
const from = inside(fromArg);
const task = /^TASK-\d{4}$/.test(target);
const to = task ? `tasks/${target}-assets/${basename(from)}` : inside(target) + (target.endsWith("/") ? `/${basename(from)}` : "");
const exists = (path: string) => access(join(ROOT, path)).then(() => true, () => false);
if (!await exists(from)) throw new Error(`${from} does not exist`);
if ((await stat(join(ROOT, from))).isDirectory()) throw new Error(`${from} is a folder; move one file at a time so its links are repaired`);
if (task && !await exists(`tasks/${target}.md`)) throw new Error(`tasks/${target}.md does not exist`);
if (await exists(to)) throw new Error(`${to} already exists`);

const relativeLink = (fromDoc: string, path: string) => relative(dirname(fromDoc), path).split("\\").join("/");
const linkPattern = /\]\(([^)\s#]+)(#[^)\s]*)?\)/g;
const changed: string[] = [];

// Incoming links from every other planning document.
for (const doc of await listDocuments()) {
  if (doc.path === from || !doc.path.endsWith(".md")) continue;
  const text = await readFile(join(ROOT, doc.path), "utf8");
  const next = text
    .replace(linkPattern, (match, link, hash = "") => repositoryLinkPath(doc.path, link) === from ? `](${relativeLink(doc.path, to)}${hash})` : match)
    .replaceAll(`\`${from}\``, `\`${to}\``);
  if (next !== text) { await writeFile(join(ROOT, doc.path), next); changed.push(doc.path); }
}

// The moved file's own relative links.
if (from.endsWith(".md")) {
  const text = await readFile(join(ROOT, from), "utf8");
  const next = text.replace(linkPattern, (match, link, hash = "") => {
    if (/^[a-z][\w+.-]*:/i.test(link) || link.startsWith("/") || /^(daily|tasks|plans|reference)\//.test(link)) return match;
    return `](${relativeLink(to, join(dirname(from), link))}${hash})`;
  });
  if (next !== text) await writeFile(join(ROOT, from), next);
}

await mkdir(join(ROOT, dirname(to)), { recursive: true });
const tracked = await promisify(execFile)("git", ["ls-files", "--error-unmatch", from], { cwd: ROOT }).then(() => true, () => false);
if (tracked) await promisify(execFile)("git", ["mv", from, to], { cwd: ROOT });
else await rename(join(ROOT, from), join(ROOT, to));

console.log(`moved  ${from} -> ${to}`);
for (const path of changed) console.log(`linked ${path}`);
const parent = to.match(/^tasks\/(TASK-\d{4})-assets\//)?.[1];
if (parent && !(await readFile(join(ROOT, `tasks/${parent}.md`), "utf8").catch(() => "")).includes(`${parent}-assets/${basename(to)}`)) {
  console.log(`note   link ${basename(to)} from tasks/${parent}.md (npm run links reports unlinked assets)`);
}
