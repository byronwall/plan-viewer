// Takes the screenshots for the Pages site (site/images/*.webp) from the example workspace.
//
//   npm install --no-save playwright-core && node scripts/site-screenshots.mjs [name,name…]
//
// Like screenshots.mjs, it drives installed Chrome against a temporary copy of examples/workspace. The Code view and
// Plans page track a temporary `atlas` repository built from fixtures/plans, so every row is fictional. Diagrams draw
// through `npx draftably`. Numbered marks on a shot match the numbered list under it on the site. Needs `cwebp`.
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { sampleChatThreads } from "./chat-threads-sample.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const out = join(repo, "site/images");
const port = 4198;
const base = `http://127.0.0.1:${port}`;
const only = process.argv[2]?.split(",");

// A short path, since the worktree overview prints it.
const root = await mkdtemp("/tmp/acme-");
const workspace = join(root, "planning");
const atlas = join(root, "atlas");
const pngs = join(root, "png");
await mkdir(pngs);
await cp(join(repo, "examples/workspace"), workspace, { recursive: true });

// A fictional repository: the Plans fixtures on origin/main, a few commits, and a feature worktree with an edit.
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=Alex Kim", "-c", "user.email=alex@acme.test", ...args]);
await cp(join(repo, "fixtures/plans/docs"), join(atlas, "docs"), { recursive: true });
await rm(join(atlas, "docs/intent/broken"), { recursive: true, force: true });
await mkdir(join(atlas, "src"), { recursive: true });
await writeFile(join(atlas, "README.md"), "# Atlas\n\nThe Atlas web app.\n");
git(root, "init", "-q", "-b", "main", atlas);
git(atlas, "add", ".");
git(atlas, "commit", "-qm", "Plans for offline mode and ledger sync");
await writeFile(join(atlas, "src/invites.ts"), "export function createInvite(email: string) {\n  return { email, token: crypto.randomUUID(), expires: Date.now() + 7 * 864e5 };\n}\n");
await writeFile(join(atlas, "src/mailer.ts"), "export async function send(to: string, body: string) {\n  console.log(to, body);\n}\n");
git(atlas, "add", ".");
git(atlas, "commit", "-qm", "Invite model and mailer stub");
await writeFile(join(atlas, "src/invites.ts"), "import { send } from \"./mailer.ts\";\n\nconst WEEK = 7 * 864e5;\n\nexport async function createInvite(email: string) {\n  const invite = { email, token: crypto.randomUUID(), expires: Date.now() + WEEK };\n  await send(email, `Join Atlas: https://atlas.acme.test/join/${invite.token}`);\n  return invite;\n}\n");
await writeFile(join(atlas, "src/invites.test.ts"), "import { createInvite } from \"./invites.ts\";\n\ntest(\"an invite expires in a week\", async () => {\n  const invite = await createInvite(\"sam@acme.test\");\n  expect(invite.expires - Date.now()).toBeGreaterThan(6 * 864e5);\n});\n");
await writeFile(join(atlas, "docs/intent/offline-mode/plan.md"), (await readFile(join(atlas, "docs/intent/offline-mode/plan.md"), "utf8")) + "\n## Invites\n\nInvites send through the mailer.\n");
git(atlas, "add", ".");
git(atlas, "commit", "-qm", "Send the invite email through the mailer");
git(atlas, "update-ref", "refs/remotes/origin/main", "HEAD");
git(atlas, "worktree", "add", "-q", "-b", "alex/pending-invites", join(root, "atlas-pending-invites"));
const wt = join(root, "atlas-pending-invites");
await writeFile(join(wt, "src/pending.ts"), "export const pendingInvites = (invites: { expires: number }[]) => invites.filter((i) => i.expires > Date.now());\n");
await writeFile(join(wt, "src/invites.ts"), (await readFile(join(wt, "src/invites.ts"), "utf8")).replace("const WEEK = 7 * 864e5;", "const WEEK = 7 * 864e5;\nexport const RESEND_AFTER = 864e5;"));
git(wt, "add", ".");
git(wt, "commit", "-qm", "List pending invites and allow a resend after a day");
await writeFile(join(wt, "src/pending.ts"), (await readFile(join(wt, "src/pending.ts"), "utf8")) + "// TODO: sort by expiry\n");

