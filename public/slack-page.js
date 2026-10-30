import { escapeHtml, renderMarkdown, SERVICE_ICONS } from "./markdown.js";
import { avatar, fadeIn, hideTip, icon, iconButton, planning, showTip, when } from "./code.js";
import { emojify } from "./emoji.js";
import { GLYPHS } from "./icons.js";
import { openSlackThread, rememberSlackTitle, slackMarkdown } from "./slack.js";

// The Slack page: every thread the planning documents link (and any opened from elsewhere), grouped by channel or by
// last activity, with the documents that cite it. A click selects (and opens on narrow screens), Enter or a double
// click opens the thread overlay, S stars it into Favorites, and R reads the threads not synced yet.
const DAY = 24 * 60 * 60 * 1000;
const GROUPS = [["Last 24 hours", DAY], ["This week", 7 * DAY], ["This month", 30 * DAY], ["Older", Infinity]];
const ui = { data: null, filter: "", group: "channel", sel: "", poll: 0 };
let host = null;
let helpers = { showNotice: () => {}, toggleFavorite: () => {}, isFavorite: () => false };

const permalink = (entry) => `https://${entry.host}.slack.com/archives/${entry.channel}/p${entry.thread.replace(".", "")}`;
const lastActive = (entry) => Number(entry.summary?.last || entry.thread) * 1000;
// The opening message as one plain line: link labels, mentions and emoji kept, Markdown marks dropped.
const opener = (entry) => entry.summary ? emojify(entry.summary.text).replace(/<[@#!]\w+\|([^>]*)>/g, (_, name) => `@${name}`).replace(/<[^>|]*\|([^>]*)>/g, "$1").replace(/<([^>]*)>/g, "$1").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/```|`/g, "").replace(/(?<!\w)[*_~]+(?=\w)|(?<=\w)[*_~]+(?!\w)/g, "").replace(/\s+/g, " ").trim() : "";
const channelLabel = (entry) => entry.channelName || (entry.channel.startsWith("D") ? "Direct message" : entry.channel);
const docsFor = (entry) => entry.docs.map((path) => planning.documents().find((doc) => doc.path === path)).filter(Boolean)
  .sort((a, b) => !!b.task - !!a.task || (b.date || b.task?.updated || "").localeCompare(a.date || a.task?.updated || ""));
const docChip = (doc) => `<a href="?${new URLSearchParams({ path: doc.path })}" data-planning-path="${escapeHtml(doc.path)}" data-tip="${escapeHtml(`${doc.task?.title || doc.title} · ${doc.path}`)}">${doc.task ? SERVICE_ICONS.task : icon("doc")}<code>${escapeHtml(doc.task?.id || doc.date || doc.kind)}</code></a>`;

function visible() {
  const terms = ui.filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return ui.data.threads.filter((entry) => {
    if (!terms.length) return true;
    const text = [channelLabel(entry), entry.summary?.author, opener(entry), ...(entry.summary?.people || []), ...docsFor(entry).map((doc) => `${doc.task?.id || ""} ${doc.task?.title || doc.title}`)].join(" ").toLowerCase();
    return terms.every((term) => text.includes(term));
  }).sort((a, b) => lastActive(b) - lastActive(a));
}

function row(entry, inChannel) {
  const href = permalink(entry);
  const starred = helpers.isFavorite(`?slack=${encodeURIComponent(href)}`);
  const summary = entry.summary;
  const docs = docsFor(entry);
  const facts = [summary ? `${summary.replies ? `${summary.replies} ${summary.replies === 1 ? "reply" : "replies"}` : "no replies"}` : "not synced yet", summary?.people.length > 1 ? `${summary.people.length} people` : ""].filter(Boolean).join(" · ");
  const title = summary ? `<b>${escapeHtml(summary.author)}</b> ${escapeHtml(opener(entry))}` : `<span class="code-muted">Thread from ${new Date(Number(entry.thread) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>`;
  return `<tr class="code-row slack-row${summary ? "" : " is-unsynced"}" data-slack-row="${escapeHtml(entry.key)}" data-href="${escapeHtml(href)}" aria-selected="${ui.sel === entry.key}">
    <td class="slack-col-star"><button type="button" class="code-icon-button slack-star${starred ? " is-on" : ""}" data-slack-star aria-pressed="${starred}" data-tip="${starred ? "Remove from favorites" : "Add to favorites"} (S)"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.star}</svg></button></td>
    ${inChannel ? "" : `<td class="slack-col-channel">${escapeHtml(channelLabel(entry))}</td>`}
    <td class="code-col-main"><div class="slack-row-title">${summary ? avatar("", summary.author, summary.email) : ""}<span>${title}</span></div><div class="code-sub slack-row-sub"><span class="code-muted">${facts}</span>${docs.length ? `<span class="slack-row-docs">${docs.slice(0, 4).map(docChip).join("")}${docs.length > 4 ? `<span class="code-muted">+${docs.length - 4}</span>` : ""}</span>` : ""}</div></td>
    <td class="code-col-when">${when(lastActive(entry))}</td></tr>`;
}

function listBody() {
  const threads = visible();
  if (!threads.length) return `<div class="code-empty"><p>${ui.filter ? `No threads match “${escapeHtml(ui.filter)}”.` : "No Slack threads are linked from the planning documents yet."}</p>${ui.filter ? '<button type="button" class="code-bar-button" data-slack-clear>Clear filter <kbd>Esc</kbd></button>' : ""}</div>`;
  const section = (label, rows, inChannel) => `<tbody><tr class="code-group-row"><th colspan="${inChannel ? 3 : 4}">${escapeHtml(label)} <span>${rows.length}</span></th></tr>${rows.map((entry) => row(entry, inChannel)).join("")}</tbody>`;
  if (ui.group === "channel") {
    const channels = new Map();
    for (const entry of threads) channels.set(channelLabel(entry), [...(channels.get(channelLabel(entry)) || []), entry]);
    return `<table class="code-table slack-table">${[...channels].map(([label, rows]) => section(label, rows, true)).join("")}</table>`;
  }
  const now = Date.now();
  const buckets = GROUPS.map(([label]) => [label, []]);
  for (const entry of threads) buckets[GROUPS.findIndex(([, age]) => now - lastActive(entry) < age)][1].push(entry);
  return `<table class="code-table slack-table">${buckets.filter(([, rows]) => rows.length).map(([label, rows]) => section(label, rows, false)).join("")}</table>`;
}

function detail() {
  const entry = ui.data.threads.find((candidate) => candidate.key === ui.sel);
  if (!entry) return `<p class="code-detail-empty">Select a thread to see how it starts and where it is cited.<br><br><kbd>J</kbd><kbd>K</kbd> move · <kbd>Enter</kbd> open · <kbd>S</kbd> star · <kbd>F</kbd> filter · <kbd>G</kbd> group · <kbd>R</kbd> sync</p>`;
  const summary = entry.summary;
  const docs = docsFor(entry);
  const body = summary ? `<div class="slack-detail-message"><header>${avatar("", summary.author, summary.email)}<b>${escapeHtml(summary.author)}</b>${when(Number(entry.thread) * 1000)} ago</header><div class="markdown issue-markdown">${renderMarkdown(slackMarkdown(summary.text), "")}</div></div><p class="code-muted">${summary.replies} ${summary.replies === 1 ? "reply" : "replies"} · ${summary.people.map(escapeHtml).join(", ")} · last ${when(lastActive(entry))} ago</p>` : `<p class="code-muted">Not synced yet. Open it to read it now, or press <kbd>R</kbd> to sync every unread thread.</p>`;
  return `<div class="code-detail-head">${SERVICE_ICONS.slack}<h3>${escapeHtml(channelLabel(entry))}</h3><span class="code-spacer"></span><button type="button" class="code-bar-button is-primary" data-slack-open-row>Open thread <kbd>Enter</kbd></button></div>${body}${docs.length ? `<section><h4 class="slack-detail-head">Linked from <span>${docs.length}</span></h4><ul class="issue-code-list">${docs.map((doc) => `<li><a class="issue-link-row" href="?${new URLSearchParams({ path: doc.path })}" data-planning-path="${escapeHtml(doc.path)}">${doc.task ? SERVICE_ICONS.task : icon("doc")}<code>${escapeHtml(doc.task?.id || doc.date || doc.kind)}</code><span>${escapeHtml(doc.task?.title || doc.title)}</span></a></li>`).join("")}</ul></section>` : ""}`;
}

function toolbar() {
  const total = ui.data.threads.length;
  const unread = ui.data.threads.filter((entry) => !entry.summary).length;
  const sync = ui.data.syncing;
  const status = sync ? `Syncing ${sync.done} of ${sync.total}…` : unread ? `${unread} not synced` : "All synced";
  const segment = `<div class="code-segment">${[["channel", "By channel"], ["recent", "By activity"]].map(([id, label]) => `<button type="button" data-slack-group="${id}" aria-pressed="${ui.group === id}">${label}</button>`).join("")}</div>`;
  return `<div class="code-toolbar"><div class="code-toolbar-rows"><div class="code-toolbar-row"><label class="code-filter"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.search}</svg><input type="search" data-slack-filter placeholder="Filter  (F)" value="${escapeHtml(ui.filter)}" spellcheck="false"></label>${segment}<span class="code-spacer"></span><span class="code-muted slack-sync-status">${total} threads · ${status}</span>${iconButton("refresh", sync ? "Syncing…" : unread ? `Sync the ${unread} unread threads (R)` : "Sync every thread again (R)", `data-slack-sync class="code-icon-button${sync ? " is-spinning" : ""}"`)}</div></div></div>`;
}

function patch(region, html) {
  const node = host.querySelector(`[data-region="${region}"]`);
  if (node.innerHTML === html) return null;
  node.innerHTML = html;
  return node;
}

function render({ animate = false } = {}) {
  if (!host?.isConnected || !host.querySelector(".slack-surface, .slack-loading")) return;
  if (!host.querySelector(".slack-surface")) {
    host.innerHTML = `<section class="slack-surface" aria-label="Slack threads"><div data-region="toolbar"></div><div class="code-split"><div class="code-list" data-region="list"></div><aside class="code-detail" data-region="detail" aria-live="polite"></aside></div></section>`;
    animate = true;
    new ResizeObserver(([entry]) => host.style.setProperty("--code-bar-h", `${Math.ceil(entry.borderBoxSize[0].blockSize)}px`)).observe(host.querySelector('[data-region="toolbar"]'));
  }
  const filter = host.querySelector("[data-slack-filter]");
  const focused = document.activeElement === filter;
  const caret = filter?.selectionStart;
  hideTip();
  patch("toolbar", toolbar());
  const list = patch("list", listBody());
  if (list && animate) fadeIn(list);
  patch("detail", detail());
  if (focused) { const next = host.querySelector("[data-slack-filter]"); next.focus(); next.setSelectionRange(caret, caret); }
  // Titles for Favorites and Recently viewed, which only know the permalink.
  for (const entry of ui.data.threads) if (entry.summary) rememberSlackTitle(permalink(entry), `${channelLabel(entry)} · ${opener(entry).slice(0, 60)}`);
}

async function load() {
  const response = await fetch("/api/slack");
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not list Slack threads.");
  ui.data = await response.json();
  clearTimeout(ui.poll);
  if (ui.data.syncing && host?.isConnected) ui.poll = setTimeout(() => load().then(() => render()).catch(() => {}), 2000);
}

function select(key, scroll = false) {
  ui.sel = key;
  for (const node of host.querySelectorAll("[data-slack-row]")) node.setAttribute("aria-selected", String(node.dataset.slackRow === key));
  if (scroll) host.querySelector(`[data-slack-row="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
  patch("detail", detail());
  syncUrl();
}
const rows = () => [...host.querySelectorAll("[data-slack-row]")];
const open = (node) => node && openSlackThread(node.dataset.href);
const wide = () => matchMedia("(min-width: 1600px)").matches;
function syncUrl() {
  const url = new URL(location.href);
  for (const [name, value] of [["thread", ui.sel], ["group", ui.group === "channel" ? "" : ui.group]]) value ? url.searchParams.set(name, value) : url.searchParams.delete(name);
  if (url.href !== location.href) history.replaceState(history.state, "", url);
}

async function syncThreads() {
  const response = await fetch("/api/slack/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: !ui.data.threads.some((entry) => !entry.summary) }) });
  if (!response.ok) return helpers.showNotice((await response.json().catch(() => ({}))).error || "Could not start the sync.", true);
  await load();
  render();
}

function star(node) {
  helpers.toggleFavorite(`?slack=${encodeURIComponent(node.dataset.href)}`);
  render();
}

function handleKey(event) {
  if (!host?.querySelector(".slack-surface") || !host.isConnected || document.querySelector("dialog[open]") || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
  const key = event.key.toLowerCase();
  if (event.target.closest?.("input, textarea")) {
    if (key === "escape" && event.target.matches("[data-slack-filter]")) { event.preventDefault(); if (ui.filter) { ui.filter = ""; render(); } else event.target.blur(); }
    else if (key === "enter" && event.target.matches("[data-slack-filter]")) { event.preventDefault(); event.target.blur(); select(rows()[0]?.dataset.slackRow || "", true); }
    return;
  }
  const list = rows();
  const at = list.findIndex((node) => node.dataset.slackRow === ui.sel);
  const step = { j: 1, arrowdown: 1, k: -1, arrowup: -1 }[key];
  if (step && list.length) select(list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + step))].dataset.slackRow, true);
  else if (key === "enter" && at >= 0) open(list[at]);
  else if (key === "o" && at >= 0) open(list[at]);
  else if (key === "s" && at >= 0) star(list[at]);
  else if (key === "f" || key === "/") host.querySelector("[data-slack-filter]")?.focus();
  else if (key === "g") { ui.group = ui.group === "channel" ? "recent" : "channel"; syncUrl(); render({ animate: true }); }
  else if (key === "r") syncThreads();
  else if (key === "escape" && ui.filter) { ui.filter = ""; render(); }
  else return;
  event.preventDefault();
  event.stopPropagation();
}

export function renderSlackPage(container, nextHelpers) {
  helpers = nextHelpers;
  const params = new URLSearchParams(location.search);
  ui.group = params.get("group") === "recent" ? "recent" : "channel";
  ui.sel = params.get("thread") || ui.sel;
  if (host !== container) {
    host = container;
    container.addEventListener("click", (event) => {
      if (!container.querySelector(".slack-surface")) return;
      const doc = event.target.closest("a[data-planning-path]");
      if (doc && !event.metaKey && !event.ctrlKey) { event.preventDefault(); return planning.open(doc.dataset.planningPath); }
      const node = event.target.closest("[data-slack-row]");
      if (event.target.closest("[data-slack-star]")) return star(node);
      if (event.target.closest("[data-slack-group]")) { ui.group = event.target.closest("[data-slack-group]").dataset.slackGroup; syncUrl(); return render({ animate: true }); }
      if (event.target.closest("[data-slack-sync]")) return syncThreads();
      if (event.target.closest("[data-slack-clear]")) { ui.filter = ""; return render(); }
      if (event.target.closest("[data-slack-open-row]")) return open(host.querySelector(`[data-slack-row="${CSS.escape(ui.sel)}"]`));
      if (node && !event.target.closest("a, button")) { select(node.dataset.slackRow); if (!wide()) open(node); }
    });
    container.addEventListener("dblclick", (event) => {
      const node = event.target.closest("[data-slack-row]");
      if (!node || !container.querySelector(".slack-surface") || event.target.closest("a, button")) return;
      window.getSelection()?.removeAllRanges();
      open(node);
    });
    container.addEventListener("input", (event) => { if (event.target.matches("[data-slack-filter]")) { ui.filter = event.target.value; render(); } });
    container.addEventListener("pointerover", (event) => { if (!container.querySelector(".slack-surface")) return; const target = event.target.closest("[data-tip]"); if (target) showTip(target); else hideTip(); });
    window.addEventListener("keydown", handleKey, true);
  }
  container.innerHTML = `<p class="code-muted slack-loading">Loading Slack threads…</p>`;
  load().then(() => render()).catch((error) => { container.innerHTML = `<p class="work-warning">${escapeHtml(error.message)}</p>`; });
}

// Favorites and stars elsewhere change; the page redraws its stars when it is showing.
export const refreshSlackPage = () => { if (host?.querySelector(".slack-surface")) render(); };
