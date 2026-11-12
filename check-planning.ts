import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseActions, parseWorkBreakdown, stalledTaskReason } from "./public/actions.js";
import { markdownFenceWarnings } from "./public/markdown.js";
import { isViewableDocumentPath, parseChunks, parseTaskDocument, ROOT } from "./server.ts";
import { config } from "./public/config.js";
import { outboundFields } from "./outbound.ts";

const STEP_KINDS = new Set(["agent", "check-in", "decision", "byron", "pick-one", "pick-any", "do-all", "jira-issue", "jira-comment", "jira-edit", "jira-transition", "slack", "pr", "pr-comment", "review-request", "email"]);
const YOURS = new Set(["decision", "byron", "pick-one", "pick-any"]);
const DRAFT_STATUSES = new Set(["draft", "ready", "revise", "approved", "sent", "failed", "dropped"]);

// Steps (work-breakdown lines with an optional {kind, size}): known kinds, waiting only on others, choices made of
// options with one default, sizes on tasks created since steps.requireSizeFrom, no banned words in prompts.
export function stepErrors(task: { created: string } | undefined, nodes: { id: string; status: string; kind: string; size: string; flags: string[]; parent: string }[], prompts: { title: string; prompt: string }[]): string[] {
  const errors: string[] = [];
  const { requireSizeFrom = "", forbiddenInPrompts = [] } = config().steps;
  for (const node of nodes) {
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
  const [, task, id] = (fields.step || "").match(/^(TASK-\d{4})\s+(\S+)$/) || [];
  if (!task) { errors.push("outbound drafts name their step: `step: TASK-0000 W1.2`."); return errors; }
  if (!path.startsWith(`tasks/${task}-assets/`)) errors.push(`its step ${task} ${id} belongs to another task's assets.`);
  if (taskMarkdown === null) return errors;
  const node = parseWorkBreakdown(taskMarkdown.match(/^## Work breakdown\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] || "").nodes.find((n: { id: string }) => n.id === id);
  if (!node) errors.push(`its step ${task} ${id} isn't in that task's work breakdown.`);
  else if (fields.status === "sent" && node.status !== "completed") errors.push(`the draft is sent but ${task} ${id} is ${node.status}; mark the step completed.`);
  else if (node.status === "completed" && !["sent", "dropped"].includes(fields.status)) errors.push(`${task} ${id} is completed but its draft is ${fields.status}; mark the draft sent or dropped.`);
  return errors;
}

export function planningErrors(path: string, markdown: string): string[] {
  try {
    const parsed = /^tasks\/TASK-\d{4}\.md$/.test(path) ? parseTaskDocument(path, markdown) : undefined;
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
    if (parsed) errors.push(...stepErrors(parsed.task, work.nodes, actions));
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
  const paths = [...new Set(listed)].filter(path => path.endsWith(".md") && isViewableDocumentPath(path));
  if (args.length && !staged && paths.length !== new Set(listed).size) throw new Error("Pass authored Markdown paths under daily/, tasks/, plans/ or reference/ (outside the folders viewer.config.json excludes).");
  const errors: string[] = [];
  for (const path of paths) {
    try {
      const markdown = staged ? await git(["show", `:${path}`]) : await readFile(resolve(root, path), "utf8");
      errors.push(...planningErrors(path, markdown).map(error => `${path}: ${error}`));
      const step = outboundFields(markdown).step?.match(/^(TASK-\d{4})\s/)?.[1];
      if (step) {
        const taskMarkdown = await (staged ? git(["show", `:tasks/${step}.md`]) : readFile(resolve(root, `tasks/${step}.md`), "utf8")).catch(() => null);
        errors.push(...draftErrors(path, markdown, taskMarkdown).map(error => `${path}: ${error}`));
      }
    } catch (error) {
      // A tracked file moved or deleted without staging is no longer authored content.
      if (!args.length && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors.push(`${path}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "file not found" : error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { files: paths.length, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkPlanning(process.argv.slice(2));
    for (const error of result.errors) console.error(`error  ${error}`);
    if (!result.errors.length) console.log(`ok     ${result.files} planning Markdown files, no task, work-breakdown or action-reference errors`);
    process.exitCode = result.errors.length ? 1 : 0;
  } catch (error) {
    console.error(`error  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
