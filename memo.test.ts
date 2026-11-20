import assert from "node:assert/strict";
import test from "node:test";
import { enableMemo, invalidateMemo, memo } from "./memo.ts";

test("memo shares one computation until the workspace changes or the key moves", async () => {
  let runs = 0;
  let key = "2026-11-19";
  const cached = memo(async () => ++runs, () => key);
  assert.equal(await cached(), 1);
  assert.equal(await cached(), 2, "off until serve enables it, so CLI tools always read fresh");
  enableMemo();
  const [a, b] = await Promise.all([cached(), cached()]);
  assert.deepEqual([a, b], [3, 3], "concurrent callers share one run");
  assert.equal(await cached(), 3);
  invalidateMemo();
  assert.equal(await cached(), 4);
  key = "2026-11-20";
  assert.equal(await cached(), 5, "a new day recomputes");
  let fail = true;
  const flaky = memo(async () => { if (fail) throw new Error("boom"); return "ok"; });
  await assert.rejects(flaky());
  fail = false;
  assert.equal(await flaky(), "ok", "a failure is not kept");
});
