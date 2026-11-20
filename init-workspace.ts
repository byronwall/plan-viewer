// Set up a planning workspace: `plan-viewer init`, run from the workspace folder (or with PLANNING_ROOT set).
// Starts a git repository (the hook and lint need one), points its hooks at this checkout's hooks/, ignores what the
// viewer writes and the tokens in config.toml, creates the content folders, and copies the example agent guide with
// the real path to cli.ts in its commands. Nothing is installed: the workspace runs this checkout's cli.ts directly.
// Installed from npm (`npx plan-viewer init`), the viewer sits under node_modules or npx's cache, which can move: the
// guide's commands use `npx plan-viewer`, and the hook is copied into the workspace's .githooks/.
// Never replaces a file or setting; prints what it did and what it skipped.
import { execFileSync } from "node:child_process";
import { access, chmod, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fail = (message: string): never => { throw new Error(message); };

export async function initWorkspace(dir: string) {
  const viewer = await realpath(fileURLToPath(new URL(".", import.meta.url)));
  const root = await realpath(dir).catch(() => fail(`${dir} does not exist`));
  if (root === viewer) fail("this is the plan-viewer checkout; run init from your planning workspace");
  // The example guide assumes the workspace sits beside the checkout. Use a relative path when the two are close, so
  // moving both keeps working, and the absolute path when they are far apart.
  const npm = viewer.includes("/node_modules/");
  const near = relative(root, viewer);
  const base = near.split("/").filter(part => part === "..").length > 2 ? viewer : near;
  const cli = npm ? "npx plan-viewer" : `${base}/cli.ts`;
  const hooksDir = npm ? ".githooks" : `${base}/hooks`;
  const exists = (path: string) => access(join(root, path)).then(() => true, () => false);
  const done: string[] = [];
  const skipped: string[] = [];

  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let top = "";
  try { top = git(["rev-parse", "--show-toplevel"]); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("git is not installed"); }
  if (!top) { git(["init", "--quiet"]); done.push("started a git repository"); }
  else if (top === root) skipped.push("already a git repository");
  else skipped.push(`inside the git repository at ${top}; set its hooks path yourself`);
  // The hook lints staged plans with this checkout's cli.ts. A workspace with its own hooks path keeps it.
  if (!top || top === root) {
    let hooks = "";
    try { hooks = git(["config", "core.hooksPath"]); } catch { /* unset */ }
    if (hooks) skipped.push(`git hooks path is already ${hooks}`);
    else {
      if (npm && !await exists(".githooks/pre-commit")) {
        await mkdir(join(root, ".githooks"), { recursive: true });
        await copyFile(join(viewer, "hooks/pre-commit"), join(root, ".githooks/pre-commit"));
        await chmod(join(root, ".githooks/pre-commit"), 0o755);
        done.push("copied the pre-commit hook to .githooks/");
      }
      git(["config", "core.hooksPath", hooksDir]);
      done.push(`set the git hooks path to ${hooksDir}`);
    }
  }

  // tmp/ holds the viewer's caches; config.toml holds Linear and Slack tokens.
  const ignore = (await readFile(join(root, ".gitignore"), "utf8").catch(() => "")).split("\n");
  const bare = (line: string) => line.trim().replace(/^\/|\/$/g, "");
  const missing = ["tmp/", "config.toml"].filter(line => !ignore.some(other => bare(other) === bare(line)));
  if (missing.length) {
    await writeFile(join(root, ".gitignore"), [...ignore.filter((line, i) => line || i < ignore.length - 1), ...missing, ""].join("\n"));
    done.push(`added to .gitignore: ${missing.join(", ")}`);
  } else skipped.push(".gitignore covers tmp/, config.toml");

  for (const dir of ["config", "daily", "tasks", "reference"]) {
    if (await exists(dir)) skipped.push(`${dir}/ exists`);
    else { await mkdir(join(root, dir), { recursive: true }); done.push(`created ${dir}/`); }
  }

  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    if (await exists(file)) { skipped.push(`${file} exists`); continue; }
    const text = await readFile(join(viewer, "examples/workspace", file), "utf8");
    await writeFile(join(root, file), text.replace(" Copy this file into your own workspace and adjust it.", "").replaceAll("../plan-viewer/cli.ts", cli));
    done.push(`copied ${file}`);
  }

  return { done, skipped, cli };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error("Usage: plan-viewer init  (run from the workspace folder, or with PLANNING_ROOT set)");
    process.exit(1);
  }
  const root = resolve(process.env.PLANNING_ROOT || process.cwd());
  const { done, skipped, cli } = await initWorkspace(root).catch(error => {
    console.error(`plan-viewer init: ${error.message}`);
    process.exit(1);
  });
  for (const line of done) console.log(`✓ ${line}`);
  for (const line of skipped) console.log(`- skipped: ${line}`);
  console.log(`Next: run ${cli} here to start the viewer.`);
}
