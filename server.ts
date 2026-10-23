import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseActions, parseWorkBreakdown, stalledTaskReason } from "./public/actions.js";
import { extractChatLinks } from "./public/markdown.js";
import { CodexDesktopClient, taskTitle } from "./codex-desktop.ts";
import { createLinkMetadataStore } from "./link-metadata.ts";
import { createCodeDashboard, githubImage } from "./code-dashboard.ts";
import { createIssueTracker } from "./issues.ts";
import { createPlans } from "./plans.ts";
import { linearImage } from "./linear.ts";
import { config, setConfig } from "./public/config.js";

// The planning workspace is the current directory (npm scripts run from the content repository); PLANNING_ROOT
// overrides it, and points tests at fixtures/planning so they never read live planning files.
export const ROOT = resolve(process.env.PLANNING_ROOT || process.cwd());
setConfig(loadConfig(ROOT));
const WORKSPACE = basename(ROOT);

// A missing viewer.config.json means defaults; a broken one stops the viewer rather than silently dropping preferences.
export function loadConfig(root: string) {
  try {
    return JSON.parse(readFileSync(join(root, "viewer.config.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`viewer.config.json: ${(error as Error).message}`);
  }
}

const isExcluded = (path: string) => config().exclude.some((folder: string) => path === folder || path.startsWith(`${folder}/`));
const PUBLIC = fileURLToPath(new URL("public", import.meta.url));
const lookupLinkMetadata = createLinkMetadataStore(ROOT);
const codeDashboard = createCodeDashboard(ROOT);
const plans = createPlans(ROOT, { repos: codeDashboard.readRepos, slug: codeDashboard.githubSlug });
const issueTracker = createIssueTracker(ROOT, async () => ({ prs: (await codeDashboard.prIndex()).prs, worktrees: await codeDashboard.worktreeIndex() }));
const PORT = Number(process.env.PLAN_VIEWER_PORT || process.env.PORT || config().port);
const MAX_COMMENT_LENGTH = 12_000;
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".dot"]);
const liveClients = new Set<ServerResponse>();

// The viewer's own checkout: what it runs, what is on disk, and how far origin is ahead (fetched at most every five minutes).
const VIEWER = fileURLToPath(new URL(".", import.meta.url));
const viewerGit = async (...args: string[]) => (await promisify(execFile)("git", args, { cwd: VIEWER, timeout: 60_000 })).stdout.trim();
const runningHead = await viewerGit("rev-parse", "HEAD").catch(() => "");
let lastFetch = 0;
async function viewerVersion() {
  if (Date.now() - lastFetch > 5 * 60_000) {
    lastFetch = Date.now();
    await viewerGit("fetch", "--quiet").catch(() => {});
  }
  const [head, behind] = await Promise.all([viewerGit("rev-parse", "HEAD"), viewerGit("rev-list", "--count", "HEAD..@{u}").then(Number, () => 0)]);
  return { running: runningHead, head, behind, watched: Boolean(process.env.PLAN_VIEWER_WATCHED) };
}
// Pulls when origin is ahead, then restarts: under `plan-viewer serve`, `node --watch` restarts when a loaded file's
// mtime changes, so touching this file restarts the server even when the pull only changed client files.
async function updateViewer() {
  const version = await viewerVersion();
  if (version.behind) await viewerGit("pull", "--ff-only").catch((error) => {
    throw new Error(String(error.stderr || error.message).split("\n").filter((line) => line && !line.startsWith("hint:")).join(" "));
  });
  const head = await viewerGit("rev-parse", "HEAD");
  if (version.watched && head !== runningHead) setTimeout(() => utimes(fileURLToPath(import.meta.url), new Date(), new Date()), 200);
  return { ...version, head, behind: 0 };
}
let dispatchSequence = 0;

function dispatchLog(requestId: string, stage: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), scope: "codex-dispatch", requestId, stage, ...details }));
}

let codexApp: CodexDesktopClient | null = null;

function getCodexApp() {
  if (!codexApp) {
    codexApp = new CodexDesktopClient((stage, details) => dispatchLog("desktop", stage, details));
  }
  return codexApp;
}

export type Chunk = {
  id: string;
  anchor: string;
  title: string;
  markdown: string;
  level: number;
  kind: "milestone" | "priority" | "section" | "overview";
};

export type TaskStatus = "open" | "active" | "waiting" | "deferred" | "completed";

export type TaskSummary = {
  id: string;
  title: string;
  summary: string;
  status: TaskStatus;
  project: string;
  tags: string[];
  created: string;
  updated: string;
  referencedBy?: string[];
  work?: { id: string; title: string; status: string }[];
  chatLinks?: { href: string; provider: string; label: string }[];
};

export function markdownHeadingId(value: string) {
  return value
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~\[\]]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

type DocumentSummary = {
  path: string;
  title: string;
  group: "Today" | "Daily" | "Tasks" | "Topics" | "Reference";
  format: "markdown" | "text";
  date?: string;
  kind: string;
  isToday: boolean;
  backlinks?: string[];
  issueKeys?: string[];
  task?: TaskSummary;
  digest?: DailyDigest;
};

// What a daily file says about the day's work, for the Weeks calendar: the tasks it lists (in order, with the
// bullet's note after the dash) and how many top-level outcome bullets it records.
type DailyDigest = { tasks: { id: string; note: string }[]; mentions: string[]; items: number; headings: string[] };

// Section headings that frame a day rather than name its work.
const FRAMING_HEADINGS = /^(start here|scheduled tasks|next steps|notes|chats|outcomes? for today|suggested order.*|below the cut line|completed.*|carry[- ]?over.*|references?)$/i;

