import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeNewSessionUrl as claudeUrl, codexNewTaskUrl } from "./codex-desktop.ts";
import { config } from "./public/config.js";

// Plans: the initiatives (`initiative-map.json` plus the briefs beside it) on each tracked repo's origin/main, read
// straight from git so the hundreds of worktree copies never matter, plus the open PRs that touch or propose them.
// Read-only; changes go through agent drafts. docs/plans-plan.md has the reasoning.

const exec = promisify(execFile);
const MAP_FILE = "initiative-map.json";
const SKIPPED = new Set(["node_modules", "dist", "build", "vendor"]);
const PR_TTL_MS = 2 * 60_000;
const CACHE_VERSION = 2; // bump when what a scan extracts from a map changes, so cached scans are redone
const MAX_DOC_BYTES = 2_000_000;
const DONE = new Set(["closed", "done", "complete", "completed"]);
const STARTED = new Set(["in_progress", "in-progress", "started", "partially_implemented", "partial", "active"]);
export const LIFECYCLE = ["planned", "active", "paused", "completed", "cancelled"];
export const PHASES = ["intent", "brainstorm", "shape", "plan", "execution", "reconciliation"];
const ARTIFACT_LABELS: Record<string, string> = { intent_brief: "Intent", brainstorm: "Brainstorm", shape_brief: "Shape", implementation_plan: "Plan" };

