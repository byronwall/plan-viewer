import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { claudeNewSessionUrl as claudeUrl, codexNewTaskUrl } from "./codex-desktop.ts";
import { createLocalRuns } from "./local-runs.ts";
import { createPrNotes } from "./pr-notes.ts";
import { config } from "./public/config.js";

const exec = promisify(execFile);
const STATUS_TTL_MS = 3 * 60_000;
const STATUS_CONCURRENCY = 8;
const HISTORY_TTL_MS = 10 * 60_000;
const EXTRAS_TTL_MS = 2 * 60_000;
const PR_TTL_MS = 60_000; // `gh pr list` for open PRs takes ~5s; a cached list answers at once and refreshes behind the response
const BACKGROUND_MS = 10 * 60_000; // keeps PRs current for ⌘K without the Code page open
const STALE_MS = 14 * 24 * 60 * 60_000;
const LOGIN_RETRY_MS = 60 * 60_000; // an email GitHub could not name yet; its commits may since have been pushed

// The review skills run against PRs (viewer.config.json `code.prSkills`), each under the tracked repo's
// `.claude/skills/<id>/`, then an open "Discuss" prompt about the PR for the user to finish.
export const prSkills = () => [...config().code.prSkills, { id: "discuss", label: "Discuss" }];

// Fills `{path}` / `{number}` in a configured command and runs it.
const runCommand = (command: string[], values: Record<string, string>) =>
  exec(command[0], command.slice(1).map((arg) => arg.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match)), { cwd: values.cwd });

// Prompts over the user's local PR notes (`code.prNotesDir`); the draft notes follow the prompt as Markdown.
const postSkill = () => config().code.postNotesSkill ? ` Read and follow ${config().code.postNotesSkill}.` : "";
const NOTE_PROMPTS = {
  "notes-post": (url: string, _slug: string, _number: number, where: string, path: string) => `Post my draft review notes below as one pending GitHub review on ${url}.${where}${postSkill()} Keep whole-file notes as actual file-level review threads in the same review. Post each comment as written and leave the review pending so I can read it on GitHub and submit it. Then change \`status: draft\` to \`status: posted\` for each verified posted note in ${path}.`,
  "notes-work": (url: string, _slug: string, _number: number, where: string, path: string) => `Work through my draft review notes on ${url}.${where} They are below and in ${path}. For each one, read the code it points at and tell me whether it holds up, what change or reply you'd suggest, and anything nearby I missed. Don't change code, push, or post to GitHub until I say which way to go.`,
};

// Conversation comments, line comments and review summaries from GitHub's REST API, oldest first. Reviews with no
// text (a bare approval) are left out; bots are flagged, not dropped, so the overview can hide them by default.
export function prDiscussion(issueComments: any[], lineComments: any[], reviews: any[]) {
  const entry = (kind: string, item: any, at: string) => ({
    id: `${kind}-${item.id}`, kind, author: item.user?.login || "", bot: item.user?.type === "Bot" || /\[bot\]$|copilot/i.test(item.user?.login || ""),
    body: item.body || "", at, url: item.html_url || "",
    ...(kind === "line" ? { path: item.path || "", line: item.line ?? item.original_line ?? 0 } : {}),
    ...(kind === "review" ? { state: item.state || "" } : {}),
  });
  return [
    ...issueComments.map((item) => entry("comment", item, item.created_at)),
    ...lineComments.map((item) => entry("line", item, item.created_at)),
    ...reviews.filter((item) => item.body?.trim()).map((item) => entry("review", item, item.submitted_at)),
  ].filter((item) => item.body.trim()).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

type HistoryPr = { number: number; branch: string; state: string; title: string; author: string };
type Cleanup = { level: "safe" | "review" | "keep" | "pending"; reason: string };
type Worktree = { repo: string; path: string; branch: string; head: string; commitTime: number; subject?: string; created: number; ownCommits?: number; dirty: number | null; files?: string[]; ahead?: number; behind?: number; editTime: number; activity: number; main: boolean; prState?: string; prNumber?: number; cleanup?: Cleanup };

// Removing a clean worktree keeps its branch and commits; only ignored files (node_modules, local config) go.
// So "safe" means clean and finished, "review" means clean but merely old, and anything dirty or open stays.
export function classifyWorktree(tree: Worktree, merged: boolean, now = Date.now()): Cleanup {
  if (tree.main) return { level: "keep", reason: "main checkout" };
  if (tree.dirty === null) return { level: "pending", reason: "checking for uncommitted changes" };
  if (tree.dirty > 0) return { level: "keep", reason: `${tree.dirty} uncommitted ${tree.dirty === 1 ? "change" : "changes"}` };
  if (tree.prState === "OPEN") return { level: "keep", reason: `PR #${tree.prNumber} is open` };
  if (tree.prState === "MERGED") return { level: "safe", reason: `PR #${tree.prNumber} merged` };
  // A worktree created from main and never committed on also counts as "merged"; say which it was.
  // Branch reflogs expire after 90 days; then a tip older than the worktree itself still shows nothing was committed.
  const unused = tree.ownCommits === 0 || (tree.ownCommits === undefined && tree.created > 0 && tree.commitTime <= tree.created);
  if (merged && unused) return { level: "safe", reason: "never used: no commits, no changes" };
  if (merged) return { level: "safe", reason: tree.ownCommits ? `branch merged into main (${tree.ownCommits} ${tree.ownCommits === 1 ? "commit" : "commits"})` : "branch merged into main" };
  if (tree.prState === "CLOSED") return { level: "safe", reason: `PR #${tree.prNumber} closed` };
  if (now - tree.activity > STALE_MS) return { level: "review", reason: `no PR, idle ${Math.round((now - tree.activity) / 86_400_000)} days` };
  return { level: "keep", reason: "recent activity" };
}

// Images attached to a PR body (github.com/user-attachments/assets/<id>) need a signed-in browser. The API's rendered
// body_html carries short-lived signed URLs for them, so each is downloaded once into the workspace's ignored
// tmp/github-images/ (named by its asset id, type in a sidecar) and served from there.
export async function githubImage(root: string, slug: string, number: number, id: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug) || !Number.isInteger(number) || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Bad GitHub image.");
  const file = join(root, "tmp", "github-images", id);
  try {
    return { type: await readFile(`${file}.type`, "utf8"), body: await readFile(file) };
  } catch {}
  const { stdout } = await exec("gh", ["api", `repos/${slug}/issues/${number}`, "-H", "Accept: application/vnd.github.full+json", "--jq", ".body_html"], { maxBuffer: 32 << 20 });
  const signed = stdout.match(new RegExp(`https://private-user-images\\.githubusercontent\\.com/[^"\\s]*${id}[^"\\s]*`))?.[0]?.replaceAll("&amp;", "&");
  const response = await fetch(signed || `https://github.com/user-attachments/assets/${id}`); // public repos serve it directly
  const type = response.headers.get("content-type") || "";
  if (!response.ok || !type.startsWith("image/")) throw new Error(`GitHub image: ${response.status} ${type}`);
  const body = Buffer.from(await response.arrayBuffer());
  await mkdir(join(root, "tmp", "github-images"), { recursive: true });
  await writeFile(file, body);
  await writeFile(`${file}.type`, type);
  return { type, body };
}

