import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createLocalRuns } from "./local-runs.ts";

test("a local run reports its first localhost URL, keeps its output, and stops", async () => {
  const runs = createLocalRuns();
  const path = process.cwd();
  runs.start(path, [process.execPath, "-e", "console.log('\\x1b[36m  app  http://localhost:5199\\x1b[0m'); console.log('api http://localhost:5200'); setInterval(() => {}, 1000)"]);
  for (let i = 0; i < 50 && !runs.list()[path]?.url; i++) await sleep(50);
  assert.equal(runs.list()[path].url, "http://localhost:5199");
  assert.equal(runs.list()[path].state, "running");
  assert.ok(runs.log(path)!.log.includes("api http://localhost:5200"));
  runs.stop(path);
  assert.equal(runs.log(path), null);
});
