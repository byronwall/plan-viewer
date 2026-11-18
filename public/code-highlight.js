// Syntax colors for fenced code blocks in rendered Markdown.
//
// markdown.js stays plain (the server and lint import it), so colors are added here: a MutationObserver finds every
// `.markdown-code` block as it lands in the page and colors its `<pre><code>` with the vendored highlight.js, loaded on
// the first block. A fence's language picks the grammar (aliases such as `ts`, `py` and `sh` work); an unlabeled fence
// is colored only when one common language clearly fits, so prose, trees and Slack drafts stay plain. Diff fences keep
// their own line colors, and if the highlighter fails to load every block stays as it was.

const PLAIN = /^(text|txt|plain|plaintext|tree|diff|patch|draft)$/i;
const GUESSES = ["typescript", "javascript", "python", "json", "sql", "bash", "yaml", "go", "rust", "java", "css", "xml"];
const MIN_RELEVANCE = 6;

// The grammar for a fence, or "" for none: its own language when the highlighter knows it, else a confident guess.
export function blockLanguage(highlighter, language, text) {
  if (PLAIN.test(language)) return "";
  if (language) return highlighter.getLanguage(language) ? language : "";
  const guess = highlighter.highlightAuto(text, GUESSES);
  return guess.relevance >= MIN_RELEVANCE ? guess.language || "" : "";
}

let highlighter = null;
let load = null;
const pending = new Set();

function colorize(block) {
  const code = block.querySelector(":scope > pre:not(.markdown-diff) > code");
  if (!code || code.dataset.highlighted) return;
  code.dataset.highlighted = "1";
  const text = code.textContent;
  const language = blockLanguage(highlighter, block.dataset.codeLanguage || "", text);
  if (!language) return;
  code.innerHTML = highlighter.highlight(text, { language, ignoreIllegals: true }).value;
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