export function dailyDigest(contents: string): DailyDigest {
  const tasks = new Map<string, string>();
  let items = 0;
  for (const line of contents.split("\n")) {
    if (!/^[-*] /.test(line)) continue;
    items += 1;
    const id = line.match(/TASK-\d{4}/)?.[0];
    if (id && !tasks.has(id)) tasks.set(id, line.replace(/^[-*] /, "").split(/\s+[—–-]\s+/).slice(1).join(" — ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim());
  }
  const mentions = [...new Set(contents.match(/TASK-\d{4}/g) || [])];
  // Plans from before file-backed tasks name their work in `##` headings such as `## Milestone 2: …` or `## 3. …`.
  const headings = [...contents.matchAll(/^## (.+)$/gm)].map(([, heading]) => heading.replace(/^(milestone \d+[:.]|\d+\.)\s*/i, "").trim()).filter((heading) => !FRAMING_HEADINGS.test(heading));
  return { tasks: [...tasks].map(([id, note]) => ({ id, note })), mentions, items, headings };
}

const TASK_STATUSES = new Set<TaskStatus>(["open", "active", "waiting", "deferred", "completed"]);

function frontMatterValue(value: string) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

export function parseTaskDocument(path: string, markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${path} must begin with task front matter.`);
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const field = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!field) throw new Error(`${path} has unsupported task front matter: ${line}`);
    fields.set(field[1], frontMatterValue(field[2]));
  }
  const required = ["id", "title", "summary", "status", "project", "tags", "created", "updated"];
  for (const key of required) if (!fields.has(key) || (key !== "tags" && !fields.get(key))) throw new Error(`${path} is missing task field “${key}”.`);
  const id = fields.get("id")!;
  const fileId = path.match(/(?:^|\/)(TASK-\d{4})\.md$/)?.[1];
  if (!/^TASK-\d{4}$/.test(id) || fileId !== id) throw new Error(`${path} must use the same TASK-0000 ID in its filename and front matter.`);
  const status = fields.get("status") as TaskStatus;
  if (!TASK_STATUSES.has(status)) throw new Error(`${path} has unsupported task status “${status}”.`);
  const rawTags = fields.get("tags")!;
  if (!/^\[.*\]$/.test(rawTags)) throw new Error(`${path} must express tags as an inline list.`);
  const tags = rawTags.slice(1, -1).split(",").map((tag) => frontMatterValue(tag)).filter(Boolean);
  const task: TaskSummary = {
    id,
    title: fields.get("title")!,
    summary: fields.get("summary")!,
    status,
    project: fields.get("project")!,
    tags,
    created: fields.get("created")!,
    updated: fields.get("updated")!,
  };
  const body = markdown.slice(match[0].length).trimStart();
  const chatLinks = extractChatLinks(body);
  if (chatLinks.length) task.chatLinks = chatLinks;
  return { task, body };
}

function todayPath() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `daily/${get("year")}/${get("month")}/${get("day")}/plan.md`;
}

// Rewrites only the status and updated lines of a task's front matter.
export async function setTaskStatus(path: string, status: string, root = ROOT, today = todayDate()) {
  if (!/^tasks\/TASK-\d{4}\.md$/.test(path)) throw new Error("Only task files can change status.");
  if (!TASK_STATUSES.has(status as TaskStatus)) throw new Error(`Unsupported task status “${status}”.`);
  const file = join(root, path);
  const contents = await readFile(file, "utf8");
  parseTaskDocument(path, contents);
  const end = contents.indexOf("\n---", 3);
  const front = contents.slice(0, end).replace(/^status:.*$/m, `status: ${status}`).replace(/^updated:.*$/m, `updated: ${today}`);
  const next = front + contents.slice(end);
  await writeFile(file, next);
  return parseTaskDocument(path, next).task;
}

function todayDate() {
  return todayPath().slice("daily/".length, -"/plan.md".length).replaceAll("/", "-");
}

async function walkDocuments(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(ROOT, directory), { withFileTypes: true });
  } catch {
    return [];
  }

  const found = await Promise.all(entries.map(async (entry) => {
    const child = join(directory, entry.name);
    if (isExcluded(child)) return [];
    if (entry.isDirectory()) return walkDocuments(child);
    return entry.isFile() && [".md", ".txt"].includes(extname(entry.name)) ? [child] : [];
  }));
  return found.flat().sort();
}

export function isViewableDocumentPath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  return (/^(daily|plans|reference)\/.+\.(md|txt)$/.test(normalized)
    && !isExcluded(normalized))
    || /^tasks\/TASK-\d{4}(\.md|-assets\/.+\.(md|txt))$/.test(normalized);
}

export function watchMarkdownSources(onChange: (path: string) => void, root = ROOT) {
  const watchers: FSWatcher[] = [];
  const pending = new Map<string, NodeJS.Timeout>();

  for (const source of ["daily", "tasks", "plans", "reference"]) {
    try {
      const watcher = watch(join(root, source), { recursive: true }, (_event, fileName) => {
        if (!fileName) return;
        const changedPath = join(source, fileName.toString()).replaceAll("\\", "/");
        if (!isViewableDocumentPath(changedPath)) return;
        clearTimeout(pending.get(changedPath));
        pending.set(changedPath, setTimeout(() => {
          pending.delete(changedPath);
          onChange(changedPath);
        }, 90));
      });
      watchers.push(watcher);
    } catch {
      // A source root may not exist yet; the viewer can still serve the others.
    }
  }

  return () => {
    for (const timer of pending.values()) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}

function titleFromMarkdown(markdown: string, fallback: string) {
  return markdown.match(/^#\s+(.+)$/m)?.[1].trim() || fallback.replace(/\.md$/, "");
}

export function summarize(path: string, contents: string, currentDate = todayDate()): DocumentSummary {
  const format = extname(path) === ".txt" ? "text" : "markdown";
  const fileName = path.split("/").at(-1) || path;
  const title = format === "markdown" ? titleFromMarkdown(contents, fileName) : fileName;
  const dateMatch = path.match(/^daily\/(\d{4})\/(\d{2})\/(\d{2})\/(.+)\.(md|txt)$/);
  const isToday = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` === currentDate : false;
  if (dateMatch) {
    const [, year, month, day, name] = dateMatch;
    return {
      path,
      title,
      group: isToday ? "Today" : "Daily",
      format,
      date: `${year}-${month}-${day}`,
      kind: format === "text" ? "Text file" : name === "plan" ? "Plan" : name === "done" ? "Done" : "Daily note",
      isToday,
      ...(format === "markdown" && (name === "plan" || name === "done") ? { digest: dailyDigest(contents) } : {}),
    };
  }
  const taskAsset = path.match(/^tasks\/(TASK-\d{4})-assets\//);
  if (taskAsset) return { path, title, group: "Task documents", format, kind: `${taskAsset[1]} document`, isToday: false };
  if (path.startsWith("tasks/")) {
    const { task } = parseTaskDocument(path, contents);
    return { path, title: task.title, group: "Tasks", format: "markdown", kind: "Task", isToday: false, task };
  }
  if (path.startsWith("plans/")) return { path, title, group: "Topics", format, kind: format === "text" ? "Text file" : "Topic", isToday: false };
  return { path, title, group: "Reference", format, kind: format === "text" ? "Text file" : "Reference", isToday: false };
}

export function repositoryLinkPath(from: string, target: string) {
  if (/^[a-z][\w+.-]*:/i.test(target)) return "";
  try {
    const decoded = decodeURIComponent(target);
    return /^(daily|tasks|plans|reference)\//.test(decoded) ? decoded : join(dirname(from), decoded).split(sep).join("/");
  } catch {
    return "";
  }
}

export async function listDocuments() {
  const paths = (await Promise.all([walkDocuments("daily"), walkDocuments("tasks"), walkDocuments("plans"), walkDocuments("reference")])).flat().filter(isViewableDocumentPath);
  const files = await Promise.all(paths.map(async (path) => ({ path, contents: await readFile(join(ROOT, path), "utf8") })));
  const docs = files.map(({ path, contents }) => summarize(path, contents));
  // Backlinks: every other document that mentions a task ID, links to a document, or names one by repository path.
  const known = new Set(docs.map((doc) => doc.path));
  const backlinks = new Map<string, Set<string>>();
  const addBacklink = (target: string, from: string) => {
    if (target === from || !known.has(target)) return;
    if (!backlinks.has(target)) backlinks.set(target, new Set());
    backlinks.get(target)!.add(from);
  };
  for (const { path, contents } of files) {
    for (const [, n] of contents.matchAll(/TASK-(\d{4})/gi)) addBacklink(`tasks/TASK-${n}.md`, path);
    for (const [, target] of contents.matchAll(/\]\(([^)\s#]+)/g)) addBacklink(repositoryLinkPath(path, target), path);
    for (const [, target] of contents.matchAll(/`((?:daily|tasks|plans|reference)\/[^`\s]+)`/g)) addBacklink(target, path);
  }
  // Tracker keys (ACME-123, ENG-45, bare or inside a URL) each document mentions, so an issue can list its planning docs.
  for (const [index, { contents }] of files.entries()) {
    const keys = [...new Set(contents.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || [])].filter((key) => !key.startsWith("TASK-"));
    if (keys.length) docs[index].issueKeys = keys;
  }
  // Work breakdown items, so ⌘K can find one without opening its task.
  for (const [index, { path, contents }] of files.entries()) {
    if (docs[index].kind !== "Task") continue;
    const breakdown = parseChunks(parseTaskDocument(path, contents).body).find((chunk) => /^work breakdown$/i.test(chunk.title));
    const nodes = breakdown ? parseWorkBreakdown(breakdown.markdown).nodes : [];
    if (nodes.length) docs[index].task!.work = nodes.map(({ id, title, status }) => ({ id, title, status }));
  }
  for (const doc of docs) {
    const sources = [...(backlinks.get(doc.path) || [])];
    if (!sources.length) continue;
    doc.backlinks = sources;
    if (doc.task) doc.task.referencedBy = sources;
  }
  return docs.sort((a, b) => {
    if (a.isToday !== b.isToday) return a.isToday ? -1 : 1;
    if ((a.group === "Today" || a.group === "Daily") && (b.group === "Today" || b.group === "Daily")) {
      const kindOrder = { Plan: 0, Done: 1, "Daily note": 2 };
      return (b.date || "").localeCompare(a.date || "")
        || (kindOrder[a.kind as keyof typeof kindOrder] ?? 3) - (kindOrder[b.kind as keyof typeof kindOrder] ?? 3)
        || a.title.localeCompare(b.title);
    }
    if (a.group === "Tasks" && b.group === "Tasks") return (b.task?.updated || "").localeCompare(a.task?.updated || "") || a.title.localeCompare(b.title);
    return a.path.localeCompare(b.path);
  });
}

export function parseChunks(markdown: string): Chunk[] {
  const lines = markdown.split(/\r?\n/);
  let fence = "";
  const headings = lines.flatMap((line, index) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { fence = fence ? "" : marker[1][0]; return []; }
    if (fence) return [];
    const match = line.match(/^(#{2,3})\s+(.+)$/);
    return match ? [{ index, level: match[1].length, title: match[2].trim() }] : [];
  });
  const milestones = headings.filter((heading) => heading.level === 2 && /^Milestone\s+\d+/i.test(heading.title));
  const priorities = headings.filter((heading) => heading.level === 3 && /^\d+\.\s+/.test(heading.title));
  const special = headings.filter(heading => heading.level === 2 && /^(next actions|next steps|work breakdown|scheduled tasks)$/i.test(heading.title));
  const selected = milestones.length ? milestones : priorities.length ? priorities : headings.filter(heading => heading.level === 2);
  const chosen = [...new Set([...selected, ...special])].sort((a, b) => a.index - b.index);

  const chunks: Chunk[] = [];
  const firstHeading = chosen[0]?.index ?? lines.length;
  const intro = lines.slice(0, firstHeading).join("\n").trim();
  const introWithoutTitle = intro.replace(/^#\s+.+\n?/, "").trim();
  if (introWithoutTitle && chosen.length) {
    chunks.push({ id: "overview", anchor: "overview", title: "Overview", markdown: introWithoutTitle, level: 1, kind: "overview" });
  }

  chosen.forEach((heading, position) => {
    const end = chosen[position + 1]?.index ?? lines.length;
    const body = lines.slice(heading.index + 1, end).join("\n").trim();
    chunks.push({
      id: `chunk-${position + 1}`,
      anchor: markdownHeadingId(heading.title),
      title: heading.title,
      markdown: body,
      level: heading.level,
      kind: milestones.length ? "milestone" : priorities.length ? "priority" : "section",
    });
  });

  if (!chunks.length) {
    chunks.push({ id: "document", anchor: "document", title: titleFromMarkdown(markdown, "Document"), markdown, level: 1, kind: "overview" });
  }
  return chunks;
}

function safeDocumentPath(requested: string) {
  const normalized = normalize(requested).replaceAll("\\", "/");
  if (normalized.startsWith("../") || normalized.includes("/../") || !isViewableDocumentPath(normalized)) throw new Error("Invalid document path.");
  const absolute = resolve(ROOT, normalized);
  if (!absolute.startsWith(ROOT + sep)) throw new Error("Invalid document path.");
  return { relative: normalized, absolute };
}

export function safeAssetPath(requested: string) {
  const normalized = normalize(requested).replaceAll("\\", "/");
  if (normalized.startsWith("../") || normalized.includes("/../") || !/^(daily|tasks|plans|reference)\/.+/.test(normalized) || !ASSET_EXTENSIONS.has(extname(normalized).toLowerCase())) throw new Error("Invalid asset path.");
  const absolute = resolve(ROOT, normalized);
  if (!absolute.startsWith(ROOT + sep)) throw new Error("Invalid asset path.");
  return { relative: normalized, absolute };
}

export async function loadDocument(requested: string) {
  const path = safeDocumentPath(requested);
  const contents = await readFile(path.absolute, "utf8");
  const summary = summarize(path.relative, contents);
  const renderedContents = summary.kind === "Task" ? parseTaskDocument(path.relative, contents).body : contents;
  const chunks = summary.format === "markdown"
    ? parseChunks(renderedContents)
    : [{ id: "document", anchor: "document", title: summary.title, markdown: contents, level: 1, kind: "overview" as const }];
  const nextActions = chunks.filter(chunk => /^(next actions|next steps)$/i.test(chunk.title)).flatMap(chunk => parseActions(chunk.markdown, path.relative));
  const breakdown = chunks.find(chunk => /^work breakdown$/i.test(chunk.title));
  const work = parseWorkBreakdown(breakdown?.markdown || "");
  for (const action of nextActions) {
    const node = work.nodes.find(node => node.id === action.workItem);
    const unavailable = ["completed", "deferred", "waiting"].includes(summary.task?.status || "");
    action.blocked = unavailable || Boolean(action.workItem && (!node || !node.ready));
    // Advisory only: a waiting action still opens its draft, and the reason says what it is waiting on.
    const waitingOn = node?.deps.filter(id => work.nodes.find(dep => dep.id === id)?.status !== "completed") || [];
    action.blockedReason = !action.blocked ? ""
      : unavailable ? `Task is ${summary.task?.status}`
      : !node ? `${action.workItem} is not in the work breakdown`
      : work.warnings.length ? "Work breakdown needs repair"
      : waitingOn.length ? `After ${waitingOn.join(", ")}`
      : `${node.id} is ${node.status}`;
  }
  const scheduledActions = [];
  const actionWarnings: string[] = [];
  const stalled = stalledTaskReason(summary.task?.status, nextActions, work);
  if (stalled) actionWarnings.push(stalled);
  if (summary.kind === "Plan") {
    const scheduled = chunks.find(chunk => /^scheduled tasks$/i.test(chunk.title));
    const ids = new Set([...(scheduled?.markdown || "").matchAll(/\[[^\]]+\]\([^)]*tasks\/(TASK-\d{4})\.md(?:#[^)]*)?\)/g)].map(match => match[1]));
    for (const id of ids) {
      try {
        const task = await loadDocument(`tasks/${id}.md`);
        if (["completed", "deferred", "waiting"].includes(task.task?.status || "")) continue;
        scheduledActions.push(...task.nextActions.map(action => ({ ...action, taskTitle: `${id} · ${task.title}` })));
      } catch { actionWarnings.push(`Could not load ${id}. Check the scheduled task link.`); }
    }
    if (scheduledActions.length && !chunks.some(chunk => /^next steps$/i.test(chunk.title))) {
      chunks.splice(chunks.findIndex(chunk => chunk === scheduled) + 1, 0, { id: "scheduled-next-steps", anchor: "next-steps", title: "Next steps", markdown: "", level: 2, kind: "section" });
    }
  }
  return { ...summary, absolutePath: path.absolute, markdown: contents, chatLinks: extractChatLinks(renderedContents), chunks, nextActions, scheduledActions, actionWarnings, work };
}

const CHAT_LINK_INSTRUCTION = "When your current conversation URL or thread ID is available from trusted session context or app tools, record a labeled Markdown link under ## Chats in the authoritative task or daily plan you work on. Use the verified conversation URL (a ChatGPT or Claude link) or codex://threads/<thread-id>. Keep existing links and avoid duplicates. Do not guess IDs, use a shared snapshot as a follow-up link, or associate unrelated chats. If this is a global request, record the link only after identifying its task or daily plan. If the URL or ID is unavailable, continue the work without inventing a link.";

export function buildCodexPrompt(document: Awaited<ReturnType<typeof loadDocument>>, chunk: Chunk, commentary: string) {
  return `Task: ${taskTitle(chunk.title)}\n\nYou are receiving a work handoff from the local ${config().title}. Work in the ${WORKSPACE} repository and follow its AGENTS.md instructions. The source file remains authoritative.\n\nSource file: ${document.path}\nDocument: ${document.title}\nSelected ${chunk.kind}: ${chunk.title}\n\nSelected chunk:\n\n${chunk.markdown}\n\n${config().user}'s commentary:\n\n${commentary.trim()}\n\nInterpret the selected chunk together with ${config().user}'s commentary. Inspect the source file and relevant repository context before acting. If the commentary asks for a change or implementation, carry it through; if it asks for analysis, report evidence-backed findings. Preserve unrelated work and update the planning Markdown when the requested outcome calls for it.\n\n${CHAT_LINK_INSTRUCTION}`;
}

export function buildDocumentCodexPrompt(document: Awaited<ReturnType<typeof loadDocument>>, commentary: string) {
  return `Task from the local ${config().title}\n\nWork in the ${WORKSPACE} repository and follow its AGENTS.md instructions. The attached file path is the authoritative context; inspect the file before acting.\n\nSource file: ${document.path}\n\n${config().user}'s commentary:\n\n${commentary.trim()}\n\nCarry out ${config().user}'s request using the source file and relevant repository context. Preserve unrelated work.\n\n${CHAT_LINK_INSTRUCTION}`;
}

export function buildGlobalCodexPrompt(commentary: string) {
  return `Task from the local ${config().title}\n\nWork in the ${WORKSPACE} repository and follow its AGENTS.md instructions. No plan, file, or chunk context is attached to this task.\n\n${config().user}'s request:\n\n${commentary.trim()}\n\nCarry out ${config().user}'s request using relevant repository context. Preserve unrelated work.\n\n${CHAT_LINK_INSTRUCTION}`;
}

export function buildActionPrompt(document: Awaited<ReturnType<typeof loadDocument>>, action: { title: string; prompt: string }, commentary: string) {
  return `Advance this next action: ${action.title}\n\nPlanning workspace: ${ROOT}\nSource file: ${document.absolutePath}\nRead the source file and the workspace AGENTS.md before acting. Follow the applicable target repository instructions and preserve unrelated work.\n\n${commentary.trim() ? `${config().user}'s direction for this run (takes precedence over the stored prompt where they differ):\n${commentary.trim()}\n\n` : ""}Stored action prompt:\n${action.prompt}\n\nCarry out the bounded action and verify its result. Record evidence and any remaining blocker in the authoritative task file. Update task state and the work breakdown only when supported by the result. Do not treat drafting a message as authorization to send it.\n\n${CHAT_LINK_INSTRUCTION}`;
}

type WorkNode = { id: string; title: string; status: string; deps: string[]; parent: string; ready: boolean };

// One work breakdown item, either carried out ("run") or rewritten in the task file ("update"). Items that are not ready
// can be sent too; the prompt says what they still wait on so the agent confirms before acting.
export function buildWorkItemPrompt(document: Awaited<ReturnType<typeof loadDocument>>, node: WorkNode, mode: "run" | "update", commentary: string) {
  const nodes = document.work.nodes as WorkNode[];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const line = (n: WorkNode) => `${n.id}: ${n.title} [${n.status}]`;
  const parent = byId.get(node.parent);
  const waiting = node.deps.filter((id) => byId.get(id)?.status !== "completed");
  const action = document.nextActions.find((a) => a.workItem === node.id);
  const direction = commentary.trim() ? `${config().user}'s direction${mode === "run" ? " for this run (takes precedence over the stored prompt where they differ)" : ""}:\n${commentary.trim()}\n\n` : "";
  const facts = `Planning workspace: ${ROOT}\nSource file: ${document.absolutePath}\nTask: ${document.task?.id || document.title} · ${document.task?.title || document.title}\nWork item: ${line(node)}${parent ? `\nPart of: ${line(parent)}` : ""}${node.deps.length ? `\nAfter: ${node.deps.map((id) => byId.get(id) ? line(byId.get(id)!) : id).join("; ")}` : ""}${action ? `\nLinked next action: ${action.title}` : ""}`;
  if (mode === "update") {
    return `Update work item ${node.id} in its task file. Do not carry out the work itself.\n\n${facts}\n\nRead the source file and the workspace AGENTS.md first.\n\n${direction}Revise ${node.id} so the work breakdown matches current understanding: its title, status, nesting, (after: ...) prerequisites, and its linked next action and prompt where one exists. Use the task's Findings and Updates as evidence. Keep IDs stable unless a rename is asked for, and update every reference when one changes. Add a dated update whose bold title names (${node.id}) saying what changed and why. Run the workspace lint on the task and fix what it reports.\n\n${CHAT_LINK_INSTRUCTION}`;
  }
  const frontier = node.ready ? "" : `\nThis item is not ready: ${waiting.length ? `it waits on ${waiting.map((id) => byId.get(id) ? line(byId.get(id)!) : id).join("; ")}` : `its status is ${node.status}`}. Check whether that still holds before acting. If it does, do only the preparation that is safe now and report what remains blocked.\n`;
  return `Advance work item ${node.id}: ${node.title}\n\n${facts}\n${frontier}\nRead the source file and the workspace AGENTS.md before acting. Follow the applicable target repository instructions and preserve unrelated work.\n\n${direction}${action ? `Stored action prompt:\n${action.prompt}\n\n` : ""}Carry out the bounded work and verify its result. Record evidence and any remaining blocker in the authoritative task file. Update the item's status in the work breakdown only when supported by the result. Do not treat drafting a message as authorization to send it.\n\n${CHAT_LINK_INSTRUCTION}`;
}

const MAX_IMAGES = 6;

// Pasted images arrive as data URLs and land in the workspace's ignored tmp/ so either agent can open them by path.
export async function saveHandoffImages(images: unknown[]) {
  if (images.length > MAX_IMAGES) throw new Error(`Attach at most ${MAX_IMAGES} images.`);
  const folder = join(ROOT, "tmp", "handoff-images");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const paths = [];
  for (const [index, image] of images.entries()) {
    const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(image));
    if (!match) throw new Error("Only PNG, JPEG, GIF, and WebP images can be attached.");
    await mkdir(folder, { recursive: true });
    const file = join(folder, `${stamp}-${index + 1}.${match[1] === "jpeg" ? "jpg" : match[1]}`);
    await writeFile(file, Buffer.from(match[2], "base64"));
    paths.push(file);
  }
  return paths;
}

async function dispatchToCodex(path: string, scope: string, chunkId: string, commentary: string, requestId: string, actionId = "", expectedPrompt = "", app = "codex", images: string[] = [], workItem = "", mode = "") {
  const openDraft = (title: string, prompt: string) => getCodexApp().openDraft(ROOT, title, prompt, app, images);
  if (scope === "action") {
    const document = await loadDocument(path);
    const action = document.nextActions.find(action => action.id === actionId);
    if (!action || action.prompt !== expectedPrompt) throw new Error("This action changed. Reload the task and prepare it again.");
    if (commentary.length > MAX_COMMENT_LENGTH) throw new Error("Additional context is too long.");
    const prompt = buildActionPrompt(document, action, commentary);
    dispatchLog(requestId, "validated", { scope, path, actionId });
    if (process.env.PLAN_VIEWER_DRY_RUN === "1") return { accepted: true, draftOpened: true, dryRun: true };
    return { accepted: true, ...await openDraft(action.title, prompt) };
  }
  if (scope === "work") {
    const document = await loadDocument(path);
    const node = (document.work.nodes as WorkNode[]).find((n) => n.id === workItem);
    if (!node) throw new Error(`Work item ${workItem} is no longer in this task. Reload it and try again.`);
    if (mode !== "run" && mode !== "update") throw new Error("Choose to run or update the work item.");
    if (commentary.length > MAX_COMMENT_LENGTH) throw new Error("Additional context is too long.");
    const prompt = buildWorkItemPrompt(document, node, mode, commentary);
    dispatchLog(requestId, "validated", { scope, path, workItem, mode });
    if (process.env.PLAN_VIEWER_DRY_RUN === "1") return { accepted: true, draftOpened: true, dryRun: true };
    return { accepted: true, ...await openDraft(`${mode === "update" ? "Update" : "Advance"} ${node.id}: ${node.title}`, prompt) };
  }
  if (!commentary.trim()) throw new Error("Add a request before opening a draft.");
  if (commentary.length > MAX_COMMENT_LENGTH) throw new Error("Commentary is too long for this first version.");
  if (scope === "global") {
    const prompt = buildGlobalCodexPrompt(commentary);
    dispatchLog(requestId, "validated", { scope, commentaryLength: commentary.length });
    if (process.env.PLAN_VIEWER_DRY_RUN === "1") return { accepted: true, draftOpened: true, dryRun: true };
    const result = await openDraft("Plan viewer command", prompt);
    dispatchLog(requestId, "draft-opened", { draftOpened: result.draftOpened });
    return { accepted: true, ...result };
  }
  const document = await loadDocument(path);
  if (scope === "document") {
    const prompt = buildDocumentCodexPrompt(document, commentary);
    dispatchLog(requestId, "validated", { scope, path: document.path, commentaryLength: commentary.length });
    if (process.env.PLAN_VIEWER_DRY_RUN === "1") return { accepted: true, draftOpened: true, dryRun: true };
    const result = await openDraft(document.title, prompt);
    dispatchLog(requestId, "draft-opened", { draftOpened: result.draftOpened });
    return { accepted: true, ...result };
  }
  if (scope !== "chunk") throw new Error("Choose a valid draft context.");
  const chunk = document.chunks.find((candidate) => candidate.id === chunkId);
  if (!chunk) throw new Error("That chunk is no longer present. Reload the document and try again.");
  const prompt = buildCodexPrompt(document, chunk, commentary);
  dispatchLog(requestId, "validated", { path: document.path, chunkId, chunkTitle: chunk.title, commentaryLength: commentary.length });

  if (process.env.PLAN_VIEWER_DRY_RUN === "1") return { accepted: true, draftOpened: true, dryRun: true };
  const result = await openDraft(chunk.title, prompt);
  dispatchLog(requestId, "draft-opened", { draftOpened: result.draftOpened });
  return { accepted: true, ...result };
}

// Slack's desktop app ignores https permalinks handed to it, so translate them into slack:// deep links. The team ID
// comes from the app's own workspace list; without it we fall back to the permalink.
export async function slackDeepLink(permalink: string, statePath = join(homedir(), "Library/Application Support/Slack/storage/root-state.json")) {
  const url = new URL(permalink);
  const [, channel, p] = url.pathname.match(/^\/archives\/([A-Z0-9]+)\/p(\d{16})$/) || [];
  if (!channel) throw new Error("Not a message permalink.");
  const domain = url.hostname.split(".")[0];
  const workspaces = Object.values(JSON.parse(await readFile(statePath, "utf8")).workspaces || {}) as { id: string; domain: string }[];
  const team = workspaces.find((workspace) => workspace.domain === domain)?.id;
  if (!team) throw new Error(`No Slack workspace for ${domain}.`);
  const link = new URLSearchParams({ team, id: channel, message: `${p.slice(0, 10)}.${p.slice(10)}` });
  const threadTs = url.searchParams.get("thread_ts");
  if (threadTs) link.set("thread_ts", threadTs);
  return `slack://channel?${link}`;
}

function checkedPr(slug: unknown, number: unknown): [string, number] {
  const value = Number(number);
  if (typeof slug !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(slug) || !Number.isInteger(value)) throw new Error("Bad pull request.");
  return [slug, value];
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage, maxBytes = 64_000) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > maxBytes) throw new Error("Request is too large.");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

function serveLiveEvents(request: IncomingMessage, response: ServerResponse) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  response.write(": connected\n\n");
  liveClients.add(response);
  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
  request.once("close", () => {
    clearInterval(heartbeat);
    liveClients.delete(response);
  });
}

function broadcastMarkdownChange(path: string) {
  const message = `event: markdown\ndata: ${JSON.stringify({ path })}\n\n`;
  for (const client of liveClients) client.write(message);
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".dot": "text/plain; charset=utf-8",
};

export async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/documents") return json(response, 200, { documents: await listDocuments(), defaultPath: todayPath() });
    if (request.method === "GET" && url.pathname === "/api/document") return json(response, 200, await loadDocument(url.searchParams.get("path") || ""));
    if (request.method === "GET" && (url.pathname === "/api/linear-image" || url.pathname === "/api/github-image")) {
      const image = url.pathname === "/api/linear-image" ? await linearImage(ROOT, url.searchParams.get("url") || "")
        : await githubImage(ROOT, url.searchParams.get("slug") || "", Number(url.searchParams.get("number")), url.searchParams.get("id") || "");
      // SVG from a third party could run script if opened directly, so it is sandboxed.
      response.writeHead(200, { "content-type": image.type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" });
      response.end(image.body);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/asset") {
      const asset = safeAssetPath(url.searchParams.get("path") || "");
      const assetStat = await stat(asset.absolute);
      if (!assetStat.isFile()) return json(response, 404, { error: "Asset not found." });
      response.writeHead(200, {
        "content-type": contentTypes[extname(asset.absolute).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      response.end(await readFile(asset.absolute));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") return serveLiveEvents(request, response);
    if (request.method === "POST" && url.pathname === "/api/open-slack") {
      const target = String((await readJson(request)).url || "");
      if (!/^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[\w/?=&.%-]+$/i.test(target)) return json(response, 400, { error: "Not a Slack permalink." });
      await promisify(execFile)("open", await slackDeepLink(target).then((link) => [link], () => ["-a", "Slack", target]));
      return json(response, 200, { opened: true });
    }
    if (request.method === "GET" && url.pathname === "/api/version") return json(response, 200, await viewerVersion());
    if (request.method === "POST" && url.pathname === "/api/version/update") return json(response, 200, await updateViewer());
    if (request.method === "GET" && url.pathname === "/api/config") return json(response, 200, config());
    if (request.method === "GET" && url.pathname === "/api/code") return json(response, 200, await codeDashboard.load(url.searchParams.has("refresh")));
    if (request.method === "GET" && url.pathname === "/api/code/plans") return json(response, 200, await plans.load(url.searchParams.has("refresh")));
    if (request.method === "GET" && url.pathname === "/api/code/plan-map") return json(response, 200, await plans.map(url.searchParams.get("id") || ""));
    if (request.method === "GET" && url.pathname === "/api/code/plan-doc") return json(response, 200, await plans.doc(url.searchParams.get("repo") || "", url.searchParams.get("ref") || "", url.searchParams.get("path") || ""));
    if (request.method === "GET" && url.pathname === "/api/code/pr-index") return json(response, 200, await codeDashboard.prIndex());
    if (request.method === "GET" && url.pathname === "/api/code/local-dir") return json(response, 200, await codeDashboard.localDir(url.searchParams.get("path") || "", url.searchParams.get("dir") || ""));
    if (request.method === "GET" && url.pathname === "/api/code/worktree") return json(response, 200, await codeDashboard.worktreeDetail(url.searchParams.get("path") || ""));
    if (request.method === "GET" && url.pathname === "/api/code/commits") return json(response, 200, await codeDashboard.commits(url.searchParams.get("scope") || "local"));
    if (request.method === "GET" && url.pathname === "/api/code/commit") return json(response, 200, await codeDashboard.commitDetail(url.searchParams.get("repo") || "", url.searchParams.get("sha") || ""));
    if (request.method === "GET" && url.pathname === "/api/code/diff") return json(response, 200, await codeDashboard.diff(url.searchParams));
    if (request.method === "GET" && url.pathname === "/api/code/commit-summary") return json(response, 200, await codeDashboard.commitSummary(url.searchParams));
    if (request.method === "GET" && url.pathname === "/api/code/sides") return json(response, 200, await codeDashboard.fileSides(url.searchParams));
    if (request.method === "GET" && url.pathname === "/api/code/file") return json(response, 200, await codeDashboard.fileContent(url.searchParams));
    if (request.method === "GET" && url.pathname === "/api/code/pr") return json(response, 200, await codeDashboard.prDetail(url.searchParams.get("slug") || "", Number(url.searchParams.get("number"))));
    if (request.method === "GET" && url.pathname === "/api/code/runs") return json(response, 200, { runs: codeDashboard.allRuns() });
    if (request.method === "GET" && url.pathname === "/api/code/run") return json(response, 200, codeDashboard.runLog(url.searchParams.get("path") || "") || { state: "stopped", log: [] });
    if (request.method === "GET" && url.pathname === "/api/code/notes") return json(response, 200, await codeDashboard.notes.list(...checkedPr(url.searchParams.get("slug"), url.searchParams.get("number"))));
    if (request.method === "POST" && url.pathname.startsWith("/api/code/")) {
      const body = await readJson(request);
      const action = url.pathname.slice("/api/code/".length);
      if (action === "notes") return json(response, 200, await codeDashboard.notes.change(...checkedPr(body.slug, body.number), { op: body.op, id: String(body.id || ""), title: String(body.title || ""), note: body.note || {} }));
      if (action === "plan-agent") return json(response, 200, await plans.launch(String(body.app || ""), String(body.id || ""), String(body.kind || ""), String(body.doc || "")).then(() => ({ opened: true })));
      if (action === "plan-prompt") return json(response, 200, await plans.prompt(String(body.app || ""), String(body.id || ""), String(body.kind || ""), String(body.doc || "")));
      if (action === "add-repo") return json(response, 200, { repo: await codeDashboard.addRepo(String(body.path || "")) });
      if (action === "remove-repo") return json(response, 200, await codeDashboard.removeRepo(String(body.path || "")).then(() => ({ removed: true })));
      if (action === "preview") return json(response, 200, await codeDashboard.openPreview(String(body.repo || ""), String(body.number || "")).then(() => ({ opened: true })));
      if (action === "run") return json(response, 200, await (body.path ? codeDashboard.startRun(String(body.path)) : codeDashboard.runPr(String(body.repo || ""), String(body.branch || ""))));
      if (action === "restart-run") return json(response, 200, await codeDashboard.restartRun(String(body.path || "")));
      if (action === "stop-run") return json(response, 200, (codeDashboard.stopRun(String(body.path || "")), { stopped: true }));
      if (action === "open") return json(response, 200, await codeDashboard.open(String(body.kind || ""), String(body.path || "")).then(() => ({ opened: true })));
      const paths = Array.isArray(body.paths) ? body.paths.map(String).slice(0, 500) : [];
      if (action === "line-counts") return json(response, 200, await codeDashboard.lineCounts(new URLSearchParams(body.params || {}), paths));
      if (action === "remove-worktrees") return json(response, 200, { results: await codeDashboard.removeWorktrees(paths) });
      if (action === "cleanup-prompt") return json(response, 200, codeDashboard.cleanupPrompt(paths));
      if (action === "cleanup-agent") return json(response, 200, await codeDashboard.launchCleanup(String(body.app || ""), paths).then(() => ({ opened: true })));
      if (action === "session") return json(response, 200, await codeDashboard.launchSession(String(body.app || ""), String(body.path || "")).then(() => ({ opened: true })));
      if (action === "agent") return json(response, 200, await codeDashboard.launchAgent(String(body.app || ""), String(body.skill || ""), String(body.url || ""), String(body.path || "")).then(() => ({ opened: true })));
    }
    if (request.method === "GET" && url.pathname === "/api/issues") return json(response, 200, await issueTracker.load(url.searchParams.has("refresh")));
    if (request.method === "GET" && url.pathname === "/api/issues/issue") return json(response, 200, issueTracker.detail(url.searchParams.get("key") || ""));
    if (request.method === "POST" && url.pathname === "/api/issues/agent") {
      const body = await readJson(request);
      await issueTracker.launchAgent(String(body.app || ""), String(body.skill || ""), Array.isArray(body.keys) ? body.keys.map(String).slice(0, 50) : []);
      return json(response, 200, { opened: true });
    }
    if (request.method === "POST" && url.pathname === "/api/link-metadata") {
      const body = await readJson(request);
      const keys = Array.isArray(body.keys) ? body.keys.map(String).slice(0, 1000) : [];
      return json(response, 200, { metadata: { ...await lookupLinkMetadata(keys), ...issueTracker.aliasMetadata(keys) } });
    }
    if (request.method === "POST" && url.pathname === "/api/task-status") {
      const body = await readJson(request);
      return json(response, 200, { task: await setTaskStatus(String(body.path || ""), String(body.status || "")) });
    }
    if (request.method === "POST" && url.pathname === "/api/dispatch") {
      const requestId = `dispatch-${Date.now()}-${++dispatchSequence}`;
      const body = await readJson(request, 50_000_000);
      dispatchLog(requestId, "received", { path: String(body.path || ""), scope: String(body.scope || ""), chunkId: String(body.chunkId || "") });
      try {
        return json(response, 202, await dispatchToCodex(String(body.path || ""), String(body.scope || ""), String(body.chunkId || ""), String(body.commentary || ""), requestId, String(body.actionId || ""), String(body.expectedPrompt || ""), String(body.app || "codex"), await saveHandoffImages(Array.isArray(body.images) ? body.images : []), String(body.workItem || ""), String(body.mode || "")));
      } catch (error) {
        dispatchLog(requestId, "failed", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }

    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = resolve(PUBLIC, requested);
    if (!file.startsWith(PUBLIC + sep)) return json(response, 404, { error: "Not found." });
    await stat(file);
    response.writeHead(200, { "content-type": contentTypes[extname(file)] || "application/octet-stream" });
    response.end(await readFile(file));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    json(response, message.includes("ENOENT") ? 404 : 400, { error: message });
  }
}

export function startServer(port = PORT) {
  const server = createServer(handleRequest);
  const closeWatchers = watchMarkdownSources(broadcastMarkdownChange);
  codeDashboard.startBackgroundRefresh();
  issueTracker.startBackgroundRefresh();
  server.once("close", () => {
    closeWatchers();
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`${config().title} is ready for ${ROOT} at http://127.0.0.1:${port}`);
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
