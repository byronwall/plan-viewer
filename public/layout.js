// The workspace layout on disk, shared by the server, the checks and the browser. Folder names are the content
// format, not configuration:
//
//   tasks/TASK-0101/TASK-0101.md   a task, with its assets and notes/ beside it
//   daily/2026-11-18.md            a day's plan
//   reference/                     prose people and agents read; reference/notes/ holds notes tied to no task
//   config/                        everything the tooling reads or writes (viewer.json, data files, prompts/)
//
// `plan-viewer migrate` (migrate.ts) is the only code that knows the older layout.

// Folders the library lists. config/ is not one of them.
export const DOC_ROOTS = ["daily", "tasks", "reference"];
export const CONFIG_DIR = "config";
export const CONFIG_FILE = "config/viewer.json";
export const configPath = (name) => `${CONFIG_DIR}/${name}`;

export const taskDir = (id) => `tasks/${id}`;
export const taskFile = (id) => `tasks/${id}/${id}.md`;
// The task a path belongs to: its own file or anything in its folder.
export const taskOfPath = (path) => path.match(/^tasks\/(TASK-\d{4})(?:\/|$)/)?.[1] || "";
export const isTaskFile = (path) => /^tasks\/(TASK-\d{4})\/\1\.md$/.test(path);
export const isTaskAsset = (path) => !!taskOfPath(path) && !isTaskFile(path) && path !== taskDir(taskOfPath(path));
// A path inside a task folder, relative to that folder: `tasks/TASK-0101/notes/a.md` → `notes/a.md`.
export const taskRelative = (path) => path.replace(/^tasks\/TASK-\d{4}\//, "");

export const dailyFile = (date) => `daily/${date}.md`;
export const dateOfPath = (path) => path.match(/^daily\/(\d{4}-\d{2}-\d{2})\.md$/)?.[1] || "";

export const notesFolder = (task) => task ? `${taskDir(task)}/notes` : "reference/notes";
