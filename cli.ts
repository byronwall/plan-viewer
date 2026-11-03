#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// `plan-viewer [serve|init|lint|links|move|task] …`, run from a planning workspace (or with PLANNING_ROOT set).
import { fileURLToPath } from "node:url";

const COMMANDS: Record<string, string> = { serve: "server.ts", lint: "check-planning.ts", links: "check-links.ts", move: "move-doc.ts", task: "task-context.ts", init: "init-workspace.ts" };
const HELP = `Usage: plan-viewer <command> [args], run from a planning workspace (or with PLANNING_ROOT set)

  serve                                     open the viewer (the default)
  init                                      set up this folder as a workspace
  lint [paths | --staged]                   check task front matter, work breakdowns and next actions
  links [--fix | --warm | --refresh-slack]  check links and task IDs
  move <from> <to | TASK-NNNN>              move a file and repair the links to it
  task <TASK-NNNN>                          print a task's context for an agent`;
const [command = "serve", ...args] = process.argv.slice(2);
if (["help", "--help", "-h"].includes(command)) {
  console.log(HELP);
  process.exit(0);
}
if (!COMMANDS[command]) {
  console.error(HELP);
  process.exit(1);
}
// Each script runs itself when it is argv[1], so hand it the argv it would get from `node <script> …`.
const script = fileURLToPath(new URL(COMMANDS[command], import.meta.url));
// `serve` runs the server under `node --watch`, which restarts it when any file it loaded changes (the viewer's own
// *.ts and the shared public/*.js modules), so pulling or editing the viewer needs no manual restart.
// PLAN_VIEWER_WATCH=0 runs it directly.
if (command === "serve" && process.env.PLAN_VIEWER_WATCH !== "0" && !process.env.PLAN_VIEWER_WATCHED) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", "--watch", "--watch-preserve-output", script, ...args], { stdio: "inherit", env: { ...process.env, PLAN_VIEWER_WATCHED: "1" } });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
} else {
  process.argv = [process.argv[0], script, ...args];
  try {
    await import(script);
  } catch (error) {
    // A plain Error or a system error (ENOENT, a failed git) is the user's to fix: one line. A TypeError and the like is a bug: keep the stack.
    if (error?.constructor !== Error && !error?.code) throw error;
    console.error(`plan-viewer ${command}: ${error.message.trim()}`);
    process.exit(1);
  }
}
