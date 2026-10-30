import { escapeHtml, renderMarkdown, SERVICE_ICONS } from "./markdown.js";
import { avatar, hideTip, icon, iconButton, showTip, when } from "./code.js";

// Slack mrkdwn as the viewer's Markdown: `<url|label>` links, `<@U…|Name>` mentions, single-star bold, bullet glyphs,
// and single line breaks kept (two plain lines in a row become two paragraphs).
export function slackMarkdown(text = "") {
  const markdown = text
    .replace(/<@\w+\|([^>]+)>/g, "@$1").replace(/<@(\w+)>/g, "@$1").replace(/<!(\w+)(?:\|[^>]*)?>/g, "@$1").replace(/<#\w+\|([^>]+)>/g, "#$1")
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<(https?:[^|>\s]+)(?:\|([^>]+))?>/g, (_, url, label) => `[${(label || url.replace(/^https?:\/\//, "")).replace(/[[\]]/g, "")}](${url})`)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/gm, "$1**$2**")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/gm, "$1*$2*")
    .replace(/^(\s*)[•◦▪]\s*/gm, (_, indent) => `${"  ".repeat(Math.floor(indent.length / 4))}- `);
  const plain = /^(?!\s*([-+*]\s|\d+\.\s|>|#|```|\|))\S/;
  let fenced = false;
  return markdown.split("\n").map((line, index, lines) => {
    if (line.startsWith("```")) fenced = !fenced;
    return !fenced && plain.test(line) && plain.test(lines[index + 1] || "") ? `${line}\n` : line;
  }).join("\n");
}

// The thread overlay a Slack link opens when `slack.codex` is set: the whole thread, read through the server
// (cached after the first read), with the linked message marked. O opens Slack, R reads it again, Esc closes.
let dialog = null;
let current = null;
function ensureDialog() {
  if (dialog) return;
  dialog = Object.assign(document.body.appendChild(document.createElement("dialog")), { className: "code-diff issue-overview slack-overview", tabIndex: -1 });
  dialog.innerHTML = `<header class="code-diff-head" data-o="head"></header><div class="issue-overview-main" data-o="main"></div>`;
  dialog.addEventListener("close", () => { current = null; });
  let pressedBackdrop = false;
  dialog.addEventListener("pointerdown", (event) => { pressedBackdrop = event.target === dialog; });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) { if (pressedBackdrop) dialog.close(); return; }
    if (event.target.closest("[data-slack-close]")) dialog.close();
    else if (event.target.closest("[data-slack-open]")) openInSlack();
    else if (event.target.closest("[data-slack-refresh]")) load(true);
  });
  dialog.addEventListener("pointerover", (event) => { const target = event.target.closest("[data-tip]"); if (target) showTip(target); else hideTip(); });
  dialog.addEventListener("pointerleave", hideTip);
  dialog.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "o") openInSlack();
    else if (key === "r") load(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
}

function openInSlack() {
  if (!current) return;
  const { href } = current;
  fetch("/api/open-slack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: href }) })
    .then((response) => { if (!response.ok) throw new Error(); })
    .catch(() => window.open(href, "_blank", "noreferrer"));
}

function render(state, thread = null) {
  const { channel, href } = current;
  const where = state === "loading" ? "Reading the thread…" : state === "error" ? thread : `${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"} · read ${Date.now() - new Date(thread.fetchedAt) < 60_000 ? "just now" : `${when(thread.fetchedAt)} ago`}`;
  dialog.querySelector('[data-o="head"]').innerHTML = `<span class="slack-overview-mark${state === "loading" ? " issue-reading" : ""}">${state === "loading" ? icon("refresh") : SERVICE_ICONS.slack}</span><div class="issue-overview-title"><h3>${escapeHtml(channel || "Slack thread")}</h3><p class="code-muted">${state === "ready" ? where : escapeHtml(where)}</p></div><span class="code-spacer"></span><span class="code-muted"><kbd>O</kbd> open in Slack · <kbd>R</kbd> refresh</span>${iconButton("external", "Open in Slack (O)", "data-slack-open")}${iconButton("refresh", "Read again (R)", "data-slack-refresh")}${iconButton("fail", "Close (Esc)", "data-slack-close")}`;
  if (state !== "ready") {
    if (!thread || state === "error") dialog.querySelector('[data-o="main"]').innerHTML = `<p class="code-muted issue-overview-text">${state === "loading" ? "Loading…" : `Couldn't read this thread. <kbd>O</kbd> opens it in Slack.`}</p>`;
    return;
  }
  const linked = new URL(href).pathname.match(/p(\d{10})(\d{6})$/)?.slice(1).join(".");
  dialog.querySelector('[data-o="main"]').innerHTML = `<ol class="issue-comments slack-thread issue-overview-text">${thread.messages.map((message) => `<li${message.ts === linked ? ' class="is-linked"' : ""}><header>${avatar("", message.author, message.email)}<b>${escapeHtml(message.author || "Unknown")}</b>${when(Number(message.ts) * 1000)}${message.reactions ? `<span class="code-muted slack-reactions">${escapeHtml(message.reactions)}</span>` : ""}</header><div class="markdown code-description issue-markdown">${renderMarkdown(slackMarkdown(message.text), "")}</div></li>`).join("")}</ol>`;
  const target = dialog.querySelector(".is-linked");
  if (target && target !== dialog.querySelector(".slack-thread > li")) target.scrollIntoView({ block: "center", behavior: "instant" });
}

async function load(refresh = false) {
  if (!current) return;
  const opened = current;
  render("loading", null);
  try {
    const response = await fetch(`/api/slack/thread?${new URLSearchParams({ url: opened.href, ...(refresh ? { refresh: "1" } : {}) })}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not read the thread.");
    if (current === opened) render("ready", body);
  } catch (error) {
    if (current === opened) render("error", error.message);
  }
}

export function openSlackThread(href, channel = "") {
  ensureDialog();
  current = { href, channel };
  if (!dialog.open) { dialog.showModal(); dialog.focus({ preventScroll: true }); }
  dialog.querySelector('[data-o="main"]').scrollTop = 0;
  load();
}
