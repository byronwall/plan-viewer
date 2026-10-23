// Regenerates the README screenshots in docs/images/ from the example workspace.
//
//   npm install --no-save playwright-core && node scripts/screenshots.mjs [name,name…]
//
// Drives installed Google Chrome (playwright-core's `chrome` channel), so no browser download is needed. The server
// runs against a temporary copy of examples/workspace that also tracks this repository, so the Code view has real
// commits to show. Shots are 1440×900 at 1.5x; run `oxipng -o 4 --strip safe docs/images/*.png` afterwards if you have it.
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repo = fileURLToPath(new URL("..", import.meta.url));
const out = join(repo, "docs/images");
const port = 4199;
const base = `http://127.0.0.1:${port}`;
const only = process.argv[2]?.split(",");

const workspace = await mkdtemp(join(tmpdir(), "plan-viewer-shots-"));
await cp(join(repo, "examples/workspace"), workspace, { recursive: true });
await writeFile(join(workspace, "reference/code-repos.json"), JSON.stringify({ repos: [repo] }));
const config = JSON.parse(await readFile(join(workspace, "viewer.config.json"), "utf8"));
config.issues.command = ["node", join(repo, "fixtures/jira/fake-acli.js")];
await writeFile(join(workspace, "viewer.config.json"), JSON.stringify(config, null, 2));

const server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(repo, "server.ts")], { env: { ...process.env, PLANNING_ROOT: workspace, PLAN_VIEWER_PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => server.stdout.on("data", (chunk) => /is ready/.test(chunk) && resolve()));

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: "light" });
const settle = () => page.waitForTimeout(900);
const codeReady = async (tab) => {
  await page.goto(`${base}/?view=code&tab=${tab}`);
  await page.waitForSelector('[data-code-state="ready"]', { timeout: 60000 });
  await page.waitForTimeout(3000);
};

const shots = {
  today: async () => { await page.goto(base); await settle(); },
  action: async () => {
    await page.goto(base); await settle();
    await page.locator(".action-card:visible").first().click(); await settle();
  },
  task: async () => {
    await page.goto(`${base}/?path=tasks/TASK-0101.md`); await settle();
    await page.evaluate(() => {
      const heading = [...document.querySelectorAll("h2, h3")].find((el) => /Work breakdown/.test(el.textContent));
      window.scrollTo({ top: (heading?.getBoundingClientRect().top ?? 0) + scrollY - 90, behavior: "instant" });
    });
    await settle();
  },
  tasks: async () => { await page.goto(`${base}/?view=tasks`); await settle(); },
  weeks: async () => { await page.goto(`${base}/?view=weeks&date=2026-10-19`); await settle(); },
  palette: async () => {
    await page.goto(base); await settle();
    await page.keyboard.press("Meta+k"); await page.waitForTimeout(300);
    await page.keyboard.type("invite"); await settle();
  },
  issues: async () => {
    await page.goto(`${base}/?view=issues`);
    await page.waitForSelector('[data-issues-state="ready"]', { timeout: 60000 }); await settle();
  },
  // The diff overlay for the newest commit that touches several files.
  diff: async () => {
    await codeReady("commits");
    await page.locator(".code-surface tbody tr").filter({ hasText: /\b[3-9]\b/ }).first().dblclick();
    await page.waitForTimeout(3500);
  },
};

try {
  for (const [name, run] of Object.entries(shots)) {
    if (only && !only.includes(name)) continue;
    await run();
    await page.screenshot({ path: join(out, `${name}.png`) });
    console.log(`docs/images/${name}.png`);
  }
} finally {
  await browser.close();
  server.kill();
  await rm(workspace, { recursive: true, force: true });
}
