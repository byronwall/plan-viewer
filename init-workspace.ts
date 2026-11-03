// Set up a planning workspace: `plan-viewer init`, run from the workspace folder (or with PLANNING_ROOT set).
// Creates the content folders, copies the example agent guide, and adds the viewer scripts to package.json.
// Never overwrites a file; prints what it did and what it skipped.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS: Record<string, string> = {
  viewer: "plan-viewer serve",
  lint: "plan-viewer lint",
  links: "plan-viewer links",
  move: "plan-viewer move",
  task: "plan-viewer task",
  prepare: "git config core.hooksPath node_modules/plan-viewer/hooks",
};

export async function initWorkspace(root: string) {
  const viewer = fileURLToPath(new URL(".", import.meta.url));
  const exists = (path: string) => access(join(root, path)).then(() => true, () => false);
  const done: string[] = [];
  const skipped: string[] = [];

  for (const dir of ["daily", "tasks", "plans", "reference"]) {
    if (await exists(dir)) skipped.push(`${dir}/ exists`);
    else { await mkdir(join(root, dir), { recursive: true }); done.push(`created ${dir}/`); }
  }

  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    if (await exists(file)) { skipped.push(`${file} exists`); continue; }
    const text = await readFile(join(viewer, "examples/workspace", file), "utf8");
    await writeFile(join(root, file), text.replace(" Copy this file into your own workspace and adjust it.", ""));
    done.push(`copied ${file}`);
  }

  const hasPackage = await exists("package.json");
  const pkg = hasPackage ? JSON.parse(await readFile(join(root, "package.json"), "utf8")) : { private: true, type: "module" };
  const added: string[] = [];
  if (!pkg.devDependencies?.["plan-viewer"] && !pkg.dependencies?.["plan-viewer"]) {
    pkg.devDependencies = { ...pkg.devDependencies, "plan-viewer": `file:${relative(root, viewer) || "."}` };
    added.push("plan-viewer dependency");
  }
  pkg.scripts ??= {};
  for (const [name, command] of Object.entries(SCRIPTS)) {
    if (pkg.scripts[name]) skipped.push(`package.json script "${name}" exists`);
    else { pkg.scripts[name] = command; added.push(`"${name}"`); }
  }
  if (added.length) {
    await writeFile(join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    done.push(`${hasPackage ? "added to" : "created"} package.json: ${added.join(", ")}`);
  }
  return { done, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(process.env.PLANNING_ROOT || process.cwd());
  const { done, skipped } = await initWorkspace(root);
  for (const line of done) console.log(`✓ ${line}`);
  for (const line of skipped) console.log(`- skipped: ${line}`);
  if (done.some(line => line.includes("package.json"))) console.log("Next: npm install (not pnpm), then npm run viewer.");
}
