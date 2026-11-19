import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseActions, parseWorkBreakdown, stalledTaskReason } from "./public/actions.js";
import { markdownFenceWarnings, parseUpdates } from "./public/markdown.js";
import { isViewableDocumentPath, parseChunks, parseTaskDocument, ROOT } from "./server.ts";
import { config } from "./public/config.js";
import { isTaskFile, taskDir, taskFile, taskOfPath } from "./public/layout.js";
import { outboundFields } from "./outbound.ts";

const STEP_KINDS = new Set(["agent", "check-in", "decision", "byron", "pick-one", "pick-any", "do-all", "jira-issue", "jira-comment", "jira-edit", "jira-transition", "it-ticket", "slack", "pr", "pr-comment", "review-request", "email"]);
const YOURS = new Set(["decision", "byron", "pick-one", "pick-any"]);
const DRAFT_STATUSES = new Set(["draft", "ready", "revise", "approved", "sent", "failed", "dropped"]);
// The PR targets the workspace's outbound.py sender can parse (repo_pr): #2233, PyRel#3929, Owner/repo#1, or a PR URL.
const PR_TARGET = /^(?:(?:[\w.-]+\/)?[\w.-]+)?#\d+$|^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?:[/?#].*)?$/;

// References a reader has to look up: issue and task keys (ABC-123), PRs (#12, repo#12), steps (W1.2), commits (repo@sha).
const REFERENCE = /\b[A-Z][A-Z0-9]+-\d+\b|(?:\b[\w.-]+)?#\d+\b|\bW\d+(?:\.\d+)*\b|\b[\w.-]+@[0-9a-f]{7,40}\b/g;
const FILLER = new Set("a an and or the to of on in at by for from with is are be it its this that as once then now not".split(" "));

