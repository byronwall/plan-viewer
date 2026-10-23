#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// `plan-viewer [serve|lint|links|move|task] …`, run from a planning workspace (or with PLANNING_ROOT set).
import { fileURLToPath } from "node:url";

const COMMANDS: Record<string, string> = { serve: "server.ts", lint: "check-planning.ts", links: "check-links.ts", move: "move-doc.ts", task: "task-context.ts" };
const [command = "serve", ...args] = process.argv.slice(2);
if (!COMMANDS[command]) {
  console.error(`Usage: plan-viewer <${Object.keys(COMMANDS).join("|")}> [args]`);
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
  await import(script);
}
