import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { taskFolderFiles } from "./task-files.ts";

test("a task folder walk skips symlinks, node_modules and dot folders", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "task-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, "checkout");
  await mkdir(join(outside, "deep"), { recursive: true });
  await writeFile(join(outside, "deep", "pkg.md"), "---\nstep: TASK-0001 W1\n---\n");
  const task = join(root, "TASK-0001");
  await mkdir(join(task, "break-it", "head", "node_modules", ".vite"), { recursive: true });
  await mkdir(join(task, ".cache"));
  await writeFile(join(task, "TASK-0001.md"), "# Task\n");
  await writeFile(join(task, "break-it", "report.md"), "# Report\n");
  await writeFile(join(task, "break-it", "head", "node_modules", ".vite", "results.json"), "{}");
  await writeFile(join(task, ".cache", "x.md"), "");
  await symlink(outside, join(task, "break-it", "node_modules"));
  await symlink(join(outside, "deep"), join(task, "linked"));
  assert.deepEqual((await taskFolderFiles(task)).sort(), ["TASK-0001.md", "break-it/report.md"]);
});
