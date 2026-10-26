// Headless check of one page, for when the browser pane can't reach a preview (parallel sessions, refused ports).
//
//   npm install --no-save playwright-core && node scripts/check-page.mjs "/?path=tasks/TASK-0101.md" [--shot out.png] [--eval "js"] [--wait selector]
//
// Serves a temporary copy of examples/workspace (PLANNING_ROOT overrides) from this checkout on a free port, so it
// never depends on a shared server another session may have restarted. Prints console errors, the --eval result as
// JSON, and where the screenshot went. Drives installed Google Chrome, like scripts/screenshots.mjs.
import { spawn } from "node:child_process";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const repo = fileURLToPath(new URL("..", import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: { shot: { type: "string" }, eval: { type: "string" }, wait: { type: "string" } } });
const path = positionals[0] ?? "/";

const workspace = process.env.PLANNING_ROOT ? resolve(process.env.PLANNING_ROOT) : await mkdtemp(join(tmpdir(), "plan-viewer-check-"));
if (!process.env.PLANNING_ROOT) await cp(join(repo, "examples/workspace"), workspace, { recursive: true });
const server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(repo, "server.ts")], { env: { ...process.env, PLANNING_ROOT: workspace, PLAN_VIEWER_PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
const base = await new Promise((done) => server.stdout.on("data", (chunk) => { const url = /is ready .* at (\S+)/.exec(chunk)?.[1]; if (url) done(url); }));

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (message) => message.type() === "error" && console.log(`console error: ${message.text()} ${message.location().url}`));
  page.on("pageerror", (error) => console.log(`page error: ${error.message}`));
  await page.goto(new URL(path, base).href);
  if (values.wait) await page.waitForSelector(values.wait, { timeout: 60000 });
  await page.waitForTimeout(900);
  if (values.eval) console.log(JSON.stringify(await page.evaluate(values.eval), null, 2));
  if (values.shot) { await page.screenshot({ path: values.shot }); console.log(`screenshot: ${resolve(values.shot)}`); }
} finally {
  await browser.close();
  server.kill();
}
