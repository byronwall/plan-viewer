import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseActions, parseWorkBreakdown, stalledTaskReason } from "./public/actions.js";
import { markdownFenceWarnings } from "./public/markdown.js";
import { isViewableDocumentPath, parseChunks, parseTaskDocument, ROOT } from "./server.ts";

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
  const git = async (argv: string[]) => (await promisify(execFile)("git", argv, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout;
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
    } catch (error) {
      // A tracked file moved or deleted without staging is no longer authored content.
      if (!args.length && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
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
