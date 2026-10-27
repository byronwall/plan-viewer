import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeNewSessionUrl, codexNewTaskUrl } from "./codex-desktop.ts";
import { config } from "./public/config.js";
import { fetchGithub, githubLogin } from "./github.ts";
import { fetchLinear, linearClient } from "./linear.ts";

// Jira issues for the Issues page (viewer.config.json `issues`), read through `acli` and cached in tmp/issues-cache.json.
// acli's search returns only a few fields, so a sync lists keys with search and reads each issue with `view --fields *all`.
// Each refresh re-reads only what changed (`updated >= -Nm`), and the difference from the previous copy is the activity feed,
// since acli exposes no changelog.

const exec = promisify(execFile);
const VIEW_CONCURRENCY = 8;
const ACTIVITY_LIMIT = 3000;
const FULL_SCAN_MS = 60 * 60_000; // keys that left the scope (component removed, moved project) drop out on the next full scan

type Person = { name: string; email: string; login?: string };
type Comment = { id: string; author: Person | null; created: string; body: string };
type Link = { type: string; label: string; key: string; display?: string; summary: string; status: string; category: string };
// Jira issues, and Linear issues and projects (linear.ts) and GitHub issues (github.ts) in the same shape. `label` is the shown key when `key` is namespaced,
// `mirrorOf` the Jira key a Linear issue was synced from, `triage` a Linear issue in its team's Triage state.
export type Issue = {
  key: string; label?: string; source?: "jira" | "linear" | "github"; url?: string; mirrorOf?: string; triage?: boolean; summary: string; project: string; type: string; level: number; status: string; category: string; priority: string;
  assignee: Person | null; reporter: Person | null; labels: string[]; components: string[]; parent: string; created: string; updated: string;
  resolution: string; due: string; start: string; confidence: string; statusUpdate: string; links: Link[]; prCount: number; prState: string;
  description: string; comments: Comment[]; attachments: number; prUrls: string[];
  initiatives?: { name: string; url: string }[]; resources?: { name: string; url: string }[];
  milestones?: { name: string; description: string; target: string; progress: number; status: string }[];
};
type Activity = { at: string; key: string; kind: string; from?: string; to?: string; by?: string; text?: string };
type Cache = { at: number; fullAt: number; scope: string[]; issues: Record<string, Issue>; activity: Activity[]; me: string; site: string; linearAt: number; linearFullAt: number; githubAt: number; githubMe: string };

// ---------- Atlassian document format → Markdown ----------

// Jira bodies are ADF trees; the viewer renders Markdown, so convert the node types Jira actually emits.
export function adfToMarkdown(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  return block(node).replace(/\n{3,}/g, "\n\n").trim();
}

function inline(nodes: any[] = []): string {
  return nodes.map((node) => {
    if (node.type === "hardBreak") return "  \n";
    if (node.type === "mention") return `@${String(node.attrs?.text || "").replace(/^@/, "")}`;
    if (node.type === "emoji") return node.attrs?.text || node.attrs?.shortName || "";
    if (node.type === "inlineCard" || node.type === "blockCard" || node.type === "embedCard") return node.attrs?.url || "";
    if (node.type === "date") return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : "";
    if (node.type === "status") return `**${node.attrs?.text || ""}**`;
    if (node.type !== "text") return inline(node.content);
    let text = node.text || "";
    const marks = node.marks || [];
    if (marks.some((mark: any) => mark.type === "code")) return `\`${text}\``;
    for (const mark of marks) {
      if (mark.type === "strong") text = `**${text}**`;
      else if (mark.type === "em") text = `*${text}*`;
      else if (mark.type === "strike") text = `~~${text}~~`;
    }
    const link = marks.find((mark: any) => mark.type === "link")?.attrs?.href;
    return link ? `[${text}](${link})` : text;
  }).join("");
}

