import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPrNotes } from "./pr-notes.ts";

test("notes round-trip through readable Markdown and keep hand-written text", async () => {
  const root = await mkdtemp(join(tmpdir(), "pr-notes-"));
  const notes = createPrNotes(root);
  let { notes: list } = await notes.change("Org/repo", 7, { op: "add", title: "Fix it", note: { file: "a/b.py", side: "new", line: 3, end: 5, quote: "x = 1\ny = 2", body: "Why two?\n\nSecond paragraph." } });
  ({ notes: list } = await notes.change("Org/repo", 7, { op: "add", note: { file: "c.ts", side: "old", line: 9, commit: "abc1234", body: "Gone?" } }));
  ({ notes: list } = await notes.change("Org/repo", 7, { op: "add", note: { file: "d.md", line: 0, body: "Whole thing reads well." } }));
  const path = join(root, "plans/pr-notes/Org-repo-7.md");
  const text = await readFile(path, "utf8");
  assert.match(text, /^# Review notes for Org\/repo#7\n/);
  assert.match(text, /### `a\/b.py` · new lines 3–5\n- id: \w+ · status: draft · at: [\d-]+ [\d:]+\n\n> x = 1\n> y = 2\n\nWhy two\?\n\nSecond paragraph\.\n/);
  // An agent marks one posted and adds a stray section; both survive the next write.
  await writeFile(path, text.replace("status: draft", "status: posted") + "### `odd` heading by hand\n\nkept\n");
  ({ notes: list } = await notes.change("Org/repo", 7, { op: "update", id: list[1].id, note: { body: "Gone for good?" } }));
  assert.deepEqual(list.map((note) => [note.file, note.side, note.line, note.end, note.commit, note.status, note.body]), [
    ["a/b.py", "new", 3, 5, "", "posted", "Why two?\n\nSecond paragraph."],
    ["c.ts", "old", 9, 9, "abc1234", "draft", "Gone for good?"],
    ["d.md", "new", 0, 0, "", "draft", "Whole thing reads well."],
  ]);
  assert.match(await readFile(path, "utf8"), /### `d.md` · whole file\n- id: \w+ · status: draft · at: [\d-]+ [\d:]+\n\nWhole thing reads well\.\n/);
  assert.match(await readFile(path, "utf8"), /### `odd` heading by hand\n\nkept\n$/);
  assert.equal((await notes.drafts("Org/repo", 7)).text.includes("Gone for good?"), true);
  await notes.change("Org/repo", 7, { op: "delete", id: list[0].id });
  assert.equal((await notes.list("Org/repo", 7)).notes.length, 2);
});