type Doc = { path: string; name: string; label: string; role: string; status: string };
type PrTouch = { number: number; title: string; url: string; draft: boolean; author: string; branch: string; updatedAt: string; change: "edits" | "retires" | "proposes"; files: string[] };
export type Initiative = {
  id: string; repo: string; folder: string; ref: string; source: "main" | "pr";
  slug: string; title: string; summary: string; status: string; inferred: boolean; evidence: string; phase: string; scale: string;
  nextAction: string; lastUpdated: string; dependsOn: string[]; related: string[]; history: { date: string; event: string; reason: string }[]; historyCount: number;
  docs: Doc[]; edited: number; error?: string; prs: PrTouch[];
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const hidden = (path: string) => path.split("/").some((part) => part.startsWith(".") || SKIPPED.has(part));
export const folderOf = (mapPath: string) => (mapPath === MAP_FILE ? "" : mapPath.slice(0, -MAP_FILE.length - 1));
const inFolder = (folder: string, path: string) => !folder || path.startsWith(`${folder}/`);

// Every initiative map in a tree listing, skipping hidden, dependency, build and vendor folders.
export const mapPaths = (files: string[]) => files.filter((path) => (path === MAP_FILE || path.endsWith(`/${MAP_FILE}`)) && !hidden(path));

// The Markdown files that belong to one initiative: its folder, minus folders that hold their own initiative.
export function folderDocs(folder: string, files: string[], folders: string[], artifacts: unknown): Doc[] {
  const nested = folders.filter((other) => other !== folder && inFolder(folder, other));
  const found = files.filter((path) => path.toLowerCase().endsWith(".md") && inFolder(folder, path) && !hidden(path.slice(folder.length)) && !nested.some((other) => inFolder(other, path)));
  const roles = new Map<string, [string, any]>();
  for (const [key, value] of Object.entries(artifacts && typeof artifacts === "object" ? artifacts : {})) {
    const target = text((value as any)?.path);
    if (!target.toLowerCase().endsWith(".md")) continue;
    const path = [folder ? `${folder}/${target}` : target, target].find((candidate) => files.includes(candidate));
    if (path && !roles.has(path)) roles.set(path, [key, value]);
  }
  for (const path of roles.keys()) if (!found.includes(path)) found.push(path);
  const order = [...Object.keys(ARTIFACT_LABELS), ...[...roles.values()].map(([key]) => key)];
  const rank = (path: string) => (roles.has(path) ? order.indexOf(roles.get(path)![0]) : order.length);
  found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return found.map((path) => {
    const [role, artifact] = roles.get(path) || ["", {}];
    const name = inFolder(folder, path) ? path.slice(folder ? folder.length + 1 : 0) : path;
    const label = ARTIFACT_LABELS[role] || (role || name.replace(/\.md$/i, "")).replace(/[_-]/g, " ").replace(/\//g, " / ");
    return { path, name, label: label[0].toUpperCase() + label.slice(1), role, status: text(artifact?.status) };
  });
}

// Lifecycle status from the map, else inferred from recorded milestone and execution states (no tickets here).
export function statusOf(map: any): { status: string; inferred: boolean; evidence: string } {
  const recorded = text(map?.initiative?.status).toLowerCase();
  if (LIFECYCLE.includes(recorded)) return { status: recorded, inferred: false, evidence: "" };
  const implementation = map?.implementation && typeof map.implementation === "object" ? map.implementation : {};
  const milestones = list(implementation.milestones).map((item: any) => text(item?.status).toLowerCase());
  const states = [text(implementation.execution_status), text(implementation.status)].map((state) => state.toLowerCase());
  if (states.some((state) => DONE.has(state)) || (milestones.length && milestones.every((state) => DONE.has(state)))) return { status: "completed", inferred: true, evidence: "Completion recorded in the map." };
  if (states.some((state) => STARTED.has(state)) || milestones.some((state) => DONE.has(state) || STARTED.has(state))) return { status: "active", inferred: true, evidence: "Work recorded in the map." };
  return { status: "planned", inferred: true, evidence: "The map records no status and no started work." };
}

// Maps name a history entry's headline "event", "action" or "change", and its detail "reason", "summary" or "notes".
export const historyEntry = (entry: any) => {
  const event = text(entry?.event) || text(entry?.action) || text(entry?.change);
  return { date: text(entry?.date), event, reason: text(entry?.reason) || [entry?.summary, entry?.notes].map(text).find((value) => value && value !== event) || "" };
};

// One initiative from its map's JSON text; a map that doesn't parse becomes an error row, not a missing one.
export function initiativeFrom(repo: string, mapPath: string, source: string | null, ref: string, files: string[], folders: string[]): Initiative {
  const folder = folderOf(mapPath);
  const base = { id: `${repo}:${folder || "."}`, repo, folder, ref, source: "main" as const, slug: folder.split("/").pop() || repo.split("/").pop() || "", summary: "", phase: "", scale: "", nextAction: "", lastUpdated: "", dependsOn: [], related: [], history: [], historyCount: 0, edited: 0, prs: [], evidence: "", inferred: false };
  let map: any;
  try {
    map = JSON.parse(source ?? "");
    if (!map?.initiative || !text(map.initiative.title)) throw new Error("Expected initiative.title");
  } catch (error) {
    return { ...base, title: base.slug, status: "invalid", docs: folderDocs(folder, files, folders, null), error: `${mapPath}: ${(error as Error).message}` };
  }
  const info = map.initiative;
  const history = list(map.history).filter((entry: any) => entry && typeof entry === "object");
  const relatedValue = map.related_initiatives;
  const related = list(relatedValue).map((item: any) => text(typeof item === "string" ? item : item?.slug)).filter(Boolean);
  return {
    ...base, ...statusOf(map),
    slug: text(info.slug) || base.slug, title: text(info.title), summary: text(info.summary), phase: text(info.current_phase), scale: text(info.scale),
    nextAction: text(info.next_action), lastUpdated: text(info.last_updated),
    dependsOn: list(info.depends_on).map(text).filter(Boolean), related,
    history: history.slice(-3).reverse().map(historyEntry), historyCount: history.length,
    docs: folderDocs(folder, files, folders, map.artifacts),
  };
}

// `git log --name-only` output (each commit as "\0<unix time>" then its paths) to the newest commit time per path.
export function newestTimes(log: string) {
  const times = new Map<string, number>();
  let time = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith("\0")) time = Number(line.slice(1)) * 1000;
    else if (line && !times.has(line)) times.set(line, time);
  }
  return times;
}

// Which initiatives an open PR's changed files touch, and the maps it adds.
export function prTouches(pr: { files: { path: string; changeType: string }[] }, folders: string[]) {
  const touched = new Map<string, { change: "edits" | "retires"; files: string[] }>();
  const added: string[] = [];
  for (const file of pr.files) {
    if (hidden(file.path)) continue;
    const owner = folders.filter((folder) => inFolder(folder, file.path)).sort((a, b) => b.length - a.length)[0];
    if (owner !== undefined) {
      const entry = touched.get(owner) || touched.set(owner, { change: "edits", files: [] }).get(owner)!;
      entry.files.push(file.path);
      if (file.changeType === "DELETED" && file.path === (owner ? `${owner}/${MAP_FILE}` : MAP_FILE)) entry.change = "retires";
    } else if (file.changeType === "ADDED" && mapPaths([file.path]).length) added.push(file.path);
  }
  return { touched, added };
}