function block(node: any, depth = 0): string {
  const children = (nodes: any[] = [], d = depth) => nodes.map((child) => block(child, d)).join("");
  switch (node.type) {
    case "doc": return children(node.content);
    case "paragraph": return `${inline(node.content)}\n\n`;
    case "heading": return `${"#".repeat(Math.min(6, (node.attrs?.level || 1) + 2))} ${inline(node.content)}\n\n`; // under the issue title
    case "bulletList":
    case "orderedList": {
      const items = (node.content || []).map((item: any, index: number) => {
        const marker = node.type === "orderedList" ? `${index + 1}.` : "-";
        const body = children(item.content, depth + 1).trim().replace(/\n\n+/g, "\n");
        return `${"  ".repeat(depth)}${marker} ${body.replace(/\n(?!\s*(?:[-*]|\d+\.) )/g, `\n${"  ".repeat(depth + 1)}`)}`;
      });
      return `${items.join("\n")}\n\n`;
    }
    case "taskList": return `${(node.content || []).map((item: any) => `- [${item.attrs?.state === "DONE" ? "x" : " "}] ${inline(item.content)}`).join("\n")}\n\n`;
    case "codeBlock": return `\`\`\`${node.attrs?.language || ""}\n${(node.content || []).map((child: any) => child.text || "").join("")}\n\`\`\`\n\n`;
    case "blockquote": return `${children(node.content).trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    case "panel": return `${children(node.content).trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    case "rule": return "---\n\n";
    case "expand": return `**${node.attrs?.title || "Details"}**\n\n${children(node.content)}`;
    case "mediaSingle":
    case "mediaGroup": return "*(attachment)*\n\n";
    case "blockCard":
    case "embedCard": return `${node.attrs?.url || ""}\n\n`;
    case "table": {
      const rows = (node.content || []).map((row: any) => (row.content || []).map((cell: any) => children(cell.content).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|")));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row: string[]) => row.length));
      const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] || "").join(" | ")} |`;
      return `${[line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n")}\n\n`;
    }
    default: return node.content ? children(node.content) : inline([node]);
  }
}

// ---------- issue shape ----------

const person = (value: any): Person | null => value ? { name: value.displayName || "", email: value.emailAddress || "" } : null;
const optionValue = (value: any) => (value && typeof value === "object" ? value.value || value.name || "" : value ? String(value) : "");
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

// The fields the viewer uses, from one `acli jira workitem view --fields *all --json` payload. Custom field ids differ per
// Jira site, so `issues.fields` names them.
export function slimIssue(raw: any): Issue {
  const f = raw.fields || {};
  const custom = config().issues.fields;
  const dev = String(f.customfield_10000 || "");
  const description = adfToMarkdown(f.description);
  const comments = (f.comment?.comments || []).map((comment: any) => ({ id: String(comment.id), author: person(comment.author), created: comment.created || "", body: adfToMarkdown(comment.body) }));
  return {
    key: raw.key, source: "jira", summary: f.summary || "", project: raw.key.split("-")[0], type: f.issuetype?.name || "", level: f.issuetype?.hierarchyLevel ?? 0,
    status: f.status?.name || "", category: f.status?.statusCategory?.key || "new", priority: f.priority?.name || "",
    assignee: person(f.assignee), reporter: person(f.reporter), labels: f.labels || [], components: (f.components || []).map((component: any) => component.name),
    parent: f.parent?.key || (custom.epicLink && f[custom.epicLink]) || "", created: f.created || "", updated: f.updated || "", resolution: f.resolution?.name || "",
    due: f.duedate || "", start: custom.start ? f[custom.start] || "" : "", confidence: custom.confidence ? optionValue(f[custom.confidence]) : "",
    statusUpdate: custom.statusUpdate ? adfToMarkdown(f[custom.statusUpdate]) : "",
    links: (f.issuelinks || []).map((link: any) => {
      const other = link.outwardIssue || link.inwardIssue;
      return { type: link.type?.name || "", label: link.outwardIssue ? link.type?.outward : link.type?.inward, key: other?.key || "", summary: other?.fields?.summary || "", status: other?.fields?.status?.name || "", category: other?.fields?.status?.statusCategory?.key || "new" };
    }).filter((link: Link) => link.key),
    // Jira's development panel only says how many PRs it saw and their state; the URLs come from the text.
    prCount: Number(dev.match(/"count":(\d+)/)?.[1] || 0), prState: dev.match(/"state":"(\w+)"/)?.[1] || "",
    description, comments, attachments: (f.attachment || []).length,
    prUrls: [...new Set([description, ...comments.map((comment: Comment) => comment.body)].join("\n").match(PR_URL) || [])],
  };
}

// What changed between two copies of an issue, as feed rows. Without a changelog the time is the issue's `updated`.
export function diffIssue(before: Issue | undefined, after: Issue): Activity[] {
  const at = after.updated;
  if (!before) return [{ at: after.created, key: after.key, kind: "created", by: after.reporter?.name, text: after.summary }, ...after.comments.map((comment) => ({ at: comment.created, key: after.key, kind: "comment", by: comment.author?.name, text: comment.body.slice(0, 400) }))];
  const rows: Activity[] = [];
  const field = (kind: string, from: string, to: string) => { if (from !== to) rows.push({ at, key: after.key, kind, from, to }); };
  field("status", before.status, after.status);
  field("assignee", before.assignee?.name || "Unassigned", after.assignee?.name || "Unassigned");
  field("priority", before.priority, after.priority);
  field("parent", before.parent, after.parent);
  field("summary", before.summary, after.summary);
  const added = after.labels.filter((label) => !before.labels.includes(label));
  const removed = before.labels.filter((label) => !after.labels.includes(label));
  if (added.length || removed.length) rows.push({ at, key: after.key, kind: "labels", from: removed.join(", "), to: added.join(", ") });
  const known = new Set(before.comments.map((comment) => comment.id));
  for (const comment of after.comments) if (!known.has(comment.id)) rows.push({ at: comment.created, key: after.key, kind: "comment", by: comment.author?.name, text: comment.body.slice(0, 400) });
  return rows;
}

// ---------- joining issues to code ----------

// Old keys an issue carries from a tracker it was imported from, as lowercase labels (`atl-123` for an issue
// migrated from the `ATL` Linear tracker), so code and documents that still say ATL-123 find the new issue.
export function aliasesOf(issue: Issue, prefixes: string[]) {
  if (issue.source === "linear" || issue.source === "github") return [];
  return issue.labels.map((label) => label.toUpperCase()).filter((label) => prefixes.some((prefix) => label.startsWith(`${prefix}-`)) && /^[A-Z][A-Z0-9]*-\d+$/.test(label));
}

// Issue keys a PR's title or branch mentions (branches are lowercase: `alex/atl-123-fix`): the Jira issue of that key,
// the Jira issue it was imported into, and the Linear issue of that identifier.
export function keysIn(text: string, issues: Map<string, unknown>, aliases: Map<string, string>) {
  const found = new Set<string>();
  for (const [token] of text.toUpperCase().matchAll(/(?<![A-Z0-9])[A-Z][A-Z0-9]*-\d+(?!\d)/g)) {
    for (const key of [aliases.get(token), token, `linear:${token}`]) if (key && issues.has(key)) found.add(key);
  }
  return [...found];
}

// The same work in both trackers. `a` is the copy and `b` the original: a Linear issue synced from Jira ("mirror"), a Jira
// issue imported from Linear ("import"), or, without either marker, two open items with the same title ("title"; for
// a Linear project and a Jira epic too).
export type Pair = { a: string; b: string; kind: "mirror" | "import" | "title" };
const normalTitle = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function pairIssues(issues: Issue[], prefixes: string[]): Pair[] {
  const pairs: Pair[] = [];
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const linked = new Set<string>();
  const add = (a: string, b: string, kind: Pair["kind"]) => { pairs.push({ a, b, kind }); linked.add(a); linked.add(b); };
  for (const issue of issues) {
    if (issue.source === "linear" && issue.mirrorOf && byKey.has(issue.mirrorOf)) add(issue.key, issue.mirrorOf, "mirror");
    for (const alias of aliasesOf(issue, prefixes)) if (byKey.has(`linear:${alias}`)) add(issue.key, `linear:${alias}`, "import");
  }
  // ponytail: exact match on the normalized title; token overlap if real duplicates turn out to be reworded
  const jiraByTitle = new Map<string, Issue[]>();
  for (const issue of issues) if (issue.source !== "linear" && issue.source !== "github" && issue.category !== "done") {
    const title = normalTitle(issue.summary);
    if (title.length >= 12) jiraByTitle.set(title, [...(jiraByTitle.get(title) || []), issue]);
  }
  for (const issue of issues) {
    if (issue.source !== "linear" || issue.mirrorOf || linked.has(issue.key) || issue.category === "done") continue;
    const match = (jiraByTitle.get(normalTitle(issue.summary)) || []).find((candidate) => !linked.has(candidate.key) && (candidate.level >= 1) === (issue.level >= 1));
    if (match) add(issue.key, match.key, "title");
  }
  return pairs;
}

// Connected pairs as groups: MOD-1 imported as RAI-2 and synced back as MOD-3 is one group of three.
export function clustersOf(pairs: Pair[]) {
  const parent = new Map<string, string>();
  const find = (key: string): string => { const up = parent.get(key) || key; if (up === key) return key; const root = find(up); parent.set(key, root); return root; };
  for (const { a, b } of pairs) { parent.set(find(a), find(b)); }
  const groups = new Map<string, string[]>();
  for (const key of new Set(pairs.flatMap(({ a, b }) => [a, b]))) groups.set(find(key), [...(groups.get(find(key)) || []), key]);
  return [...groups.values()];
}

// ---------- the store ----------

type Runner = (args: string[]) => Promise<string>;

export function createIssueTracker(root: string, codeIndex: () => Promise<{ prs: any[]; worktrees: { repo: string; path: string; branch: string }[] }>, repoSlugs: () => Promise<string[]> = async () => []) {
  const cachePath = join(root, "tmp", "issues-cache.json");
  let cache: Cache = { at: 0, fullAt: 0, scope: [], issues: {}, activity: [], me: "", site: "", linearAt: 0, linearFullAt: 0, githubAt: 0, githubMe: "" };
  try { cache = { ...cache, ...JSON.parse(readFileSync(cachePath, "utf8")) }; } catch {}
  let sync: Promise<void> | null = null;
  let error = "";
  let progress = "";

  const settings = () => config().issues;
  const linearTeams = () => settings().linear?.teams || [];
  const enabled = () => Boolean(settings().jql || linearTeams().length || settings().github);
  const linear = linearClient(root);
  const acli: Runner = async (args) => {
    const [command, ...rest] = settings().command;
    return (await exec(command, [...rest, ...args], { cwd: root, maxBuffer: 64 << 20 })).stdout;
  };
  // Paginated search prints one JSON array per page; join them. Asking for `key` alone returns nulls, so ask for status.
  const search = async (jql: string) => {
    const out = await acli(["jira", "workitem", "search", "--jql", jql, "--fields", "status", "--paginate", "--json"]);
    return out.trim() ? (JSON.parse(`[${out.trim().replace(/\]\s*\[/g, "],[")}]`).flat() as ({ key: string } | null)[]).flatMap((item) => (item?.key ? [item.key] : [])) : [];
  };
  const view = async (key: string) => slimIssue(JSON.parse(await acli(["jira", "workitem", "view", key, "--fields", "*all", "--json"])));

  async function viewAll(keys: string[]) {
    const queue = [...keys];
    const out: Issue[] = [];
    let done = 0;
    await Promise.all(Array.from({ length: VIEW_CONCURRENCY }, async () => {
      for (let key = queue.shift(); key; key = queue.shift()) {
        try { out.push(await view(key)); } catch {} // a key deleted since the search just drops out
        progress = `Reading issues ${++done} of ${keys.length}`;
      }
    }));
    return out;
  }

  function store(issues: Issue[]) {
    const rows: Activity[] = [];
    for (const issue of issues) {
      const before = cache.issues[issue.key];
      // An unchanged issue has no activity, but still takes the fresh copy so fields added to the reader fill in.
      if (!before || before.updated !== issue.updated) rows.push(...diffIssue(before, issue));
      cache.issues[issue.key] = issue;
    }
    // The first sync backfills creations and comments; later ones also carry field changes.
    cache.activity = [...rows, ...cache.activity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_LIMIT);
  }

  // Context: parents of in-scope issues (often under other components) and every child of an in-scope epic or initiative.
  async function loadContext() {
    const scope = new Set(cache.scope);
    const containers = cache.scope.filter((key) => (cache.issues[key]?.level || 0) >= 1);
    const children = containers.length ? await search(`parent in (${containers.join(",")})`) : [];
    const wanted = new Set(children);
    for (let pass = 0; pass < 3; pass++) { // up to initiative level
      const parents = Object.values(cache.issues).filter((issue) => issue.source === "jira").map((issue) => issue.parent).filter((key) => key && !cache.issues[key]);
      if (!parents.length) break;
      store(await viewAll([...new Set(parents)]));
    }
    store(await viewAll([...wanted].filter((key) => !cache.issues[key] && !scope.has(key))));
  }

  // Linear answers a whole team in under a minute, so a full read runs hourly and on R; between them only issues updated
  // since the last read. A full read also drops issues that were deleted or archived.
  async function runLinear(force: boolean) {
    const started = Date.now();
    const full = force || !cache.linearFullAt || started - cache.linearFullAt > FULL_SCAN_MS;
    const since = full ? "" : new Date(cache.linearAt - 2 * 60_000).toISOString();
    const { issues, projects } = await fetchLinear(linear, linearTeams(), since, (text) => { progress = text; });
    if (full) {
      const current = new Set([...issues, ...projects].map((issue) => issue.key));
      for (const key of Object.keys(cache.issues)) if (cache.issues[key].source === "linear" && !current.has(key)) delete cache.issues[key];
      cache.linearFullAt = started;
    }
    store([...projects, ...issues]);
    cache.linearAt = started;
  }

  // GitHub issues in the tracked repositories are few, so every read is a full one that replaces the previous copy.
  async function runGithub() {
    const started = Date.now();
    cache.githubMe ||= await githubLogin();
    const issues = await fetchGithub(await repoSlugs(), (text) => { progress = text; });
    const current = new Set(issues.map((issue) => issue.key));
    for (const key of Object.keys(cache.issues)) if (cache.issues[key].source === "github" && !current.has(key)) delete cache.issues[key];
    store(issues);
    cache.githubAt = started;
  }

  async function run(force: boolean) {
    if (settings().github) await runGithub();
    if (linearTeams().length) await runLinear(force);
    if (settings().jql) await runJira(force);
    progress = "";
    await mkdir(join(root, "tmp"), { recursive: true });
    await writeFile(cachePath, JSON.stringify(cache));
  }

  async function runJira(force: boolean) {
    const jql = settings().jql;
    if (!cache.me || !cache.site) {
      const status = await acli(["jira", "auth", "status"]).catch(() => "");
      cache.me = status.match(/Email:\s*(\S+)/)?.[1] || cache.me;
      cache.site = status.match(/Site:\s*(\S+)/)?.[1] || cache.site;
    }
    const started = Date.now();
    const full = force || !cache.fullAt || started - cache.fullAt > FULL_SCAN_MS;
    if (full) {
      progress = "Listing issues";
      cache.scope = await search(jql);
      const missing = cache.scope.filter((key) => !cache.issues[key]);
      store(await viewAll(force ? cache.scope : missing));
      cache.fullAt = started;
    }
    // Everything touched since the last sync, in scope or under an in-scope epic, with two minutes of overlap for clock drift.
    // Context parents outside both refresh on the hourly full scan.
    if (cache.at) {
      const since = `updated >= -${Math.ceil((started - cache.at) / 60_000) + 2}m`;
      const containers = cache.scope.filter((key) => (cache.issues[key]?.level || 0) >= 1);
      const [inScope, children] = await Promise.all([search(`${since} AND (${jql})`), containers.length ? search(`${since} AND parent in (${containers.join(",")})`) : []]);
      cache.scope = [...new Set([...cache.scope, ...inScope])];
      store(await viewAll([...new Set([...inScope, ...children])]));
    }
    if (full) await loadContext();
    cache.at = started;
  }

  function refresh(force = false) {
    if (!enabled()) return Promise.resolve();
    sync ||= run(force).then(() => { error = ""; }, (failure) => { error = String(failure.message || failure).split("\n")[0]; progress = ""; }).finally(() => { sync = null; });
    return sync;
  }

  function startBackgroundRefresh() {
    if (!enabled()) return;
    refresh().catch(() => {});
    setInterval(() => refresh().catch(() => {}), settings().refreshMinutes * 60_000).unref();
  }

  // Aliases from imported issues and the PRs and worktrees that mention each key.
  async function joins() {
    const prefixes = config().trackers.map((tracker: { prefix: string }) => tracker.prefix);
    const issues = new Map(Object.entries(cache.issues));
    const aliases = new Map<string, string>();
    for (const issue of issues.values()) for (const alias of aliasesOf(issue, prefixes)) aliases.set(alias, issue.key);
    const code: Record<string, { prs: any[]; worktrees: any[] }> = {};
    const add = (key: string, kind: "prs" | "worktrees", item: any) => {
      const entry = (code[key] ||= { prs: [], worktrees: [] });
      if (!entry[kind].some((existing) => existing.url ? existing.url === item.url : existing.path === item.path)) entry[kind].push(item);
    };
    const { prs, worktrees } = await codeIndex().catch(() => ({ prs: [], worktrees: [] }));
    const byUrl = new Map(prs.map((pr) => [pr.url, pr]));
    const prSummary = (pr: any) => ({ slug: pr.slug, number: pr.number, title: pr.title, url: pr.url, state: pr.state || "OPEN", draft: pr.draft, ci: pr.ci, branch: pr.branch, author: pr.author });
    for (const pr of prs) for (const key of keysIn(`${pr.title} ${pr.branch}`, issues, aliases)) add(key, "prs", prSummary(pr));
    for (const issue of issues.values()) for (const url of issue.prUrls) {
      const [, slug, number] = url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/) || [];
      add(issue.key, "prs", byUrl.has(url) ? prSummary(byUrl.get(url)) : { slug, number: Number(number), title: "", url, state: "" });
    }
    for (const tree of worktrees) for (const key of keysIn(tree.branch, issues, aliases)) add(key, "worktrees", { path: tree.path, branch: tree.branch, repo: tree.repo });
    const pairs = pairIssues([...issues.values()], prefixes);
    return { aliases: Object.fromEntries(aliases), code, pairs, clusters: clustersOf(pairs) };
  }

  // The list payload: every issue without its long text, which the detail call returns.
  async function load(force = false) {
    if (!enabled()) return { enabled: false };
    if (force) refresh(true).catch(() => {});
    else if (Date.now() - Math.max(cache.at, cache.linearAt, cache.githubAt) > settings().refreshMinutes * 60_000) refresh().catch(() => {});
    const { aliases, code, pairs, clusters } = await joins();
    const scope = new Set(cache.scope);
    const hidden = new Set(settings().hideLabels);
    // One name per person: Linear shows some accounts by handle, Jira by full name, both by the same email.
    const names = new Map<string, string>();
    for (const issue of Object.values(cache.issues)) if (issue.source === "jira") for (const who of [issue.assignee, issue.reporter]) if (who?.email && who.name) names.set(who.email, who.name);
    const named = (who: Person | null) => (who && names.has(who.email) ? { ...who, name: names.get(who.email)! } : who);
    const issues = Object.values(cache.issues).map(({ description, comments, statusUpdate, milestones, resources, ...issue }) => ({
      ...issue, assignee: named(issue.assignee), reporter: named(issue.reporter), inScope: issue.source !== "jira" || scope.has(issue.key), bot: issue.labels.some((label) => hidden.has(label)), comments: comments.length,
      lastComment: comments.at(-1) ? { by: comments.at(-1)!.author?.name || "", at: comments.at(-1)!.created } : null, hasUpdate: Boolean(statusUpdate),
    }));
    return {
      enabled: true, site: cache.site, me: cache.me, githubMe: cache.githubMe, syncedAt: Math.max(cache.at, cache.linearAt, cache.githubAt), syncing: Boolean(sync), progress, error, issues, aliases, code, pairs, clusters,
      sources: [...(settings().jql ? ["jira"] : []), ...(linearTeams().length ? ["linear"] : []), ...(settings().github ? ["github"] : [])],
      activity: cache.activity, skills: issueSkills(), triage: settings().triage,
    };
  }

  function detail(key: string) {
    const issue = cache.issues[key];
    if (!issue) throw new Error(`Unknown issue ${key}.`);
    return issue;
  }

  const issueUrl = (issue: Issue) => issue.url || `https://${cache.site}/browse/${issue.key}`;
  const name = (issue: Issue) => issue.source === "linear" ? `Linear ${issue.type === "Project" ? "project" : issue.label}` : issue.source === "github" ? `GitHub ${issue.label}` : issue.key;
  const ROLE = { mirror: ["synced into Linear as", "a Linear copy of"], import: ["imported into Jira from", "imported into Jira as"], title: ["same title as", "same title as"] };
  function context(issue: Issue, code: Record<string, { prs: any[] }>, pairs: Pair[]) {
    const parent = cache.issues[issue.parent];
    const prs = code[issue.key]?.prs || [];
    const counterparts = pairs.flatMap((pair) => pair.a === issue.key ? [[ROLE[pair.kind][1], pair.b]] : pair.b === issue.key ? [[ROLE[pair.kind][0], pair.a]] : [])
      .map(([role, key]) => cache.issues[key] ? `${role} ${name(cache.issues[key])} (${cache.issues[key].status}, ${issueUrl(cache.issues[key])})` : "");
    return [
      `- ${name(issue)}: ${issue.summary} (${issueUrl(issue)})`,
      `  - ${issue.type} · ${issue.status} · ${issue.priority || "no priority"} · ${issue.assignee?.name || "unassigned"}`,
      parent ? `  - Parent: ${name(parent)} ${parent.summary}` : "",
      prs.length ? `  - Pull requests: ${prs.map((pr) => pr.url).join(", ")}` : "",
      ...counterparts.filter(Boolean).map((text) => `  - Also ${text}`),
    ].filter(Boolean).join("\n");
  }

  // One editable draft for one or more issues: the configured skill's instruction, then each issue as bullets.
  async function launchAgent(app: string, skill: string, keys: string[]) {
    const chosen = issueSkills().find((candidate) => candidate.id === skill);
    if (!chosen) throw new Error("Unknown skill.");
    const issues = keys.map(detail);
    if (!issues.length) throw new Error("No issues selected.");
    const { code, pairs } = await joins();
    const list = issues.map((issue) => context(issue, code, pairs)).join("\n");
    const reading = [issues.some((issue) => issue.source === "jira") && "Jira issues with `acli jira workitem view <KEY> --json`", issues.some((issue) => issue.source === "linear") && "Linear issues with the Linear MCP", issues.some((issue) => issue.source === "github") && "GitHub issues with `gh issue view <URL> --comments`"].filter(Boolean).join(" and ");
    const noun = issues.length === 1 ? "this issue" : "these issues";
    const draft = chosen.id === "discuss"
      ? `Let's talk through ${noun}. Read ${reading} first, then \n\n${list}\n`
      : `${chosen.prompt}\n\n${list}\n\nRead ${reading} in full first. Don't change anything in the issue tracker until I say which way to go.`;
    const folder = (settings().workspace || root).replace(/^~(?=\/)/, process.env.HOME || "~");
    const url = app === "claude" ? claudeNewSessionUrl(folder, draft) : codexNewTaskUrl(draft, folder);
    await exec("/usr/bin/open", [url]);
  }

  // Document links to an issue's old key (`linear:ATL-123`) show the issue it became; Jira links answer from the cache.
  function aliasMetadata(keys: string[]) {
    const prefixes = config().trackers.map((tracker: { prefix: string }) => tracker.prefix);
    const aliases = new Map<string, Issue>();
    for (const issue of Object.values(cache.issues)) for (const alias of aliasesOf(issue, prefixes)) aliases.set(alias, issue);
    const tones: Record<string, string> = { done: "done", indeterminate: "progress", new: "open" };
    const out: Record<string, { title: string; state: string; tone: string; person?: string; fetchedAt: number }> = {};
    for (const key of keys) {
      const [service, id] = key.split(":");
      const issue = service === "jira" ? cache.issues[id] : aliases.get(id);
      if (issue && issue.source === "jira") out[key] = { title: issue.summary, state: service === "jira" ? issue.status : `${issue.status} · now ${issue.key}`, tone: tones[issue.category] || "open", person: issue.assignee?.name, fetchedAt: cache.at };
    }
    return out;
  }

  return { load, detail, refresh, startBackgroundRefresh, launchAgent, aliasMetadata };
}

// The configured issue skills, then an open "Discuss" prompt.
export const issueSkills = () => [...config().issues.skills, { id: "discuss", label: "Discuss", icon: "comment", prompt: "" }];
