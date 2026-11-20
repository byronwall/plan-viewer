// Results the server can reuse until the workspace changes. Reading and parsing every document takes most of a second on
// a large workspace, and several endpoints need it on every page load. `serve` turns this on and bumps the generation
// on any file event under the workspace folders and after every write request; the CLI tools (lint, links, move) never
// enable it, so they always read fresh. Concurrent callers share one in-flight computation.
let enabled = false;
let generation = 0;
const MAX_AGE = 5 * 60_000; // a safety net for a missed file event

export function enableMemo() { enabled = true; }
export function invalidateMemo() { generation++; }

export function memo<T>(compute: () => Promise<T>, key: () => string = () => "") {
  let entry: { generation: number; key: string; at: number; value: Promise<T> } | null = null;
  return (): Promise<T> => {
    if (!enabled) return compute();
    const k = key();
    if (entry && entry.generation === generation && entry.key === k && Date.now() - entry.at < MAX_AGE) return entry.value;
    const value = compute();
    const mine = { generation, key: k, at: Date.now(), value };
    entry = mine;
    value.catch(() => { if (entry === mine) entry = null; });
    return value;
  };
}
