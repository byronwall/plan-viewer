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

test("a diff fence guesses its language from its added and context lines", () => {
  const diff = " @ws_router.handle(CreateModel)\n async def handle_create_model(\n     msg: CreateModel,\n-):\n+) -> AsyncIterator[CreateModelResponse]:";
  assert.equal(blockLanguage(hljs, "diff", diff), "python");
  assert.equal(blockLanguage(hljs, "diff", "-Some prose line\n+Some prose line, changed"), "");
});

test("a colored diff keeps its line kinds and word marks over the syntax colors", async () => {
  const { codeBlock } = await import("./public/markdown.js");
  const { splitHighlightedLines } = await import("./public/code-highlight.js");
  const html = codeBlock(["-const delay = 1000;", "+const delay = 5000;"], "diff", (text) => splitHighlightedLines(hljs.highlight(text, { language: "typescript" }).value));
  assert.match(html, /<span class="markdown-diff-del">.*hljs-keyword.*<\/span>/);
  assert.match(html, /markdown-diff-add.*<span class="hljs-number"><mark class="code-word">5000/);
});
