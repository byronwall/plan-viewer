// The files in one task folder, as paths relative to it. Task folders also hold work products (a break-it run, a test
// harness), so this skips node_modules, dot folders and symlinks: a symlinked node_modules into a code checkout is a
// million files, and following it froze the Steps page.
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function taskFolderFiles(folder: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(folder, prefix), { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(entries.map((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : taskFolderFiles(folder, path);
    return entry.isFile() ? [path] : [];
  }));
  return found.flat();
}
