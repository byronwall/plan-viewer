import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { customizePrompt, fillPrompt, listPrompts, resetPrompt } from "./prompts.ts";

test("a config/prompts/ copy overrides the default until Reset deletes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompts-"));
  const values = { viewer: "Plan Viewer", workspace: "planning", user: "Ada", ask: "" };
  const before = fillPrompt(root, "global", values);
  assert.match(before, /^Task from the local Plan Viewer\n\nWork in the planning repository/);
  assert.match(before, /record a labeled Markdown link under ## Chats/, "{chat-links} fills from its own prompt");
  const path = await customizePrompt(root, "global");
  assert.equal(path, "config/prompts/global.md");
  const file = join(root, path);
  await writeFile(file, (await readFile(file, "utf8")).replace("Preserve unrelated work.", "Preserve unrelated work. Ask before {unknown} changes."));
  const after = fillPrompt(root, "global", values);
  assert.match(after, /Preserve unrelated work\. Ask before \{unknown\} changes\./, "the copy wins and an unfilled slot stays as written");
  assert.equal(listPrompts(root).find((row) => row.id === "global")?.customized, true);
  await resetPrompt(root, "global");
  assert.equal(fillPrompt(root, "global", values), before);
  assert.throws(() => fillPrompt(root, "nope", {}), /No prompt named nope/);
  await rm(root, { recursive: true });
});

test("routines fill every slot for the day they start", async () => {
  const { routinePrompt } = await import("./setup.ts");
  const { setConfig } = await import("./public/config.js");
  const cfg = setConfig({ user: "Ada" });
  for (const id of ["daily-plan", "daily-review", "up-next-sweep"]) {
    const text = routinePrompt("/work/planning", cfg, id, "2026-11-30", "http://localhost:4173");
    assert.doesNotMatch(text, /\{[a-z][\w-]*\}/, `${id} leaves a slot unfilled`);
  }
  const review = routinePrompt("/work/planning", cfg, "daily-review", "2026-11-30", "http://localhost:4173");
  assert.match(review, /daily\/2026-11-30\.md[\s\S]*daily\/2026-12-01\.md/, "today's plan, then tomorrow's across a month end");
  assert.match(routinePrompt("/work/planning", cfg, "daily-plan", "2026-11-30", "http://localhost:4173"), /# Daily plan — November 30, 2026/);
  setConfig({});
});

test("every default prompt names where it is sent from", () => {
  for (const row of listPrompts("/nonexistent")) {
    assert.ok(row.title && row.sent, `${row.id} needs title and sent front matter`);
    assert.ok(row.body.trim(), `${row.id} has a body`);
  }
});