await writeFile(join(workspace, "config/code-repos.json"), JSON.stringify({ repos: [atlas] }));
const config = JSON.parse(await readFile(join(workspace, "config/viewer.json"), "utf8"));
config.issues.command = ["node", join(repo, "fixtures/jira/fake-acli.js")];
config.diagrams = { command: ["npx", "-y", "draftably@0.16.0"] };
await writeFile(join(workspace, "config/viewer.json"), JSON.stringify(config, null, 2));

// One outbound draft, so the Outbox has something to approve.
await writeFile(join(workspace, "tasks/TASK-0105/flaky-spec-comment.md"), `---
outbound: jira-comment
target: OPS-100
status: ready
step: TASK-0105 W3
send: manual
---

# Comment on OPS-100 with the quarantined specs

Priya asked for the failure rates before she moves the specs back.

<!-- send:start -->
Three specs moved to the quarantine suite today:

- \`invites/accept.spec.ts\`: failed 9 of the last 200 runs
- \`billing/webhook.spec.ts\`: failed 6 of 200
- \`dashboard/charts.spec.ts\`: failed 4 of 200

Each one has its own issue now. They run nightly until they pass 50 runs in a row.
<!-- send:end -->
`);

// Task files keep their days, so World views and Activity spread out the way a real week does.
for (const [rel, day] of [["tasks/TASK-0101/invite-flow.draft", 19], ["tasks/TASK-0101/invite-lifecycle.draft", 20], ["tasks/TASK-0101/invite-expiry-decision.md", 20], ["tasks/TASK-0101/invite-flow-change.draft", 21], ["tasks/TASK-0101/mailer-rollout-runbook.md", 22], ["tasks/TASK-0102/webhook-queue.draft", 20], ["tasks/TASK-0103/cold-start-path.draft", 21], ["tasks/TASK-0105/guide-publish.draft", 16]]) {
  const time = new Date(2026, 9, day, 15);
  await utimes(join(workspace, rel), time, time);
}
for (const day of [16, 19, 20, 21, 22]) {
  const time = new Date(2026, 9, day, 9);
  await utimes(join(workspace, `daily/2026-10-${day}.md`), time, time);
}
for (const rel of ["reference/team.md", "reference/environments.md", "reference/invites/README.md", "tasks/TASK-0105/flaky-spec-comment.md"]) {
  const time = new Date(2026, 9, 15, 11);
  await utimes(join(workspace, rel), time, time);
}

const server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(repo, "server.ts")], { env: { ...process.env, PLANNING_ROOT: workspace, PLAN_VIEWER_PORT: String(port), PLAN_VIEWER_DRY_RUN: "1" }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => server.stdout.on("data", (chunk) => /is ready/.test(chunk) && resolve()));

