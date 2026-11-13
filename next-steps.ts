// `plan-viewer next [--json]`: the steps flagged Up next (`{next}`), for an orchestrating agent thread to pick up.
// Each prints with who moves next, its task file and its prompt; the thread works it or spawns a session for it.
import { join } from "node:path";
import { ROOT, stepsIndex } from "./server.ts";

const steps = (await stepsIndex()).steps.filter((step) => step.next);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(steps.map(({ key, title, move, reason, kind, size, path, prompt }) => ({ key, title, move, reason, kind, size, path, prompt })), null, 2));
} else if (!steps.length) {
  console.log("Nothing is flagged Up next. Flag a step on the Steps page, or add `next` to its `{kind, size}` suffix.");
} else {
  for (const step of steps) {
    console.log(`## ${step.key}: ${step.title}`, `\n${step.move}${step.reason ? ` · ${step.reason}` : ""}${step.kind ? ` · ${step.kind}` : ""}${step.size ? ` · ${step.size}` : ""} · ${join(ROOT, step.path)}`);
    if (step.prompt) console.log(`\n${step.prompt}`);
    console.log("");
  }
}
