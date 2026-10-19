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
process.argv = [process.argv[0], script, ...args];
await import(script);
