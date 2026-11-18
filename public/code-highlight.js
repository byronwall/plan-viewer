// Syntax colors for fenced code blocks in rendered Markdown.
//
// markdown.js stays plain (the server and lint import it), so colors are added here: a MutationObserver finds every
// `.markdown-code` block as it lands in the page and colors its `<pre><code>` with the vendored highlight.js, loaded on
// the first block. A fence's language picks the grammar (aliases such as `ts`, `py` and `sh` work); an unlabeled fence
// is colored only when one common language clearly fits, so prose, trees and Slack drafts stay plain. A diff fence
// keeps its line colors and word marks, and the code in it is colored by a guess from its added and context lines (a
// diff is usually a small excerpt, so the bar is lower). If the highlighter fails to load every block stays as it was.
import { codeBlock, diffLines } from "./markdown.js";

const PLAIN = /^(text|txt|plain|plaintext|tree|draft)$/i;
const DIFF = /^(diff|patch)$/i;
const GUESSES = ["typescript", "javascript", "python", "json", "sql", "bash", "yaml", "go", "rust", "java", "css", "xml"];
const MIN_RELEVANCE = 6;
const MIN_DIFF_RELEVANCE = 4;

// The grammar for a fence, or "" for none: its own language when the highlighter knows it, else a confident guess.
export function blockLanguage(highlighter, language, text) {
  if (PLAIN.test(language)) return "";
  if (DIFF.test(language)) {
    const code = diffLines(text.split("\n")).filter((line) => line.kind === "add" || line.kind === "ctx").map((line) => line.text).join("\n");
    return guess(highlighter, code, MIN_DIFF_RELEVANCE);
  }
  if (language) return highlighter.getLanguage(language) ? language : "";
  return guess(highlighter, text, MIN_RELEVANCE);
}
const guess = (highlighter, text, min) => {
  const best = highlighter.highlightAuto(text, GUESSES);
  return best.relevance >= min ? best.language || "" : "";
};

// highlight.js output can open a span on one line and close it lines later; close and reopen it at every line break.
export function splitHighlightedLines(html) {
  const open = [];
  return html.split("\n").map((line) => {
    const prefix = open.join("");
    for (const tag of line.match(/<span[^>]*>|<\/span>/g) || []) tag === "</span>" ? open.pop() : open.push(tag);
    return prefix + line + "</span>".repeat(open.length);
  });
}

let highlighter = null;
let load = null;
const pending = new Set();

function colorize(block) {
  const pre = block.querySelector(":scope > pre");
  const code = pre?.querySelector(":scope > code");
  if (!code || code.dataset.highlighted) return;
  code.dataset.highlighted = "1";
  const fence = block.dataset.codeLanguage || "";
  const diff = DIFF.test(fence);
  const text = diff ? block.dataset.codeSource ?? "" : code.textContent;
  const language = blockLanguage(highlighter, fence, text);
  if (!language) return;
  const highlight = (source) => highlighter.highlight(source, { language, ignoreIllegals: true }).value;
  if (!diff) { code.innerHTML = highlight(text); return; }
  const colored = new DOMParser().parseFromString(codeBlock(text.split("\n"), fence, (source) => splitHighlightedLines(highlight(source))), "text/html").body.firstElementChild;
  code.innerHTML = colored.querySelector("code").innerHTML;
}

function queue(block) {
  if (highlighter) return colorize(block);
  pending.add(block);
  load ||= import("./vendor/highlight.js").then((module) => {
    highlighter = module.default;
    for (const waiting of pending) if (waiting.isConnected) colorize(waiting);
    pending.clear();
  }, () => pending.clear());
}

if (typeof document !== "undefined") {
  const scan = (root) => {
    if (root.matches?.(".markdown-code")) queue(root);
    for (const block of root.querySelectorAll?.(".markdown-code") || []) queue(block);
  };
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) scan(node);
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan(document.documentElement);
}