// The references in a step title or diagram label that come without enough words to say what they are: fewer than two
// words per reference, after dropping the references themselves, link targets and filler words. Empty when grounded.
export function ungroundedReferences(text: string): string[] {
  const plain = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const references = plain.match(REFERENCE) || [];
  const words = plain.replace(REFERENCE, " ").match(/[A-Za-z][A-Za-z0-9'’-]*/g)?.filter(word => !FILLER.has(word.toLowerCase())) || [];
  return words.length >= 2 * references.length ? [] : references;
}

const GROUNDING_HINT = "give each reference two or three words saying what it is (“#2282 lost Settings save reply”, “RAI-55557 · role can't read data”)";

// Generated-sounding copy in a diagram's headings: the drawing describing itself or its own layout, notes from the
// brief that leaked into the text, filler and hedges. Each pattern is narrow on purpose (a data "row", an "API key",
// a "Hero Journey" product name all pass), so a hit is nearly always a line a reader would rewrite.
const VOICE_PATTERNS: [string, RegExp][] = [
  ["points at the drawing instead of saying something", /\b(?:this|the|each|every|next|previous|other) (?:diagram|chart|figure|drawing|picture|graphic|visual|slide)s?\b|\b(?:diagram|figure|chart)s? \d+\b|\b\d{1,2}(?: and \d{1,2})? shows?\b|\b(?:the|these|red|green|amber|gr[ae]y) (?:boxes|arrows|lanes) (?:show|mean)\b/i],
  ["narrates the layout", /\b(?:up top|down below|(?:at|on|along) the (?:top|bottom|left|right)|(?:from )?left to right|(?:from )?top to bottom|happy path (?:first|on top|up top)|then the (?:edge|corner) cases|(?:shown|listed|drawn|laid out) (?:here|below|above)|(?:breaks?|fails?|go(?:es)?|is|are|sits?|follows?|comes?) (?:above|below)(?=\s*(?:[,;.:]|$)))/i],
  ["reads like notes from the brief", /\b(?:at a glance|tl;?dr|(?:key |the |one )?takeaways?|in (?:\w+'s|my|your|their) voice|plain(?:er)? (?:language|wording)|as requested|per the brief|for the reader|what (?:you|everybody|everyone|readers?) (?:needs?|should) (?:to )?know|(?:an )?overview of|here's|here (?:is|are)|(?:this|it) (?:shows|illustrates|depicts|visuali[sz]es|highlights|summari[sz]es)|(?:illustrat|depict|visuali[sz])(?:es|ing|ed))\b/i],
  ["uses filler", /\b(?:key (?:takeaways?|points?|insights?|flows?|concepts?|ideas?|findings?|players?|aspects?|elements?|considerations?|moments?)|comprehensive\w*|seamless\w*|robust(?:ly|ness)?|holistic\w*|leverag(?:e|es|ed|ing)|streamlin\w*|utili[sz]\w*|high-level|deep dive|delve\w*|crucial(?:ly)?|pivotal|myriad|nuanced)\b/i],
  ["hedges", /\b(?:potentially|arguably|essentially|basically|somewhat|generally speaking|it (?:seems|appears)|may (?:potentially|possibly)|might possibly|could potentially|to some extent)\b/i],
];
const VOICE_HINT = "say the finding itself, as you'd tell a teammate (“Models deployed before Sep 15 have no identity marker, and teardown refuses them”, not “The happy path first, then the three edge cases that break it”)";

// What reads as generated in one heading (title, subtitle, group title or legend entry): each problem and the words
// that matched. Empty when it reads as written.
export function voiceProblems(text: string): string[] {
  return VOICE_PATTERNS.flatMap(([problem, pattern]) => {
    const hit = text.match(pattern);
    return hit ? [`${problem} (“${hit[0]}”)`] : [];
  });
}

// Every title, subtitle, box, group, edge label and note in a .draft diagram says what its references are, and its
// headings (title, subtitle, group titles, legend) don't read as generated.
export function diagramErrors(source: string): string[] {
  const errors: string[] = [];
  source.split("\n").forEach((line, index) => {
    const match = line.match(/^\s*[+\-~.]?(diagram|subtitle|node|group|edge|note|footnote|legend)\b[^"]*("(?:[^"\\]|\\.)*")/);
    if (!match) return;
    let label: string;
    try { label = JSON.parse(match[2]).replaceAll("\n", " "); } catch { return; }
    const bare = match[1] === "legend" ? [] : ungroundedReferences(label);
    if (bare.length) errors.push(`line ${index + 1}: “${label}” names ${bare.join(", ")} without saying what ${bare.length > 1 ? "they are" : "it is"}; ${GROUNDING_HINT}.`);
    const voice = ["diagram", "subtitle", "group", "legend"].includes(match[1]) ? voiceProblems(label) : [];
    if (voice.length) errors.push(`line ${index + 1}: ${match[1]} “${label}” ${voice.join(" and ")}; ${VOICE_HINT}.`);
  });
  return errors;
}

// Steps (work-breakdown lines with an optional {kind, size}): known kinds, waiting only on others, choices made of
// options with one default, sizes on tasks created since steps.requireSizeFrom, references that say what they are on
// tasks created since steps.groundReferencesFrom, no banned words in prompts.
export function stepErrors(task: { created: string } | undefined, nodes: { id: string; title: string; status: string; kind: string; size: string; flags: string[]; parent: string }[], prompts: { title: string; prompt: string }[]): string[] {
  const errors: string[] = [];
  const { requireSizeFrom = "", groundReferencesFrom = "", forbiddenInPrompts = [] } = config().steps;
  for (const node of nodes) {
    const bare = groundReferencesFrom && task && task.created >= groundReferencesFrom ? ungroundedReferences(node.title) : [];
    if (bare.length) errors.push(`${node.id}: “${node.title}” names ${bare.join(", ")} without saying what ${bare.length > 1 ? "they are" : "it is"}; ${GROUNDING_HINT}, so the step reads on its own.`);
    if (node.kind && !STEP_KINDS.has(node.kind)) errors.push(`${node.id}: unknown step kind “${node.kind}”. Use one of: ${[...STEP_KINDS].join(", ")}.`);
    if (node.status === "waiting" && YOURS.has(node.kind)) errors.push(`${node.id}: [waiting] means waiting on someone else; a ${node.kind} step waits on you, so write it [open].`);
    const children = nodes.filter((child) => child.parent === node.id);
    if (node.kind === "pick-one" || node.kind === "pick-any") {
      if (children.length < 2 || children.some((child) => !child.flags.includes("option"))) errors.push(`${node.id}: a choice needs two or more children marked {option}.`);
      if (node.status !== "completed" && children.filter((child) => child.flags.includes("recommended")).length !== 1) errors.push(`${node.id}: mark exactly one option {option, recommended}.`);
    }
    const isOption = ["pick-one", "pick-any"].includes(nodes.find((n) => n.id === node.parent)?.kind || "");
    if (requireSizeFrom && task && task.created >= requireSizeFrom && !["completed", "deferred"].includes(node.status) && !node.size && !children.length && !isOption) errors.push(`${node.id}: open steps in tasks created since ${requireSizeFrom} need a size: {kind, S|M|L}.`);
  }
  for (const word of forbiddenInPrompts) for (const action of prompts) if (action.prompt.includes(word)) errors.push(`Action “${action.title}” names ${word}; use the workspace's helper instead.`);
  return errors;
}

// An outbound draft's front matter, and whether its step agrees: a sent draft's step is completed, and a completed
// step's draft is sent or dropped.
export function draftErrors(path: string, text: string, taskMarkdown: string | null): string[] {
  const fields = outboundFields(text);
  if (!fields.outbound) return [];
  const errors: string[] = [];
  if (!STEP_KINDS.has(fields.outbound) || YOURS.has(fields.outbound) || fields.outbound === "agent" || fields.outbound === "check-in") errors.push(`unknown outbound kind “${fields.outbound}”.`);
  if (!DRAFT_STATUSES.has(fields.status)) errors.push(`outbound status must be one of ${[...DRAFT_STATUSES].join(", ")}.`);
  if (["pr-comment", "review-request"].includes(fields.outbound) && !PR_TARGET.test((fields.target || "").trim())) errors.push(`target “${fields.target || ""}” isn't a PR the sender can parse: #2233, PyRel#3929 or https://github.com/RelationalAI/modeler/pull/2233.`);
  const [, task, id] = (fields.step || "").match(/^(TASK-\d{4})\s+(\S+)$/) || [];
  if (!task) { errors.push("outbound drafts name their step: `step: TASK-0000 W1.2`."); return errors; }
  if (!path.startsWith(`${taskDir(task)}/`) || isTaskFile(path)) errors.push(`its step ${task} ${id} belongs to another task's folder.`);
  if (taskMarkdown === null) return errors;
  const node = parseWorkBreakdown(taskMarkdown.match(/^## Work breakdown\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] || "").nodes.find((n: { id: string }) => n.id === id);
  if (!node) errors.push(`its step ${task} ${id} isn't in that task's work breakdown.`);
  else if (fields.status === "sent" && node.status !== "completed") errors.push(`the draft is sent but ${task} ${id} is ${node.status}; mark the step completed.`);
  else if (node.status === "completed" && !["sent", "dropped"].includes(fields.status)) errors.push(`${task} ${id} is completed but its draft is ${fields.status}; mark the draft sent or dropped.`);
  return errors;
}

// A completed task is a closed record; new work belongs in a live task. Given a task at HEAD and in the commit, plus the
// assets the commit adds under its folder, say what the commit piles onto a task that was already completed: dated
// updates, steps that aren't completed or deferred, and assets other than saved notes. Reopening the task (any other
// status) or retiring it (the `retired` tag arrives) is the deliberate way to touch one, so neither warns. A warning
// never blocks the commit: a late closing note can be right, but it should be a choice.
export function completedTaskWarnings(path: string, before: string | null, after: string | null, addedAssets: string[] = []): string[] {
  if (!before || !after) return [];
  const read = (markdown: string) => {
    const { task, body } = parseTaskDocument(path, markdown);
    const chunks = parseChunks(body);
    const updates = parseUpdates(chunks.find((chunk) => /^updates$/i.test(chunk.title))?.markdown || "").entries.map((entry) => `${entry.date} ${entry.title}`.trim());
    const open = parseWorkBreakdown(chunks.find((chunk) => /^work breakdown$/i.test(chunk.title))?.markdown || "").nodes.filter((node) => !["completed", "deferred"].includes(node.status)).map((node) => node.id);
    return { task, updates, open };
  };
  let old, now;
  try { old = read(before); now = read(after); } catch { return []; }
  if (old.task.status !== "completed" || now.task.status !== "completed") return [];
  if (now.task.tags.includes("retired") && !old.task.tags.includes("retired")) return [];
  const updates = now.updates.filter((entry) => !old.updates.includes(entry));
  const open = now.open.filter((id) => !old.open.includes(id));
  const assets = addedAssets.filter((asset) => !/\/notes\//.test(asset));
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const added = [
    updates.length && `${plural(updates.length, "dated update")} (${updates.map((entry) => entry.slice(0, 60)).join("; ")})`,
    open.length && `${plural(open.length, "open step")} (${open.join(", ")})`,
    assets.length && `${plural(assets.length, "asset")} (${assets.slice(0, 3).map((asset) => asset.split("/").slice(2).join("/")).join(", ")}${assets.length > 3 ? ", …" : ""})`,
  ].filter(Boolean);
  if (!added.length) return [];
  return [`${now.task.id} is completed, but this commit adds ${added.join(", ")}. Put new work in a new or live task and link it from here, or reopen this one; retiring it with a \`retired\` tag is fine.`];
}

export function planningErrors(path: string, markdown: string): string[] {
  try {
    const parsed = isTaskFile(path) ? parseTaskDocument(path, markdown) : undefined;
    const body = parsed ? parsed.body : markdown;
    const chunks = parseChunks(body);
    const work = parseWorkBreakdown(chunks.find(chunk => /^work breakdown$/i.test(chunk.title))?.markdown || "");
    const errors = [...work.warnings, ...markdownFenceWarnings(markdown)];
    const actions = chunks.filter(chunk => /^(next actions|next steps)$/i.test(chunk.title)).flatMap(chunk => parseActions(chunk.markdown, path));
    for (const action of actions) {
      if (action.workItem && !work.nodes.some(node => node.id === action.workItem)) {
        errors.push(`Action “${action.title}” references missing or invalid work item ${action.workItem}.`);
      }
    }
    const stalled = parsed ? stalledTaskReason(parsed.task.status, actions, work) : "";
    if (stalled) errors.push(stalled);
    if (parsed) {
      errors.push(...stepErrors(parsed.task, work.nodes, actions));
      const updates = chunks.find((chunk) => /^updates$/i.test(chunk.title));
      if (updates) errors.push(...parseUpdates(updates.markdown).warnings);
    }
    return errors;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

// Read the index for commits; reading the working tree would miss partially staged errors.
export async function checkPlanning(args: string[], root = ROOT) {
  const staged = args.includes("--staged");
  if (args.some(arg => arg.startsWith("--") && arg !== "--staged") || (staged && args.length !== 1)) {
    throw new Error("Usage: npm run lint -- [planning Markdown paths | --staged]");
  }
  const git = async (argv: string[]) => (await promisify(execFile)("git", argv, { cwd: root, maxBuffer: 16 * 1024 * 1024 }).catch(error => {
    throw /not a git repository/.test(error.stderr) ? new Error("not a git repository; run plan-viewer init") : error;
  })).stdout;
  const listed = args.length && !staged
    ? args.map(path => relative(root, resolve(root, path)).replaceAll("\\", "/"))
    : (await git(staged ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"] : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  // The older layout (tasks/TASK-NNNN.md, -assets folders, daily/YYYY/MM/DD/, plans/, viewer.config.json) is not read at all.
  const old = listed.find((path) => /^tasks\/TASK-\d{4}(\.md|-assets\/)|^daily\/\d{4}\/|^plans\/|^viewer\.config\.json$/.test(path))
    || (await access(resolve(root, "viewer.config.json")).then(() => "viewer.config.json", () => ""));
  if (old) return { files: 0, errors: [`${old}: this workspace uses the older folder layout. Run plan-viewer migrate, fix what it lists, then plan-viewer migrate --write.`], warnings: [] };
  const paths = [...new Set(listed)].filter(path => path.endsWith(".md") && isViewableDocumentPath(path));
  // Diagrams are checked when they are staged or named, so a diagram you touch gets grounded and old ones don't fail
  // the full-corpus run.
  const diagrams = (staged || args.length) && config().steps.groundReferencesFrom ? [...new Set(listed)].filter(path => path.endsWith(".draft")) : [];
  if (args.length && !staged && paths.length + diagrams.length !== new Set(listed).size) throw new Error("Pass authored Markdown paths under daily/, tasks/ or reference/ (outside the folders config/viewer.json excludes).");
  const errors: string[] = [];
  for (const path of diagrams) {
    try {
      const source = staged ? await git(["show", `:${path}`]) : await readFile(resolve(root, path), "utf8");
      errors.push(...diagramErrors(source).map(error => `${path}: ${error}`));
    } catch (error) {
      errors.push(`${path}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "file not found" : error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const path of paths) {
    try {
      const markdown = staged ? await git(["show", `:${path}`]) : await readFile(resolve(root, path), "utf8");
      errors.push(...planningErrors(path, markdown).map(error => `${path}: ${error}`));
      const step = outboundFields(markdown).step?.match(/^(TASK-\d{4})\s/)?.[1];
      if (step) {
        const taskMarkdown = await (staged ? git(["show", `:${taskFile(step)}`]) : readFile(resolve(root, taskFile(step)), "utf8")).catch(() => null);
        errors.push(...draftErrors(path, markdown, taskMarkdown).map(error => `${path}: ${error}`));
      }
    } catch (error) {
      // A tracked file moved or deleted without staging is no longer authored content.
      if (!args.length && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors.push(`${path}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "file not found" : error instanceof Error ? error.message : String(error)}`);
    }
  }
  const warnings: string[] = [];
  if (staged) {
    const added = (await git(["diff", "--cached", "--name-only", "--diff-filter=A", "-z"])).split("\0").filter(Boolean);
    const assetsOf = new Map<string, string[]>();
    for (const path of added) {
      const id = taskOfPath(path);
      if (id && !isTaskFile(path)) assetsOf.set(id, [...(assetsOf.get(id) || []), path]);
    }
    const ids = new Set([...listed.filter(isTaskFile).map(taskOfPath), ...assetsOf.keys()]);
    for (const id of ids) {
      const path = taskFile(id);
      const [before, after] = await Promise.all([git(["show", `HEAD:${path}`]).catch(() => null), git(["show", `:${path}`]).catch(() => null)]);
      warnings.push(...completedTaskWarnings(path, before, after, assetsOf.get(id)).map((warning) => `${path}: ${warning}`));
    }
  }
  return { files: paths.length + diagrams.length, errors, warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkPlanning(process.argv.slice(2));
    for (const error of result.errors) console.error(`error  ${error}`);
    for (const warning of result.warnings) console.error(`warn   ${warning}`);
    if (!result.errors.length) console.log(`ok     ${result.files} planning files, no task, work-breakdown, action-reference or bare-reference errors`);
    process.exitCode = result.errors.length ? 1 : 0;
  } catch (error) {
    console.error(`error  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
