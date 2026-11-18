import { test } from "node:test";
import assert from "node:assert/strict";
import { blockLanguage } from "./public/code-highlight.js";

const { default: hljs } = await import("./public/vendor/highlight.js");

test("a fence's own language picks the grammar, aliases included", () => {
  assert.equal(blockLanguage(hljs, "ts", "const a = 1;"), "ts");
  assert.equal(blockLanguage(hljs, "python", "class A: pass"), "python");
  assert.equal(blockLanguage(hljs, "nonsense-lang", "x"), "");
});

test("text, trees, diffs and drafts stay plain", () => {
  for (const language of ["text", "tree", "diff", "patch", "draft"]) assert.equal(blockLanguage(hljs, language, "def f(): return 1"), "");
});

test("an unlabeled fence is colored only on a confident guess", () => {
  assert.equal(blockLanguage(hljs, "", "Hello there, this is a draft message with a link."), "");
  const python = "import os\n\ndef handle(msg):\n    \"\"\"Docs.\"\"\"\n    for item in msg.items:\n        yield item\n\nclass Roles(BaseModel):\n    can_build: bool\n";
  assert.equal(blockLanguage(hljs, "", python), "python");
});