const cleanPath = (path: string) => {
  if (!path || path.includes("\0") || path.startsWith("/") || path.split("/").some((part) => part === ".." || part.startsWith("."))) throw new Error("Bad path.");
  return path;
};

export function createPlans(root: string, deps: { repos: () => Promise<string[]>; slug: (repo: string) => Promise<string> }) {
  const cachePath = join(root, "tmp", "plans-cache.json");
  // Per repo: the scanned commit and what it held. Per GitHub slug: open PRs with their files. Per "<oid>:<path>": a proposed map.
  let cache: { version?: number; repos: Record<string, { sha: string; base: string; files: string[]; initiatives: Initiative[] }>; prs: Record<string, { at: number; prs: any[] }>; proposed: Record<string, string | null> } = { repos: {}, prs: {}, proposed: {} };
  try {
    const saved = JSON.parse(readFileSync(cachePath, "utf8"));
    cache = { ...cache, ...saved, repos: saved.version === CACHE_VERSION ? saved.repos || {} : {} };
  } catch {}
  cache.version = CACHE_VERSION;
  const loading = new Map<string, Promise<void>>();
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      await mkdir(join(root, "tmp"), { recursive: true }).catch(() => {});
      await writeFile(cachePath, JSON.stringify(cache)).catch(() => {});
    }, 500);
  };
  const git = async (cwd: string, args: string[]) => (await exec("git", ["-C", cwd, ...args], { maxBuffer: 64 << 20 })).stdout;

  // Many blobs in one process: `git cat-file --batch` answers "<sha> blob <size>\n<bytes>\n" or "<spec> missing".
  function catFiles(repo: string, specs: string[]) {
    return new Promise<Map<string, string | null>>((resolve, reject) => {
      const out = new Map<string, string | null>();
      if (!specs.length) return resolve(out);
      const child = spawn("git", ["-C", repo, "cat-file", "--batch"]);
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.on("error", reject);
      child.on("close", () => {
        const buffer = Buffer.concat(chunks);
        let at = 0;
        for (const spec of specs) {
          const end = buffer.indexOf(10, at);
          if (end < 0) break;
          const header = buffer.subarray(at, end).toString();
          at = end + 1;
          const size = Number(header.match(/^\S+ \S+ (\d+)$/)?.[1]);
          if (!header.includes(" missing") && Number.isFinite(size)) { out.set(spec, buffer.subarray(at, at + size).toString("utf8")); at += size + 1; }
          else out.set(spec, null);
        }
        resolve(out);
      });
      child.stdin.end(specs.map((spec) => `${spec}\n`).join(""));
    });
  }

  // The remote default branch, else origin/main, else a local main.
  async function baseRef(repo: string) {
    for (const ref of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"]) {
      const sha = (await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "")).trim();
      if (sha) {
        const name = ref === "refs/remotes/origin/HEAD" ? (await git(repo, ["symbolic-ref", "--short", ref]).catch(() => "origin/HEAD")).trim() : ref.replace(/^refs\/(remotes|heads)\//, "");
        return { sha, base: name };
      }
    }
    throw new Error("No origin/main or main branch.");
  }

  async function fetchedAt(repo: string) {
    const common = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")).trim();
    return common ? await stat(join(common, "FETCH_HEAD")).then((info) => info.mtimeMs, () => 0) : 0;
  }

  async function scanRepo(repo: string) {
    const { sha, base } = await baseRef(repo);
    const hit = cache.repos[repo];
    if (hit?.sha === sha) return hit;
    const files = (await git(repo, ["ls-tree", "-r", "-z", "--name-only", sha])).split("\0").filter(Boolean);
    const maps = mapPaths(files);
    const folders = maps.map(folderOf);
    const sources = await catFiles(repo, maps.map((path) => `${sha}:${path}`));
    const initiatives = maps.map((path) => initiativeFrom(repo, path, sources.get(`${sha}:${path}`) ?? null, sha, files, folders));
    if (maps.length) {
      const times = newestTimes(await git(repo, ["log", "--format=%x00%ct", "--name-only", sha, "--", ...folders.map((folder) => folder || ".")]).catch(() => ""));
      for (const item of initiatives) item.edited = Math.max(0, ...[...times].filter(([path]) => inFolder(item.folder, path)).map(([, time]) => time));
    }
    cache.repos[repo] = { sha, base, files: files.filter((path) => path.toLowerCase().endsWith(".md") || mapPaths([path]).length), initiatives };
    persist();
    return cache.repos[repo];
  }

  // Open PRs with their changed files, 25 a page; GraphQL caps files at 100 per PR, enough to find initiative folders.
  async function loadPrs(slug: string) {
    const [owner, name] = slug.split("/");
    const query = `query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:25,after:$endCursor,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{number title url isDraft headRefName headRefOid updatedAt author{login} files(first:100){nodes{path changeType}}}}}}`;
    const { stdout } = await exec("gh", ["api", "graphql", "--paginate", "-F", `owner=${owner}`, "-F", `name=${name}`, "-f", `query=${query}`], { maxBuffer: 64 << 20 });
    const prs: any[] = [];
    for (const page of stdout.replace(/}\s*{"data"/g, '}\n{"data"').split("\n").filter(Boolean)) {
      for (const pr of JSON.parse(page).data.repository.pullRequests.nodes) {
        prs.push({ number: pr.number, title: pr.title, url: pr.url, draft: pr.isDraft, branch: pr.headRefName, head: pr.headRefOid, updatedAt: pr.updatedAt, author: pr.author?.login || "", files: (pr.files?.nodes || []).map((file: any) => ({ path: file.path, changeType: file.changeType })) });
      }
    }
    cache.prs[slug] = { at: Date.now(), prs };
    persist();
  }

  function refreshPrs(slug: string, force = false) {
    if (!slug || loading.has(slug) || (!force && Date.now() - (cache.prs[slug]?.at || 0) < PR_TTL_MS)) return;
    loading.set(slug, loadPrs(slug).catch(() => {}).finally(() => loading.delete(slug)));
  }

  // A proposed map's text at the PR head: from the local object store when the branch is here, else GitHub.
  async function readAt(repo: string, slug: string, oid: string, path: string) {
    const local = (await catFiles(repo, [`${oid}:${path}`]).catch(() => new Map())).get(`${oid}:${path}`);
    if (typeof local === "string") return local;
    const { stdout } = await exec("gh", ["api", `repos/${slug}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${oid}`, "-H", "Accept: application/vnd.github.raw"], { maxBuffer: 16 << 20 });
    return stdout;
  }

  async function proposedMap(repo: string, slug: string, oid: string, path: string) {
    const key = `${oid}:${path}`;
    if (!(key in cache.proposed)) { cache.proposed[key] = await readAt(repo, slug, oid, path).catch(() => null); persist(); }
    return cache.proposed[key];
  }

  async function load(force = false) {
    const repos = await deps.repos();
    const errors: string[] = [];
    const results = await Promise.all(repos.map(async (repo) => {
      try {
        const slug = await deps.slug(repo);
        const [scan, fetched] = await Promise.all([scanRepo(repo), fetchedAt(repo)]);
        refreshPrs(slug, force);
        return { repo, slug, scan, fetched };
      } catch (error) {
        errors.push(`${repo}: ${(error as Error).message.split("\n")[0]}`);
        return null;
      }
    }));
    const initiatives: Initiative[] = [];
    const repoInfo = [];
    for (const result of results) {
      if (!result) continue;
      const { repo, slug, scan, fetched } = result;
      repoInfo.push({ repo, slug, sha: scan.sha, base: scan.base, fetchedAt: fetched, count: scan.initiatives.length });
      const own = scan.initiatives.map((item) => ({ ...item, prs: [] as PrTouch[] }));
      const byFolder = new Map(own.map((item) => [item.folder, item]));
      for (const pr of cache.prs[slug]?.prs || []) {
        const { touched, added } = prTouches(pr, [...byFolder.keys()]);
        const touch = (change: PrTouch["change"], files: string[]): PrTouch => ({ number: pr.number, title: pr.title, url: pr.url, draft: pr.draft, author: pr.author, branch: pr.branch, updatedAt: pr.updatedAt, change, files });
        for (const [folder, entry] of touched) byFolder.get(folder)?.prs.push(touch(entry.change, entry.files));
        for (const path of added) {
          const files = pr.files.map((file: any) => file.path);
          const folders = mapPaths(files).map(folderOf);
          const item = initiativeFrom(repo, path, await proposedMap(repo, slug, pr.head, path), pr.head, files, folders);
          own.push({ ...item, id: `${repo}:${item.folder || "."}#${pr.number}`, source: "pr", edited: Date.parse(pr.updatedAt) || 0, prs: [touch("proposes", files.filter((file: string) => inFolder(item.folder, file)))] });
        }
      }
      initiatives.push(...own);
    }
    initiatives.sort((a, b) => b.edited - a.edited);
    return { repos: repoInfo, initiatives, skill: config().code.planSkill, errors, scanning: loading.size > 0 };
  }

  const tracked = async (repo: string) => {
    if (!(await deps.repos()).includes(repo)) throw new Error("Not a tracked repository.");
    return repo;
  };

  // A Markdown file at a commit the view has seen: the repo's scanned main, or an open PR's head.
  async function doc(repo: string, ref: string, path: string) {
    await tracked(repo);
    cleanPath(path);
    if (!path.toLowerCase().endsWith(".md") && !mapPaths([path]).length) throw new Error("Only Markdown files and initiative maps can be read.");
    const slug = await deps.slug(repo);
    const pr = (cache.prs[slug]?.prs || []).find((candidate) => candidate.head === ref);
    if (cache.repos[repo]?.sha !== ref && !pr) throw new Error("Unknown commit.");
    const body = pr ? await readAt(repo, slug, ref, path) : (await catFiles(repo, [`${ref}:${path}`])).get(`${ref}:${path}`);
    if (typeof body !== "string") throw new Error(`${path} isn't in that commit.`);
    if (body.length > MAX_DOC_BYTES) throw new Error(`${path} is too large to show.`);
    return { repo, ref, path, body };
  }

  // The prompt names the skill (`code.planSkill`), the initiative's files, and where it lives, and ends with a "---"
  // line for the user's own words. The draft opens in the repo's main checkout, which may sit on another branch.
  async function prompt(app: string, id: string, kind: string, open: string) {
    const item = (await load()).initiatives.find((candidate) => candidate.id === id);
    if (!item) throw new Error("Unknown initiative.");
    const skill = config().code.planSkill;
    const use = skill ? (app === "claude" ? `Use /${skill} to ` : `Use the ${skill} skill to `) : "";
    const proposal = item.prs.find((pr) => pr.change === "proposes");
    const where = proposal
      ? `It is proposed in ${proposal.url} (branch ${proposal.branch}) and isn't on main yet; work on that branch.`
      : `It is on ${cache.repos[item.repo]?.base || "origin/main"}; the checkout at ${item.repo} may be on another branch, so start from origin/main and open a PR.`;
    const files = [`- Folder: ${join(item.repo, item.folder)}`, `- Map: ${join(item.repo, item.folder, MAP_FILE)}`, ...(open ? [`- Open document: ${join(item.repo, open)}`] : []), ...item.prs.filter((pr) => pr !== proposal).map((pr) => `- Open PR touching it: ${pr.url} (${pr.branch})`)];
    const ask = kind === "retire"
      ? `${use ? use : "Please "}retire the initiative "${item.title}" in ${item.repo}. It is ${item.status}, and I approve retiring it: reconcile the code with its intent, move anything durable into the repository's docs, and remove the planning artifacts.`
      : `${use ? use : "Please "}update the initiative "${item.title}" in ${item.repo}.`;
    const draft = `${ask} ${where}\n\n${files.join("\n")}\n\n---\n\n`;
    if (app !== "claude" && app !== "codex") throw new Error("Unknown agent app.");
    return { repo: item.repo, draft, url: app === "claude" ? claudeUrl(item.repo, draft) : codexNewTaskUrl(draft, item.repo) };
  }

  async function launch(app: string, id: string, kind: string, open: string) {
    if (open) cleanPath(open);
    const { url } = await prompt(app, id, kind, open);
    await exec("/usr/bin/open", [url]);
  }

  // The full map for the reader's Map tab; maps are large (60 KB is common), so the list leaves them out.
  async function map(id: string) {
    const item = (await load()).initiatives.find((candidate) => candidate.id === id);
    if (!item) throw new Error("Unknown initiative.");
    const { body } = await doc(item.repo, item.ref, item.folder ? `${item.folder}/${MAP_FILE}` : MAP_FILE);
    return { id, map: JSON.parse(body) };
  }

  return { load, doc, map, prompt, launch };
}