const browser = await chromium.launch({ channel: "chrome", args: ["--use-mock-keychain", "--password-store=basic"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: "light" });
// The Setup page reports the signed-in GitHub login and other local names; the shots show a fictional one.
const me = (await import("node:os")).userInfo().username;
await page.route(/\/api\/(?!events)/, async (route) => {
  try {
    const response = await route.fetch();
    const body = (await response.text()).replaceAll(me, "alex");
    await route.fulfill({ response, body });
  } catch {} // The page moved on before the answer came.
});
const settle = (ms = 900) => page.waitForTimeout(ms);
const go = async (path, wait) => { await page.goto(`${base}${path}`); if (wait) await page.waitForSelector(wait, { timeout: 90000 }); await settle(); };
const click = async (selector) => { await page.locator(selector).first().click(); await settle(); };

// Numbered marks: a small accent badge at an element's top-left corner and a thin outline around it.
async function mark(list) {
  const missing = await page.evaluate((items) => {
    const lost = [];
    const layer = document.createElement("div");
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    items.forEach(([selector, number, corner = "tl"]) => {
      const el = [...document.querySelectorAll(selector)].find((node) => node.getClientRects().length && node.getBoundingClientRect().width > 0);
      if (!el) return lost.push(selector);
      const r = el.getBoundingClientRect();
      const box = document.createElement("div");
      box.style.cssText = `position:absolute;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:2px solid #e8590c;border-radius:6px;box-sizing:border-box`;
      const badge = document.createElement("div");
      const x = corner.includes("r") ? r.right - 10 : r.left - 12;
      const y = corner.includes("b") ? r.bottom - 10 : r.top - 12;
      badge.textContent = number;
      badge.style.cssText = `position:absolute;left:${Math.max(2, Math.min(innerWidth - 24, x))}px;top:${Math.max(2, y)}px;width:22px;height:22px;border-radius:11px;background:#e8590c;color:#fff;font:600 12px/22px system-ui;text-align:center;box-shadow:0 0 0 2px #fff`;
      layer.append(box, badge);
    });
    document.body.append(layer);
    return lost;
  }, list);
  if (missing.length) console.warn(`  no element for: ${missing.join(", ")}`);
}

// The box around several elements, padded, for a cropped shot.
const around = (selectors, pad = 12) => page.evaluate(([list, pad]) => {
  const boxes = list.map((selector) => document.querySelector(selector)?.getBoundingClientRect()).filter(Boolean);
  const x = Math.max(0, Math.min(...boxes.map((b) => b.left)) - pad), y = Math.max(0, Math.min(...boxes.map((b) => b.top)) - pad);
  return { x, y, width: Math.min(innerWidth, Math.max(...boxes.map((b) => b.right)) + pad) - x, height: Math.min(innerHeight, Math.max(...boxes.map((b) => b.bottom)) + pad) - y };
}, [selectors, pad]);

const task = "/?path=tasks%2FTASK-0101%2FTASK-0101.md";
const shots = {
  hero: async () => { await go("/"); },
  today: async () => {
    await go("/");
    await mark([[".agent-picker", 1], ["#open-search", 2], ["#global-handoff", 3], ["nav.view-navigation", 4], ["section.document-group", 5], [".document-header", 6], [".chunk-card", 7], [".doc-dock", 8, "tr"]]);
  },
  task: async () => {
    await go(task);
    await mark([[".document-header", 1], [".doc-dock", 2, "tr"], [".chunk-card", 3]]);
  },
  step: async () => {
    await go(task);
    await click(".chunk-card .task-steps .step-layer:not([inert]) .step-row:visible");
  },
  graph: async () => {
    await go(`/?path=tasks%2FTASK-0101%2FTASK-0101.md&step=TASK-0101:W2.2&graph=1`);
  },
  world: async () => { await go("/?world=TASK-0101"); await settle(4000); },
  "world-all": async () => { await go("/?world=all"); await settle(4000); },
  tasks: async () => {
    await go("/?view=tasks");
    await click("tbody tr");
  },
  steps: async () => {
    await go("/?view=steps&move=all"); await click("tbody tr td:nth-child(2)");
    await mark([[".step-segs", 1], ["select.step-kind", 2], ["label.show-done", 3], ["span.step-slots", 4, "tr"], [".step-table tbody tr:first-child .step-score", 5]]);
  },
  outbox: async () => { await go("/?view=steps&kind=outbound&move=all"); await click("tbody tr td:nth-child(2)"); },
  outbound: async () => { await go("/?path=tasks%2FTASK-0105%2Fflaky-spec-comment.md"); },
  activity: async () => { await go("/?view=activity&range=all"); await page.keyboard.press("j"); await settle(); },
  reference: async () => { await go("/?view=reference"); },
  diagrams: async () => { await go("/?view=diagrams"); await settle(6000); },
  diagram: async () => { await go("/?path=tasks%2FTASK-0101%2FTASK-0101.md&diagram=tasks%2FTASK-0101%2Finvite-flow.draft"); await settle(6000); await page.keyboard.press("s"); await settle(1500); },
  plans: async () => { await go("/?view=plans"); await settle(2000); },
  "plan-reader": async () => { await go("/?view=plans"); await settle(1500); await click("tbody tr td:nth-child(2)"); await settle(1500); },
  worktrees: async () => { await go("/?view=code&tab=worktrees", '[data-code-state="ready"]'); await settle(2000); await click(".code-surface tbody tr td:nth-child(3)"); },
  "worktree-overview": async () => { await go("/?view=code&tab=worktrees", '[data-code-state="ready"]'); await settle(2000); await click(".code-surface tbody tr td:nth-child(3)"); await page.keyboard.press("Enter"); await settle(3000); },
  commits: async () => { await go("/?view=code&tab=commits", '[data-code-state="ready"]'); await page.waitForSelector('[data-commits-state="ready"]', { timeout: 60000 }); await settle(); },
  diff: async () => {
    await go("/?view=code&tab=commits", '[data-code-state="ready"]'); await settle(2000);
    await page.waitForSelector('[data-commits-state="ready"]', { timeout: 60000 }); await settle();
    await page.locator(".code-surface tbody tr td:nth-child(4)").first().click(); await settle(); await page.keyboard.press("Enter"); await settle(3000);
  },
  issues: async () => { await go("/?view=issues", '[data-issues-state="ready"]'); await click("text=Template picker on first open"); },
  "issue-overview": async () => { await go("/?view=issues&issue=OPS-110", '[data-issues-state="ready"]'); await settle(1500); },
  chats: async () => {
    await page.route("**/api/chat-threads", (route) => route.fulfill({ json: sampleChatThreads() }));
    await go("/?view=chat-threads", '[data-chat-threads-state="ready"]');
    await page.unroute("**/api/chat-threads");
  },
  setup: async () => { await go("/?view=setup"); await settle(4000); },
  palette: async () => { await go("/"); await page.keyboard.press("Meta+k"); await settle(300); await page.keyboard.type("invite"); await settle(); },
  shortcuts: async () => { await go("/"); await page.keyboard.press("Shift+/"); await settle(); },
  recent: async () => {
    await page.evaluate(() => localStorage.clear());
    for (const path of ["/?view=issues&issue=OPS-110", "/?view=tasks", "/?path=tasks%2FTASK-0101%2FTASK-0101.md&step=TASK-0101:W2.2", "/?view=plans", task]) await go(path);
    await page.keyboard.press("h"); await settle();
  },
  table: async () => { await go("/?path=reference%2Fteam.md&table=1"); await settle(1500); },
  composer: async () => { await go(task); await click("#global-handoff"); },
  // Crops for the landing page's "how a day goes" rows.
  "loop-plan": async () => { await go("/"); return around([".chunk-card"]); },
  // An agent finishes W2.2: the task file changes on disk and the open page shows it.
  "loop-step": async () => { await go(`${task}&step=TASK-0101:W2.2`); return around(["dialog[open]"], 0); },
  "loop-live": async () => {
    // A short window, so the toast lands right under the steps list.
    await page.setViewportSize({ width: 1440, height: 600 });
    await go(task);
    await page.evaluate(() => {
      const heading = [...document.querySelectorAll(".chunk-card h2")].find((el) => el.textContent === "Steps");
      window.scrollTo({ top: (heading?.getBoundingClientRect().top ?? 0) + scrollY - 24, behavior: "instant" });
    });
    await settle();
    const file = join(workspace, "tasks/TASK-0101/TASK-0101.md");
    const text = await readFile(file, "utf8");
    await writeFile(file, text
      .replace("- W2.2: Send through the transactional mailer [active]", "- W2.2: Send through the transactional mailer [completed]")
      .replace("## Updates\n\n", "## Updates\n\n- **2026-10-23 — Mailer wired (W2.2):** POST /invites sends through the transactional mailer, one message per invite, with a test. PR atlas#1861.\n"));
    await settle(2500);
    const clip = await around([".chunk-card:has(.task-steps)", ".toast"], 16);
    await writeFile(file, text);
    await page.screenshot({ path: join(pngs, "loop-live.png"), clip });
    await page.setViewportSize({ width: 1440, height: 900 });
    return "taken";
  },
};

try {
  for (const [name, run] of Object.entries(shots)) {
    if (only && !only.includes(name)) continue;
    const clip = await run();
    const png = join(pngs, `${name}.png`);
    if (clip !== "taken") await page.screenshot({ path: png, clip: clip || undefined });
    execFileSync("cwebp", ["-quiet", "-q", "82", png, "-o", join(out, `${name}.webp`)]);
    console.log(`site/images/${name}.webp`);
  }
} finally {
  await browser.close();
  server.kill();
  for (const dir of [join(root, "atlas-pending-invites")]) { try { git(atlas, "worktree", "remove", "--force", dir); } catch {} }
  await rm(root, { recursive: true, force: true });
}