export function createCodeDashboard(root: string) {
  const prNotes = createPrNotes(root, config().code.prNotesDir);
  const configPath = join(root, config().code.reposFile);
  const statusCache = new Map<string, { at: number; dirty: number; editTime: number; files: string[]; ownCommits?: number }>();
  const prExtras = new Map<string, { at: number; byNumber: Map<number, any> }>();
  const prHistory = new Map<string, { at: number; prs: HistoryPr[]; byBranch: Map<string, HistoryPr> }>();
  const openPrs = new Map<string, { at: number; prs: any[] }>();
  const openPrsLoading = new Map<string, Promise<any[]>>();
  let scan: Promise<void> | null = null;
  let known = new Set<string>();
  let lastWorktrees: Worktree[] = [];
  let login = "";

  // PR lists survive restarts in tmp/code-cache.json, so ⌘K and the Code page answer from disk while gh catches up.
  const cachePath = join(root, "tmp", "code-cache.json");
  const setHistory = (slug: string, at: number, prs: HistoryPr[]) => {
    const byBranch = new Map<string, HistoryPr>();
    for (const pr of prs) if (!byBranch.has(pr.branch)) byBranch.set(pr.branch, pr);
    prHistory.set(slug, { at, prs, byBranch });
  };
  try {
    const saved = JSON.parse(readFileSync(cachePath, "utf8"));
    for (const [repo, entry] of Object.entries<any>(saved.openPrs || {})) openPrs.set(repo, entry);
    for (const [slug, entry] of Object.entries<any>(saved.prHistory || {})) setHistory(slug, entry.at, entry.prs);
    for (const [slug, entry] of Object.entries<any>(saved.prExtras || {})) prExtras.set(slug, { at: entry.at, byNumber: new Map(entry.byNumber) });
  } catch {}
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      const data = {
        openPrs: Object.fromEntries(openPrs),
        prHistory: Object.fromEntries([...prHistory].map(([slug, entry]) => [slug, { at: entry.at, prs: entry.prs }])),
        prExtras: Object.fromEntries([...prExtras].map(([slug, entry]) => [slug, { at: entry.at, byNumber: [...entry.byNumber] }])),
      };
      await mkdir(join(root, "tmp"), { recursive: true }).catch(() => {});
      await writeFile(cachePath, JSON.stringify(data)).catch(() => {});
    }, 500);
  }

  const git = async (cwd: string, args: string[], env: Record<string, string> = {}) =>
    (await exec("git", ["-C", cwd, ...args], { maxBuffer: 32 << 20, env: { ...process.env, ...env } })).stdout;

  async function readRepos(): Promise<string[]> {
    try { return JSON.parse(await readFile(configPath, "utf8")).repos || []; } catch { return []; }
  }

  async function saveRepos(repos: string[]) {
    await writeFile(configPath, `${JSON.stringify({ repos }, null, 2)}\n`);
  }

  async function githubSlug(repo: string) {
    const remote = (await git(repo, ["remote", "get-url", "origin"]).catch(() => "")).trim();
    return remote.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] || "";
  }

  // The tracked clone of a GitHub repo, or "".
  async function cloneFor(slug: string) {
    for (const repo of await readRepos()) if (await githubSlug(repo) === slug) return repo;
    return "";
  }

  async function listWorktrees(repo: string): Promise<Worktree[]> {
    const blocks = (await git(repo, ["worktree", "list", "--porcelain"])).trim().split("\n\n");
    const trees = blocks.map((block, index) => {
      const field = (name: string) => block.match(new RegExp(`^${name} (.+)$`, "m"))?.[1] || "";
      return { repo, path: field("worktree"), head: field("HEAD"), branch: field("branch").replace(/^refs\/heads\//, "") || "(detached)", main: index === 0, prunable: /^prunable/m.test(block) };
    }).filter((tree) => tree.path && !tree.prunable && existsSync(tree.path));
    const heads = [...new Set(trees.map((tree) => tree.head).filter(Boolean))];
    // Each head's commit time and subject; the subject names a detached worktree and says what a branch last did.
    const commits = new Map((await git(repo, ["show", "-s", "--format=%H %ct %s", ...heads])).trim().split("\n").map((line) => {
      const [sha, time, ...subject] = line.split(" ");
      return [sha, { time: Number(time) * 1000, subject: subject.join(" ") }] as const;
    }));
    const counts = new Map((await git(repo, ["for-each-ref", "--format=%(refname:short) %(ahead-behind:origin/main)", "refs/heads"]).catch(() => "")).trim().split("\n").map((line) => {
      const [branch, ahead, behind] = line.split(" ");
      return [branch, { ahead: Number(ahead), behind: Number(behind) }] as const;
    }));
    return trees.map(({ prunable, ...tree }) => {
      const commitTime = commits.get(tree.head)?.time || 0;
      const cached = statusCache.get(tree.path);
      const editTime = cached?.editTime || 0;
      // A new worktree points at an old main commit, so its creation time also counts as activity.
      const created = tree.main ? 0 : statSync(join(tree.path, ".git"), { throwIfNoEntry: false })?.birthtimeMs || 0;
      return { ...tree, ...counts.get(tree.branch), commitTime, subject: commits.get(tree.head)?.subject || "", created, ownCommits: cached?.ownCommits, dirty: cached ? cached.dirty : null, files: cached?.files, editTime, activity: Math.max(commitTime, editTime, created) };
    });
  }

  // Uncommitted edits are the "live" signal, but `git status` over ~240 worktrees takes ~10s, so it runs in the
  // background and the page polls. GIT_OPTIONAL_LOCKS=0 keeps it from rewriting each index (which would make every
  // worktree look freshly touched) and fsmonitor is off so we don't spawn a daemon per worktree.
  async function statusOf(path: string, branch: string) {
    const out = await git(path, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=normal"], { GIT_OPTIONAL_LOCKS: "0" });
    const entries = out.split("\0");
    const files: string[] = [];
    for (let index = 0; index < entries.length; index++) {
      if (!entries[index]) continue;
      files.push(entries[index]);
      if (/^[RC]/.test(entries[index])) index++; // renames and copies are followed by their source path
    }
    let editTime = 0;
    for (const file of files.slice(0, 200)) {
      const mtime = await stat(join(path, file.slice(3))).then((info) => info.mtimeMs, () => 0);
      editTime = Math.max(editTime, mtime);
    }
    // The branch reflog records each commit made on it ("commit: …", "commit (amend): …"), unlike pulls or merges.
    const reflog = branch === "(detached)" ? "" : await git(path, ["reflog", "show", "--format=%gs", `refs/heads/${branch}`]).catch(() => "");
    const ownCommits = reflog ? reflog.split("\n").filter((line) => line.startsWith("commit")).length : undefined;
    return { at: Date.now(), dirty: files.length, editTime, files: files.slice(0, 40), ownCommits };
  }

  // Every PR ever opened, newest first, so each branch maps to its latest PR. ~10s for a large repo, hence the cache.
  async function loadPrHistory(slug: string) {
    const { stdout } = await exec("gh", ["pr", "list", "-R", slug, "--state", "all", "--limit", "5000", "--json", "number,headRefName,state,title,author"], { maxBuffer: 64 << 20 });
    setHistory(slug, Date.now(), JSON.parse(stdout).map((pr: any) => ({ number: pr.number, branch: pr.headRefName, state: pr.state, title: pr.title, author: pr.author?.login || "" })));
    persist();
  }

  // CI, labels, comments and reviews. `gh pr list --json statusCheckRollup` times out on large repos, so ask GraphQL
  // for the rollup state alone, 40 PRs a page (~8s total), in the background.
  async function loadPrExtras(slug: string) {
    const [owner, name] = slug.split("/");
    const query = `query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:40,after:$endCursor,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{number mergeable labels(first:6){nodes{name color}} comments{totalCount} latestReviews(first:10){nodes{author{login} state}} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;
    const { stdout } = await exec("gh", ["api", "graphql", "--paginate", "-F", `owner=${owner}`, "-F", `name=${name}`, "-f", `query=${query}`], { maxBuffer: 64 << 20 });
    const byNumber = new Map<number, any>();
    // --paginate concatenates one JSON document per page
    for (const page of stdout.replace(/}\s*{"data"/g, '}\n{"data"').split("\n").filter(Boolean)) {
      for (const pr of JSON.parse(page).data.repository.pullRequests.nodes) {
        byNumber.set(pr.number, {
          ci: pr.commits.nodes[0]?.commit.statusCheckRollup?.state || "",
          mergeable: pr.mergeable,
          labels: pr.labels.nodes,
          comments: pr.comments.totalCount,
          reviews: pr.latestReviews.nodes.map((review: any) => ({ login: review.author?.login || "", state: review.state })),
        });
      }
    }
    prExtras.set(slug, { at: Date.now(), byNumber });
    persist();
  }

  function refreshBackground(trees: Worktree[], slugs: string[]) {
    const stale = trees.filter((tree) => Date.now() - (statusCache.get(tree.path)?.at || 0) > STATUS_TTL_MS);
    const staleSlugs = slugs.filter((slug) => Date.now() - (prHistory.get(slug)?.at || 0) > HISTORY_TTL_MS);
    const staleExtras = slugs.filter((slug) => Date.now() - (prExtras.get(slug)?.at || 0) > EXTRAS_TTL_MS);
    if (scan || (!stale.length && !staleSlugs.length && !staleExtras.length)) return;
    scan = (async () => {
      await Promise.all([...staleSlugs.map((slug) => loadPrHistory(slug).catch(() => {})), ...staleExtras.map((slug) => loadPrExtras(slug).catch(() => {}))]);
      const queue = [...stale];
      await Promise.all(Array.from({ length: STATUS_CONCURRENCY }, async () => {
        for (let tree = queue.shift(); tree; tree = queue.shift()) {
          statusCache.set(tree.path, await statusOf(tree.path, tree.branch).catch(() => ({ at: Date.now(), dirty: 0, editTime: 0, files: [] })));
        }
      }));
    })().finally(() => { scan = null; });
  }

  async function listPrs(repo: string, slug: string) {
    if (!slug) return [];
    const fields = "number,title,author,headRefName,baseRefName,isDraft,reviewDecision,updatedAt,createdAt,url,additions,deletions,reviewRequests";
    const [all, requested] = await Promise.all([
      exec("gh", ["pr", "list", "-R", slug, "--state", "open", "--limit", "500", "--json", fields], { maxBuffer: 32 << 20 }),
      exec("gh", ["pr", "list", "-R", slug, "--state", "open", "--limit", "500", "--search", "review-requested:@me", "--json", "number"]),
    ]);
    const requestedOfMe = new Set(JSON.parse(requested.stdout).map((pr: { number: number }) => pr.number));
    return JSON.parse(all.stdout).map((pr: any) => ({
      repo, slug, number: pr.number, title: pr.title, url: pr.url, author: pr.author?.login || "", branch: pr.headRefName, base: pr.baseRefName,
      draft: pr.isDraft, reviewDecision: pr.reviewDecision || "", updatedAt: pr.updatedAt, createdAt: pr.createdAt,
      additions: pr.additions, deletions: pr.deletions, requestedOfMe: requestedOfMe.has(pr.number),
      reviewers: (pr.reviewRequests || []).map((request: any) => request.login || request.name || request.slug).filter(Boolean),
    }));
  }

  function refreshOpenPrs(repo: string, slug: string) {
    let pending = openPrsLoading.get(repo);
    if (!pending) {
      pending = listPrs(repo, slug).then((prs) => { openPrs.set(repo, { at: Date.now(), prs }); persist(); return prs; }).finally(() => openPrsLoading.delete(repo));
      openPrsLoading.set(repo, pending);
    }
    return pending;
  }

  // Stale-while-revalidate: any cached list answers at once; one older than PR_TTL_MS refreshes behind the response.
  async function cachedPrs(repo: string, slug: string, force: boolean) {
    const hit = openPrs.get(repo);
    if (!hit || force) return refreshOpenPrs(repo, slug);
    if (Date.now() - hit.at > PR_TTL_MS) refreshOpenPrs(repo, slug).catch(() => {});
    return hit.prs;
  }

  // Everything ⌘K needs to find a PR by number without touching the network: open PRs with their CI and reviews,
  // then every other PR from the history. A stale cache refreshes in the background.
  async function prIndex() {
    const repos = await readRepos();
    const slugs = new Map(await Promise.all(repos.map(async (repo) => [repo, await githubSlug(repo)] as const)));
    const prs: any[] = [];
    for (const repo of repos) {
      const slug = slugs.get(repo) || "";
      if (!slug) continue;
      if (Date.now() - (openPrs.get(repo)?.at || 0) > PR_TTL_MS) refreshOpenPrs(repo, slug).catch(() => {});
      refreshBackground([], [slug]); // history and CI, each only when past its own TTL
      const open = (openPrs.get(repo)?.prs || []).map((pr: any) => ({ ...pr, ...prExtras.get(slug)?.byNumber.get(pr.number), state: "OPEN" }));
      const openNumbers = new Set(open.map((pr: any) => pr.number));
      prs.push(...open, ...(prHistory.get(slug)?.prs || []).filter((pr) => !openNumbers.has(pr.number)).map((pr) => ({ repo, slug, ...pr, url: `https://github.com/${slug}/pull/${pr.number}` })));
    }
    if (!login) login = (await exec("gh", ["api", "user", "--jq", ".login"]).catch(() => ({ stdout: "" }))).stdout.trim();
    return { prs, me: login, skills: prSkills(), previews: repos.filter(hasPreview), runnable: repos.filter(hasRun), runs: runs.list(), loading: openPrsLoading.size > 0 || Boolean(scan) };
  }

  // Every worktree's branch, for joining issue keys to local work; `git worktree list` per repo, no status scan.
  async function worktreeIndex() {
    const lists = await Promise.all((await readRepos()).map((repo) => listWorktrees(repo).catch(() => [])));
    return lists.flat().filter((tree) => !tree.main).map(({ repo, path, branch }) => ({ repo, path, branch }));
  }

  // Keeps the PR caches warm for ⌘K: open PRs, history, and CI every BACKGROUND_MS, starting now if the disk copy is old.
  function startBackgroundRefresh() {
    const tick = () => prIndex().catch(() => {});
    tick();
    setInterval(tick, BACKGROUND_MS).unref();
  }

  async function load(force = false) {
    const scanning = Boolean(scan); // read before the caches so a scan finishing mid-load still triggers one more poll
    const repos = await readRepos();
    const slugs = new Map(await Promise.all(repos.map(async (repo) => [repo, await githubSlug(repo)] as const)));
    const mergedBranches = new Map(await Promise.all(repos.map(async (repo) => [repo, new Set((await git(repo, ["for-each-ref", "--merged", "origin/main", "--format=%(refname:short)", "refs/heads"]).catch(() => "")).split("\n").filter(Boolean))] as const)));
    if (!login) login = (await exec("gh", ["api", "user", "--jq", ".login"]).catch(() => ({ stdout: "" }))).stdout.trim();
    const errors: string[] = [];
    const settle = <T>(label: string, work: Promise<T[]>) => work.catch((error) => { errors.push(`${label}: ${error.message.split("\n")[0]}`); return [] as T[]; });
    const [worktrees, prs] = await Promise.all([
      Promise.all(repos.map((repo) => settle(repo, listWorktrees(repo)))).then((lists) => lists.flat()),
      Promise.all(repos.map((repo) => settle(`${repo} PRs`, cachedPrs(repo, slugs.get(repo) || "", force)))).then((lists) => lists.flat()),
    ]);
    known = new Set([...repos, ...worktrees.map((tree) => tree.path)]);
    lastWorktrees = worktrees;
    if (force) for (const cache of [statusCache, prHistory, prExtras] as Map<string, { at: number }>[]) for (const entry of cache.values()) entry.at = 0;
    refreshBackground(worktrees, [...new Set(slugs.values())].filter(Boolean));
    for (const tree of worktrees) {
      const pr = prHistory.get(slugs.get(tree.repo) || "")?.byBranch.get(tree.branch);
      Object.assign(tree, pr ? { prState: pr.state, prNumber: pr.number } : {});
      tree.cleanup = prHistory.has(slugs.get(tree.repo) || "") || tree.dirty === null || tree.dirty > 0
        ? classifyWorktree(tree, mergedBranches.get(tree.repo)?.has(tree.branch) || false)
        : { level: "pending", reason: "loading PR history" };
    }
    worktrees.sort((a, b) => b.activity - a.activity);
    const richPrs = prs.map((pr: any) => ({ ...pr, ...prExtras.get(pr.slug)?.byNumber.get(pr.number) }));
    const previews = repos.filter(hasPreview);
    const runnable = repos.filter(hasRun);
    return { repos, me: login, slugs: Object.fromEntries(slugs), worktrees, prs: richPrs, skills: prSkills(), previews, runnable, runs: runs.list(), scanning: scanning || Boolean(scan) || openPrsLoading.size > 0, errors };
  }

  // The overview can open a worktree from a ?wt= URL before the Code page has scanned anything; one scan settles it.
  // The known folders come from load(), which only the Code page calls; an overlay opened from ⌘K or a ?pr= link after
  // a restart gets here first, so an unknown folder triggers one scan before it is refused.
  async function knownWorktree(path: string) {
    if (!known.has(path)) await load();
    return knownPath(path);
  }

  // What the worktree's changes are measured against: its open PR's base branch (so a stacked branch matches its PR),
  // else main. The main checkout has no fork point, so it compares with HEAD.
  function baseBranch(tree: Worktree | undefined) {
    if (!tree || tree.main) return "";
    const pr = (openPrs.get(tree.repo)?.prs || []).find((candidate: any) => candidate.branch === tree.branch);
    return pr?.base || "main";
  }
  async function branchBase(path: string) {
    const name = baseBranch(lastWorktrees.find((candidate) => candidate.path === path));
    if (!name) return "HEAD";
    return (await git(path, ["merge-base", `origin/${name}`, "HEAD"]).catch(() => "HEAD")).trim() || "HEAD";
  }

  // New files git doesn't know about, as patches against /dev/null.
  async function untrackedPatch(path: string) {
    const untracked = (await git(path, ["ls-files", "--others", "--exclude-standard", "-z"]).catch(() => "")).split("\0").filter(Boolean).slice(0, 200);
    // `git diff --no-index` exits 1 when files differ, so the patch arrives on the rejection.
    const added = await Promise.all(untracked.map((file) => git(path, ["diff", "--no-index", "--no-color", "--", "/dev/null", file]).catch((error) => error.stdout || "")));
    return added.join("");
  }

  function knownPath(path: string) {
    if (!known.has(path)) throw new Error("That folder is not a tracked repository or worktree. Reload the Code page.");
    return path;
  }

  async function addRepo(input: string) {
    const path = resolve(input.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
    const top = (await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => { throw new Error(`${path} is not a git repository.`); })).trim();
    const repo = top.endsWith("/.git") ? top.slice(0, -5) : path;
    const repos = await readRepos();
    if (!repos.includes(repo)) await saveRepos([...repos, repo]);
    return repo;
  }

  async function removeRepo(repo: string) {
    await saveRepos((await readRepos()).filter((candidate) => candidate !== repo));
  }

  // `code.prPreview` runs a repo's own preview command (e.g. `bun all pr <n>`).
  const hasPreview = (repo: string) => Boolean(config().code.prPreview?.requires.every((file: string) => existsSync(join(repo, file))));
  async function openPreview(repo: string, number: string) {
    await knownWorktree(repo);
    if (!hasPreview(repo)) throw new Error(`${repo} has no PR preview command.`);
    if (!/^\d+$/.test(number)) throw new Error("Not a PR number.");
    const { command } = config().code.prPreview;
    await runCommand(command, { number, cwd: repo }).catch((error) => { throw new Error(`${command.join(" ")} failed for #${number}: ${(error.stderr || error.stdout || error.message).trim().split("\n").pop()}`); });
  }

  // `code.run` starts a repo's own local server (e.g. `bun all --ports`) in a worktree; a PR without one is checked out
  // first with `code.run.worktree` (run in the repo, `{branch}` filled), when configured.
  const runs = createLocalRuns();
  const runRepo = (path: string) => lastWorktrees.find((tree) => tree.path === path)?.repo || path;
  const hasRun = (repo: string) => Boolean(config().code.run?.requires.every((file: string) => existsSync(join(repo, file))));
  async function startRun(path: string) {
    await knownWorktree(path);
    if (!hasRun(runRepo(path))) throw new Error(`${path} has no local run command.`);
    return runs.start(path, config().code.run.command);
  }
  async function runPr(repo: string, branch: string) {
    await knownWorktree(repo);
    const existing = lastWorktrees.find((tree) => tree.repo === repo && tree.branch === branch);
    if (existing) return startRun(existing.path);
    const { worktree } = config().code.run || {};
    if (!hasRun(repo) || !worktree) throw new Error(`No worktree for ${branch}, and ${repo} has no worktree command.`);
    if (!/^[\w./-]+$/.test(branch) || branch.startsWith("-")) throw new Error("Not a branch name.");
    await git(repo, ["fetch", "origin", branch]).catch(() => {});
    await runCommand(worktree, { branch, cwd: repo }).catch((error) => { throw new Error(`${worktree.join(" ")} failed for ${branch}: ${(error.stderr || error.stdout || error.message).trim().split("\n").pop()}`); });
    const blocks = (await git(repo, ["worktree", "list", "--porcelain"])).trim().split("\n\n");
    const path = blocks.find((block) => block.includes(`branch refs/heads/${branch}\n`) || block.endsWith(`branch refs/heads/${branch}`))?.match(/^worktree (.+)$/m)?.[1];
    if (!path) throw new Error(`${worktree.join(" ")} finished but no worktree has ${branch} checked out.`);
    await load(true);
    return startRun(path);
  }
  const stopRun = (path: string) => runs.stop(path);
  async function restartRun(path: string) {
    await knownWorktree(path);
    return runs.restart(path);
  }
  // Every server the viewer started, newest first, with the worktree's repo and branch for the servers overlay.
  const allRuns = () => runs.all().sort((a, b) => b.startedAt - a.startedAt).map((run) => {
    const tree = lastWorktrees.find((candidate) => candidate.path === run.path);
    return { ...run, repo: tree?.repo || "", branch: tree?.branch || "" };
  });
  const runLog = (path: string) => runs.log(path);

  async function open(kind: string, path: string) {
    await knownWorktree(path);
    if (kind === "vscode") await runCommand(config().code.editor, { path });
    else if (kind === "terminal") await runCommand(config().code.terminal.command, { path });
    else if (kind === "finder") await exec("/usr/bin/open", [path]);
    else throw new Error("Unknown open target.");
  }

  async function worktreeDetail(path: string) {
    await knownWorktree(path);
    const tree = lastWorktrees.find((candidate) => candidate.path === path);
    const base = tree?.main ? "HEAD" : `HEAD --not origin/${baseBranch(tree)}`;
    const log = await git(path, ["log", "-100", "--format=%H%x1f%ct%x1f%an%x1f%s", ...base.split(" ")]).catch(() => "");
    const commits = log.trim().split("\n").filter(Boolean).map((line) => {
      const [sha, time, author, subject] = line.split("\x1f");
      return { sha, time: Number(time) * 1000, author, subject };
    });
    // Ignored files that look hand-made (notes, env overrides, scratch output), minus dependency and build caches.
    const generated = /(^|\/)(node_modules|__pycache__|\.venv|venv|dist|build|\.turbo|\.next|coverage|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.cache|\.parcel-cache|\.svelte-kit|\.vite|out|target|[^/]+\.egg-info)\/$|\.pyc$|\.DS_Store$|\.tsbuildinfo$/;
    const statusOut = await git(path, ["-c", "core.fsmonitor=false", "status", "--porcelain", "--ignored", "-z"], { GIT_OPTIONAL_LOCKS: "0" }).catch(() => "");
    const entries = statusOut.split("\0");
    const ignored = entries.filter((entry) => entry.startsWith("!! ")).map((entry) => entry.slice(3)).filter((file) => !generated.test(file));
    const untracked = entries.filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3));
    const [summaries, untrackedSummaries] = await Promise.all([ignored, untracked].map((list) => Promise.all(list.slice(0, 60).map(async (entry) => ({ path: entry, ...await summarize(join(path, entry)) })))));
    const slug = tree ? await githubSlug(tree.repo) : "";
    const open = tree && (openPrs.get(tree.repo)?.prs || []).find((pr: any) => pr.branch === tree.branch);
    const past = tree && prHistory.get(slug)?.byBranch.get(tree.branch);
    const pr = open ? { ...open, ...prExtras.get(slug)?.byNumber.get(open.number), state: "OPEN" } : past ? { slug, number: past.number, state: past.state, title: past.title, url: `https://github.com/${slug}/pull/${past.number}` } : null;
    return {
      tree, slug, pr, base: baseBranch(tree), commits, files: statusCache.get(path)?.files || [],
      ignored: summaries, ignoredCount: ignored.length, untracked: untrackedSummaries, untrackedCount: untracked.length,
    };
  }

  // The files inside one untracked or ignored folder, newest first, for the overview's Local files list.
  async function localDir(path: string, dir: string) {
    const root = await knownWorktree(path);
    if (!dir.endsWith("/")) throw new Error("Not a folder.");
    const LIMIT = 300;
    const entries = (await readdir(join(root, checkFile(dir)), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
    const files = await Promise.all(entries.slice(0, LIMIT).map(async (entry) => {
      const full = join(entry.parentPath, entry.name);
      const info = await stat(full).catch(() => null);
      return { path: full.slice(root.length + 1), bytes: info?.size || 0, newest: info?.mtimeMs || 0 };
    }));
    return { files: files.sort((a, b) => b.newest - a.newest), total: entries.length };
  }

  // File count, bytes, and newest change for an ignored file or folder, so "tmp/" says whether it holds 2 files or 2,000.
  async function summarize(target: string) {
    const LIMIT = 5000;
    const info = await stat(target).catch(() => null);
    if (!info) return { files: 0, bytes: 0, newest: 0, truncated: false };
    if (!info.isDirectory()) return { files: 1, bytes: info.size, newest: info.mtimeMs, truncated: false };
    const entries = (await readdir(target, { recursive: true, withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile());
    let bytes = 0;
    let newest = 0;
    for (const entry of entries.slice(0, LIMIT)) {
      const file = await stat(join(entry.parentPath, entry.name)).catch(() => null);
      if (file) { bytes += file.size; newest = Math.max(newest, file.mtimeMs); }
    }
    // The listing is cheap and exact; only sizes stop at LIMIT stats, so a capped size is a lower bound.
    return { files: entries.length, bytes, newest, truncated: entries.length > LIMIT };
  }

  // `gh pr view` and `gh pr diff` take 1–3s each, so the PR overview caches both. An open PR's entry stays valid while
  // its updatedAt in the open-PR list is unchanged (else for PR_TTL_MS); a closed or merged PR no longer changes.
  const prCache = new Map<string, { at: number; version: string; value: Promise<any> }>();
  function prVersion(slug: string, number: number) {
    for (const entry of openPrs.values()) {
      const pr = entry.prs.find((candidate: any) => candidate.slug === slug && candidate.number === number);
      if (pr) return pr.updatedAt;
    }
    const closed = prHistory.get(slug)?.prs.find((pr) => pr.number === number && pr.state !== "OPEN");
    return closed ? closed.state : "";
  }
  function cachedPr<T>(kind: string, slug: string, number: number, load: () => Promise<T>): Promise<T> {
    const key = `${kind} ${slug}#${number}`;
    const version = prVersion(slug, number);
    const hit = prCache.get(key);
    if (hit && (version ? hit.version === version : Date.now() - hit.at < PR_TTL_MS)) return hit.value;
    const value = load();
    prCache.set(key, { at: Date.now(), version, value });
    value.catch(() => prCache.delete(key));
    if (prCache.size > 60) prCache.delete(prCache.keys().next().value!); // oldest first
    return value;
  }

  async function prDetail(slug: string, number: number) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug) || !Number.isInteger(number)) throw new Error("Bad pull request.");
    const detail = await cachedPr("detail", slug, number, () => loadPrDetail(slug, number));
    // Checked on every call (one `git worktree list`), since a worktree can appear after the details were cached.
    const tree = detail.repo ? (await listWorktrees(detail.repo).catch(() => [])).find((candidate) => !candidate.main && candidate.branch === detail.branch) : null;
    return { ...detail, worktree: tree?.path || "" };
  }

  async function loadPrDetail(slug: string, number: number) {
    const fields = "body,files,commits,title,url,state,author,headRefName,baseRefName,headRefOid,baseRefOid,isDraft,reviewDecision,additions,deletions,createdAt,updatedAt,mergedAt";
    const api = (path: string) => exec("gh", ["api", "--paginate", "--slurp", `repos/${slug}/${path}`], { maxBuffer: 32 << 20 }).then(({ stdout }) => JSON.parse(stdout).flat(), () => []);
    const [{ stdout }, issueComments, lineComments, reviews] = await Promise.all([
      exec("gh", ["pr", "view", String(number), "-R", slug, "--json", fields], { maxBuffer: 32 << 20 }),
      api(`issues/${number}/comments`), api(`pulls/${number}/comments`), api(`pulls/${number}/reviews`),
    ]);
    const pr = JSON.parse(stdout);
    const repo = (await readRepos()).find((candidate) => candidate.split("/").pop()!.toLowerCase() === slug.split("/")[1].toLowerCase()) || "";
    return {
      slug, number, repo, title: pr.title, url: pr.url, state: pr.state, author: pr.author?.login || "", branch: pr.headRefName, base: pr.baseRefName,
      draft: pr.isDraft, reviewDecision: pr.reviewDecision || "", additions: pr.additions, deletions: pr.deletions, createdAt: pr.createdAt, updatedAt: pr.updatedAt, mergedAt: pr.mergedAt,
      headSha: pr.headRefOid, baseSha: pr.baseRefOid,
      body: pr.body || "",
      discussion: prDiscussion(issueComments, lineComments, reviews),
      files: (pr.files || []).map((file: any) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
      // Oldest first, full SHAs, so the PR overlay can walk them in order and fetch each diff.
      commits: (pr.commits || []).map((commit: any) => ({ sha: commit.oid, subject: commit.messageHeadline, time: new Date(commit.committedDate).getTime(), author: commit.authors?.[0]?.login || commit.authors?.[0]?.name || "" })),
    };
  }

  // A blank session rooted in the worktree; Codex needs some prompt text, so it gets the branch as context.
  async function launchSession(app: string, path: string) {
    await knownWorktree(path);
    const tree = lastWorktrees.find((candidate) => candidate.path === path);
    const url = app === "claude"
      ? claudeUrl(path)
      : codexNewTaskUrl(`Working in ${path} on branch ${tree?.branch || "(unknown)"}. `, path);
    await exec("/usr/bin/open", [url]);
  }

  function skillFile(workspace: string, skill: string) {
    for (const name of ["SKILL.md", "skill.md"]) {
      const file = join(workspace, ".claude", "skills", skill, name);
      if (existsSync(file)) return `.claude/skills/${skill}/${name}`;
    }
    return "";
  }

  // Both desktop apps take a prefilled draft and wait for Enter, so the user can edit before sending.
  async function launchAgent(app: string, skill: string, prUrl: string, workspace: string, commentId = "") {
    await knownWorktree(workspace);
    if (!prSkills().some((candidate) => candidate.id === skill) && !Object.hasOwn(NOTE_PROMPTS, skill) && skill !== "discuss-comment") throw new Error("Unknown skill.");
    const pull = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(prUrl);
    if (!pull) throw new Error("Not a GitHub pull request URL.");
    // Open in the repo root so the app reuses its existing project and permissions; the prompt names the worktree.
    const tree = lastWorktrees.find((candidate) => candidate.path === workspace && !candidate.main);
    const root = tree?.repo || workspace;
    const where = tree ? ` Work in its worktree at ${tree.path} (branch ${tree.branch}).` : "";
    const file = skillFile(root, skill);
    let url: string;
    if (Object.hasOwn(NOTE_PROMPTS, skill)) {
      const notes = await prNotes.drafts(pull[1], Number(pull[2]));
      if (!notes.text) throw new Error("No draft notes on this PR.");
      const draft = `${NOTE_PROMPTS[skill as keyof typeof NOTE_PROMPTS](prUrl, pull[1], Number(pull[2]), where, notes.path)}\n\n${notes.text}\n`;
      url = app === "claude" ? claudeUrl(root, draft) : codexNewTaskUrl(draft, root);
    } else if (skill === "discuss-comment") {
      const comment = (await prDetail(pull[1], Number(pull[2]))).discussion.find((item) => item.id === commentId);
      if (!comment) throw new Error("That comment is no longer on the PR.");
      const place = comment.kind === "line" ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ""}` : "";
      const quote = comment.body.trim().split("\n").map((line) => `> ${line}`).join("\n");
      const draft = `Let's talk through this comment from @${comment.author}${place} on ${prUrl} (${comment.url}).${where} Read the PR and the code it points at first.\n\n${quote}\n\n`;
      url = app === "claude" ? claudeUrl(root, draft) : codexNewTaskUrl(draft, root);
    } else if (skill === "discuss") {
      const draft = `Let's talk through this pull request: ${prUrl}.${where} Read it first, then `;
      url = app === "claude" ? claudeUrl(root, draft) : codexNewTaskUrl(draft, root);
    } else if (app === "claude") {
      // Claude turns a leading "/" from a link into a full-width "／" so links can't run commands, so the command goes mid-sentence.
      url = claudeUrl(root, `Run /${skill} on ${prUrl}.${where}`);
    } else if (app === "codex") {
      if (!file) throw new Error(`No ${skill} skill under ${root}/.claude/skills.`);
      url = codexNewTaskUrl(`Read and follow the ${skill} skill at ${file} for this pull request: ${prUrl}.${where}`, root);
    } else throw new Error("Unknown agent app.");
    await exec("/usr/bin/open", [url]);
  }

  // Sequential on purpose: git locks the shared worktree metadata. `git worktree remove` without --force refuses
  // dirty or locked worktrees, so a stale page can't destroy uncommitted work.
  async function removeWorktrees(paths: string[]) {
    const results = [];
    for (const path of paths) {
      knownPath(path);
      const tree = lastWorktrees.find((candidate) => candidate.path === path);
      if (!tree || tree.main) { results.push({ path, ok: false, error: "Not a removable worktree." }); continue; }
      try {
        await git(tree.repo, ["worktree", "remove", path]);
        statusCache.delete(path);
        known.delete(path);
        results.push({ path, ok: true });
      } catch (error) {
        results.push({ path, ok: false, error: (error as Error).message.split("\n").find((line) => line.startsWith("fatal")) || "git refused" });
      }
    }
    return results;
  }

  function cleanupPrompt(paths: string[]) {
    const trees = paths.map((path) => lastWorktrees.find((tree) => tree.path === knownPath(path))).filter((tree): tree is Worktree => Boolean(tree && !tree.main));
    if (!trees.length) throw new Error("No worktrees selected.");
    const repo = trees[0].repo;
    const lines = trees.map((tree) => `- ${tree.path} (branch ${tree.branch}; last activity ${new Date(tree.activity).toISOString().slice(0, 10)}; ${tree.cleanup?.reason || ""})`);
    return { repo, prompt: `Help me clean up old git worktrees in ${repo}. I have far too many and want to remove the ones that hold nothing I need.\n\nCandidates:\n${lines.join("\n")}\n\nFor each candidate, check for uncommitted or untracked changes, commits not on any remote branch (\`git log <branch> --not --remotes\`), stashes, and ignored local files that look hand-made rather than generated (notes, .env overrides, scratch scripts). Follow this repository's own worktree instructions if it has any. Remove a worktree with \`git worktree remove <path>\` (never --force) only when it holds nothing unique; keep its branch. Do not delete branches or push anything. Finish with \`git worktree prune\` and a short table: removed, kept (with the reason), and anything you need me to decide.` };
  }

  async function launchCleanup(app: string, paths: string[]) {
    const { repo, prompt } = cleanupPrompt(paths);
    const url = app === "claude" ? claudeUrl(repo, prompt) : codexNewTaskUrl(prompt, repo);
    await exec("/usr/bin/open", [url]);
  }

  // Newest-first commits across every tracked repo. "local" is work on local branches not yet on origin/main;
  // "all" adds origin/main itself (logged separately so main's commits aren't attributed to whichever feature branch
  // the walk reached first). Each commit gets `login`, its author's GitHub login (see below), for avatars and the author filter.
  async function commits(scope: string) {
    const LIMIT = 400;
    const repos = await readRepos();
    if (!login) login = (await exec("gh", ["api", "user", "--jq", ".login"]).catch(() => ({ stdout: "" }))).stdout.trim();
    const myEmails = new Set<string>();
    const lists = await Promise.all(repos.map(async (repo) => {
      myEmails.add((await git(repo, ["config", "user.email"]).catch(() => "")).trim().toLowerCase());
      const slug = await githubSlug(repo).catch(() => "");
      const format = ["--format=%x1e%H%x1f%ct%x1f%an%x1f%ae%x1f%s%x1f%S", "--shortstat", "--diff-merges=first-parent", `-n${LIMIT}`];
      const logs = [git(repo, ["log", "--branches", "--not", "origin/main", "--source", ...format]).catch(() => "")];
      if (scope !== "local") logs.push(git(repo, ["log", "origin/main", ...format]).then((out) => out.replace(/\x1f(?=\n|$)/g, "\x1forigin/main"), () => ""));
      const seen = new Set<string>();
      return (await Promise.all(logs)).join("").split("\x1e").filter(Boolean).flatMap((record) => {
        const [head, ...rest] = record.split("\n");
        const [sha, time, author, email, subject, ref] = head.split("\x1f");
        if (seen.has(sha)) return [];
        seen.add(sha);
        const stat = rest.join(" ");
        const num = (pattern: RegExp) => Number(stat.match(pattern)?.[1] || 0);
        const branch = (ref || "").replace(/^refs\/heads\//, "");
        const tree = lastWorktrees.find((candidate) => candidate.repo === repo && candidate.branch === branch);
        return [{ repo, slug, sha, time: Number(time) * 1000, author, email, subject, branch, worktree: tree?.path || "", files: num(/(\d+) files? changed/), additions: num(/(\d+) insertion/), deletions: num(/(\d+) deletion/) }];
      });
    }));
    const all = lists.flat().sort((a, b) => b.time - a.time).slice(0, LIMIT * 2);
    await resolveLogins(all, myEmails);
    return { commits: all.map(({ slug: _slug, ...commit }) => ({ ...commit, login: emailLogins.get(commit.email.toLowerCase())?.login || "" })) };
  }

  // Git knows emails, GitHub knows logins. A noreply address names the login and this checkout's user.email is the
  // gh user; any other email asks GitHub who authored one of its commits (main's first, since branch tips may be
  // unpushed). Misses retry after an hour, once their commits may have been pushed.
  const emailLogins = new Map<string, { login: string; at: number }>();
  async function resolveLogins(list: { slug: string; sha: string; email: string; branch: string }[], myEmails: Set<string>) {
    const pending = new Map<string, { slug: string; sha: string }[]>();
    for (const commit of [...list].sort((a, b) => Number(b.branch === "origin/main") - Number(a.branch === "origin/main"))) {
      const email = commit.email.toLowerCase();
      const known = emailLogins.get(email);
      if (known && (known.login || Date.now() - known.at < LOGIN_RETRY_MS)) continue;
      const noreply = email.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/)?.[1];
      if (noreply || (login && email && myEmails.has(email))) { emailLogins.set(email, { login: noreply || login, at: Date.now() }); continue; }
      if (commit.slug) (pending.get(email) || pending.set(email, []).get(email)!).push({ slug: commit.slug, sha: commit.sha });
    }
    await Promise.all([...pending].map(async ([email, tries]) => {
      let who = "";
      for (const { slug, sha } of tries.slice(0, 2)) {
        who = (await exec("gh", ["api", `repos/${slug}/commits/${sha}`, "--jq", ".author.login // empty"]).catch(() => ({ stdout: "" }))).stdout.trim();
        if (who) break;
      }
      emailLogins.set(email, { login: who, at: Date.now() });
    }));
  }

  const checkSha = (sha: string) => { if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("Not a commit SHA."); return sha; };
  const checkSlug = (slug: string, number: number) => { if (!/^[\w.-]+\/[\w.-]+$/.test(slug) || !Number.isInteger(number)) throw new Error("Bad pull request."); };
  // A file path from the page: relative, inside the checkout, never an option.
  // A whole PR stack: from the bottom PR's base branch to the top PR's branch. `number` is the top PR, which versions the cache.
  const stackTarget = (params: URLSearchParams) => {
    const slug = params.get("slug") || "";
    const number = Number(params.get("number"));
    const [base, head] = [params.get("base") || "", params.get("head") || ""];
    checkSlug(slug, number);
    for (const branch of [base, head]) if (!/^[\w][\w./-]*$/.test(branch) || branch.includes("..")) throw new Error("Bad branch name.");
    return { slug, number, base, head, key: `${base}...${head}` };
  };
  const checkFile = (file: string) => { if (!file || file.startsWith("-") || file.startsWith("/") || file.split("/").includes("..")) throw new Error("Bad file path."); return file; };
  // gh's own stderr ("Could not resolve to a PullRequest…") says more than "Command failed: gh …".
  const gh = async (args: string[]) => (await exec("gh", args, { maxBuffer: 64 << 20 }).catch((error) => { throw new Error((error.stderr || "").trim().split("\n").pop() || error.message); })).stdout;

  async function commitDetail(repo: string, sha: string) {
    knownPath(repo);
    const [body, numstat] = await Promise.all([
      git(repo, ["show", "-s", "--format=%B", checkSha(sha)]),
      git(repo, ["show", "--format=", "--numstat", "-M", "--diff-merges=first-parent", sha]),
    ]);
    const files = numstat.trim().split("\n").filter(Boolean).map((line) => {
      const [additions, deletions, ...path] = line.split("\t");
      // Renames read "old => new" or "dir/{old => new}/file"; keep the new path.
      const name = path.join("\t").replace(/\{[^}]* => ([^}]*)\}/, "$1").replace(/^.* => /, "").replace(/\/\//g, "/");
      return { path: name, additions: Number(additions) || 0, deletions: Number(deletions) || 0 };
    });
    return { body: body.trim(), files };
  }

  // A commit named from a planning document (`<repo>@abc1234`) lives in the tracked checkout of that name, else
  // `code.checkoutsDir`/<name>; its GitHub slug is `github.owner`/<name>. The Code view passes a tracked path and slug instead.
  async function repoByName(name: string) {
    if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) throw new Error("Bad repository name.");
    const tracked = (await readRepos()).find((repo) => repo.split("/").pop()!.toLowerCase() === name.toLowerCase());
    const guess = join(config().code.checkoutsDir.replace(/^~(?=\/|$)/, process.env.HOME || ""), name);
    return tracked || (existsSync(join(guess, ".git")) ? guess : "");
  }

  async function commitTarget(params: URLSearchParams) {
    const sha = checkSha(params.get("sha") || "");
    const name = params.get("name") || "";
    let slug = params.get("slug") || (name && config().github.owner ? `${config().github.owner}/${name}` : "");
    if (slug && !/^[\w.-]+\/[\w.-]+$/.test(slug)) slug = "";
    const repo = name ? await repoByName(name) : knownPath(params.get("repo") || "");
    return { repo, slug, sha };
  }

  // Where a commit lives, so a link to it needs no trip to GitHub: the PRs that carry it, and up to five local branches with it.
  async function commitContext(repo: string, slug: string, sha: string) {
    const [pulls, refs] = await Promise.all([
      slug ? gh(["api", `repos/${slug}/commits/${sha}/pulls`]).then(JSON.parse).catch(() => []) : [],
      repo ? git(repo, ["for-each-ref", "--contains", sha, "--count=5", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"]).catch(() => "") : "",
    ]);
    const prs = pulls.map((pr: any) => ({ slug, number: pr.number, title: pr.title, state: pr.merged_at ? "Merged" : pr.state === "closed" ? "Closed" : pr.draft ? "Draft" : "Open", base: pr.base?.ref, head: pr.head?.ref }));
    const branches = [...new Set(refs.split("\n").filter(Boolean).map((ref: string) => ref.replace(/^origin\//, "")).filter((ref: string) => ref !== "HEAD" && ref !== "origin"))];
    return { prs, branches };
  }

  // A terse summary for hover cards and the diff overlay: local git first, GitHub when the commit isn't on this machine.
  async function commitSummary(params: URLSearchParams) {
    const { repo, slug, sha } = await commitTarget(params);
    const context = commitContext(repo, slug, sha);
    const local = repo ? await git(repo, ["show", "-s", "--shortstat", "--diff-merges=first-parent", "--format=%H%x1f%s%x1f%an%x1f%ct", sha]).catch(() => null) : null;
    if (local !== null) {
      const [head, ...rest] = local.trim().split("\n");
      const [full, subject, author, time] = head.split("\x1f");
      const stat = rest.join(" ");
      const num = (pattern: RegExp) => Number(stat.match(pattern)?.[1] || 0);
      return { sha: full, subject, author, time: Number(time) * 1000, files: num(/(\d+) files? changed/), additions: num(/(\d+) insertion/), deletions: num(/(\d+) deletion/), local: true, ...await context };
    }
    if (!slug) throw new Error("Commit not found.");
    const commit = JSON.parse(await gh(["api", `repos/${slug}/commits/${sha}`]).catch(() => { throw new Error(`${sha.slice(0, 8)} is not in a local checkout or on GitHub (${slug}).`); }));
    return { sha: commit.sha, subject: commit.commit.message.split("\n")[0], author: commit.commit.author?.name || commit.author?.login || "", time: new Date(commit.commit.author?.date).getTime(), files: commit.files?.length || 0, additions: commit.stats?.additions || 0, deletions: commit.stats?.deletions || 0, local: false, ...await context };
  }

  // Unified patch text for a commit, a worktree's uncommitted changes (tracked and untracked), or a pull request.
  async function diff(params: URLSearchParams) {
    const source = params.get("source");
    if (source === "commit") {
      const { repo, slug, sha } = await commitTarget(params);
      const local = repo ? await git(repo, ["show", "--format=", "-p", "-M", "--diff-merges=first-parent", "--no-color", sha]).catch(() => null) : null;
      if (local !== null) return { patch: local };
      if (!slug) throw new Error(`Commit ${sha.slice(0, 8)} is not in the local repository.`);
      return { patch: await gh(["api", "-H", "Accept: application/vnd.github.diff", `repos/${slug}/commits/${sha}`]) };
    }
    // "worktree" is uncommitted work; "branch" is everything since the fork from main, committed or not, plus new files.
    if (source === "worktree" || source === "branch") {
      const path = await knownWorktree(params.get("path") || "");
      const base = source === "branch" ? await branchBase(path) : "HEAD";
      const [tracked, added] = await Promise.all([
        git(path, ["-c", "core.fsmonitor=false", "diff", base, "-M", "--no-color"], { GIT_OPTIONAL_LOCKS: "0" }).catch(() => ""),
        untrackedPatch(path),
      ]);
      return { patch: tracked + added };
    }
    if (source === "pr" || source === "stack") {
      const { slug, number, refs } = await prRefs(params);
      const stack = source === "stack" ? stackTarget(params) : null;
      return { patch: await cachedPr(stack ? `stack-diff ${stack.key}` : "diff", slug, number, async () => {
        if (refs.repo) return (await exec("git", ["-C", refs.repo, "diff", "-M", "--no-color", refs.base, refs.head], { maxBuffer: 256 << 20 })).stdout;
        if (stack) return gh(["api", "-H", "Accept: application/vnd.github.diff", `repos/${slug}/compare/${stack.key}`]);
        return gh(["pr", "diff", String(number), "-R", slug, "--color", "never"]).catch((error) => {
          if (/too_large|exceeded the maximum/.test(error.message)) throw new Error(`This PR's diff is too large for GitHub to send; add a local clone of ${slug} to see it.`);
          throw error;
        });
      }) };
    }
    throw new Error("Unknown diff source.");
  }

  // One file's full text after the change, for rendering Markdown.
  async function fileContent(params: URLSearchParams) {
    const file = checkFile(params.get("file") || "");
    const source = params.get("source");
    if (source === "commit") {
      const { repo, slug, sha } = await commitTarget(params);
      const local = repo ? await git(repo, ["show", `${sha}:${file}`]).catch(() => null) : null;
      if (local !== null || !slug) return { text: local ?? "" };
      return { text: await gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${slug}/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`]) };
    }
    if (source === "worktree" || source === "branch") {
      // Also serves ignored local files from the overview's Local files list, so cap what a click can pull in.
      const target = join(await knownWorktree(params.get("path") || ""), file);
      if ((await stat(target)).size > 2 << 20) throw new Error(`${file} is over 2 MB; open it in an editor.`);
      return { text: await readFile(target, "utf8") };
    }
    if (source === "pr" || source === "stack") {
      const { slug, refs } = await prRefs(params);
      if (refs.repo) return { text: await git(refs.repo, ["show", `${refs.head}:${file}`]) };
      return { text: await gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${slug}/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${refs.head}`]) };
    }
    throw new Error("Unknown file source.");
  }

  // Both whole versions of one file, so the page can highlight with full context (a docstring opened before the hunk
  // stays a string). Anything missing or over 1 MB comes back null and the page falls back to highlighting the hunks alone.
  async function fileSides(params: URLSearchParams) {
    const file = checkFile(params.get("file") || "");
    const old = checkFile(params.get("old") || file);
    const source = params.get("source");
    const MAX = 1 << 20;
    const fit = (text: string | null) => (text !== null && text.length <= MAX ? text : null);
    const show = (cwd: string, spec: string) => git(cwd, ["show", spec]).catch(() => null);
    if (source === "commit") {
      const { repo, sha } = await commitTarget(params);
      if (!repo) return { old: null, new: null };
      return { old: fit(await show(repo, `${sha}^:${old}`)), new: fit(await show(repo, `${sha}:${file}`)) };
    }
    if (source === "worktree" || source === "branch") {
      const path = await knownWorktree(params.get("path") || "");
      const base = source === "branch" ? await branchBase(path) : "HEAD";
      return { old: fit(await show(path, `${base}:${old}`)), new: fit(await readFile(join(path, file), "utf8").catch(() => null)) };
    }
    if (source === "pr" || source === "stack") {
      const { slug, refs } = await prRefs(params);
      const raw = refs.repo ? (path: string, ref: string) => show(refs.repo, `${ref}:${path}`) : (path: string, ref: string) => gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${slug}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`]).catch(() => null);
      const [before, after] = await Promise.all([raw(old, refs.base), raw(file, refs.head)]);
      return { old: fit(before), new: fit(after) };
    }
    return { old: null, new: null };
  }

  // A PR's or stack's merge base and head. Both diffs compare against the merge base, so the old side is read there
  // rather than at the base tip. With a tracked clone everything resolves locally: the PR details already carry both
  // tips (a stack's branch tips come from `git ls-remote`), commits missing locally are fetched by SHA (no refs or
  // FETCH_HEAD written), and git finds the merge base. Without a clone, or if that fails, GitHub answers and repo is "".
  async function prRefs(params: URLSearchParams) {
    const stack = params.get("source") === "stack" ? stackTarget(params) : null;
    const slug = params.get("slug") || "";
    const number = Number(params.get("number"));
    checkSlug(slug, number);
    const refs = await cachedPr(stack ? `stack-refs ${stack.key}` : "refs", slug, number, async () => {
      const repo = await cloneFor(slug);
      if (repo) {
        try {
          let tips: (string | undefined)[];
          if (stack) {
            const remote = new Map((await git(repo, ["ls-remote", "origin", `refs/heads/${stack.base}`, `refs/heads/${stack.head}`])).trim().split("\n").map((line) => line.split("\t").reverse() as [string, string]));
            tips = [remote.get(`refs/heads/${stack.base}`), remote.get(`refs/heads/${stack.head}`)];
          } else {
            const detail = await prDetail(slug, number);
            tips = [detail.baseSha, detail.headSha];
          }
          const [base, head] = tips;
          if (base && head) {
            const missing = await Promise.all([base, head].map((sha) => git(repo, ["cat-file", "-e", `${sha}^{commit}`]).then(() => false, () => true)));
            if (missing.some(Boolean)) await git(repo, ["fetch", "--no-write-fetch-head", "--quiet", "--no-tags", "origin", head, base]);
            return { repo, base: (await git(repo, ["merge-base", base, head])).trim(), head };
          }
        } catch {}
      }
      const [base, head] = stack ? [stack.base, (await gh(["api", `repos/${slug}/commits/${stack.head}`, "--jq", ".sha"])).trim()]
        : (await gh(["api", `repos/${slug}/pulls/${number}`, "--jq", '.base.sha + " " + .head.sha'])).trim().split(" ");
      return { repo: "", base: (await gh(["api", `repos/${slug}/compare/${base}...${head}`, "--jq", ".merge_base_commit.sha"])).trim(), head };
    });
    return { slug, number, refs };
  }

  // Line counts of the given files on both sides of a diff, for sizing the change map. Needs a local clone; a PR's
  // commits are fetched into it by SHA when missing. Files absent on a side (added, deleted, binary) are left out.
  async function lineCounts(params: URLSearchParams, paths: string[]) {
    paths = paths.map(checkFile);
    const source = params.get("source");
    let repo = "";
    let before = "";
    let after = ""; // "" reads the working tree
    if (source === "commit") {
      ({ repo, sha: after } = await commitTarget(params));
      before = `${after}^`;
    } else if (source === "worktree" || source === "branch") {
      repo = await knownWorktree(params.get("path") || "");
      before = source === "branch" ? await branchBase(repo) : "HEAD";
    } else if (source === "pr" || source === "stack") {
      const { refs } = await prRefs(params);
      [repo, before, after] = [refs.repo, refs.base, refs.head];
    } else throw new Error("Unknown diff source.");
    if (!repo || !paths.length) return { before: {}, after: {} };
    const count = async (rev: string) => {
      const out = await git(repo, ["--literal-pathspecs", "grep", "-I", "-z", "-c", "-e", "", ...(rev ? [rev] : ["--untracked"]), "--", ...paths]).catch(() => "");
      const prefix = rev ? `${rev}:` : "";
      return Object.fromEntries(out.split("\n").filter(Boolean).map((line) => { const [path, n] = line.split("\0"); return [path.slice(prefix.length), Number(n)]; }));
    };
    const [old, now] = await Promise.all([count(before), count(after)]);
    return { before: old, after: now };
  }

  return { notes: prNotes, readRepos, githubSlug, load, localDir, prIndex, worktreeIndex, startBackgroundRefresh, commits, commitDetail, commitSummary, diff, fileContent, fileSides, lineCounts, worktreeDetail, prDetail, launchSession, addRepo, removeRepo, open, openPreview, startRun, runPr, stopRun, restartRun, allRuns, runLog, launchAgent, removeWorktrees, cleanupPrompt, launchCleanup };
}
