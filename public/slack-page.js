import { escapeHtml, renderMarkdown, SERVICE_ICONS } from "./markdown.js";
import { avatar, fadeIn, hideTip, icon, iconButton, planning, showTip, when } from "./code.js";
import { emojify } from "./emoji.js";
import { GLYPHS } from "./icons.js";
import { openSlackThread, rememberSlackTitle, slackLastRead, slackMarkdown } from "./slack.js";

// The Slack page: every thread the planning documents link (and any opened from elsewhere), favorites first, then by
// last activity or by channel, with the documents that cite it. A click selects (and opens on narrow screens), Enter
// or a double click opens the thread overlay (J/K there walk the list), S stars it into Favorites, a document chip
// peeks the document in place, and R reads the threads not synced yet.
const DAY = 24 * 60 * 60 * 1000;
// A fixed layout, so a long unbroken opener (a URL) wraps instead of pushing the table under the inspector.
const COLS = '<colgroup><col class="slack-col-star"><col><col class="slack-col-when"></colgroup>';
const GROUPS = [["Last 24 hours", DAY], ["This week", 7 * DAY], ["This month", 30 * DAY], ["Older", Infinity]];
const ui = { data: null, filter: "", group: "recent", sel: "", poll: 0 };
let host = null;
let helpers = { showNotice: () => {}, toggleFavorite: () => {}, isFavorite: () => false, favorites: () => [] };

export const permalink = (entry) => `https://${entry.host}.slack.com/archives/${entry.channel}/p${entry.thread.replace(".", "")}`;
export const lastActive = (entry) => Number(entry.summary?.last || entry.thread) * 1000;
// The opening message as one plain line: link labels, mentions and emoji kept, Markdown marks dropped.
export const opener = (entry) => entry.summary ? emojify(entry.summary.text).replace(/<[@#!]\w+\|([^>]*)>/g, (_, name) => `@${name}`).replace(/<[^>|]*\|([^>]*)>/g, "$1").replace(/<([^>]*)>/g, "$1").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/```|`/g, "").replace(/(?<!\w)[*_~]+(?=\w)|(?<=\w)[*_~]+(?!\w)/g, "").replace(/\s+/g, " ").trim() : "";
const starred = (entry) => helpers.isFavorite(`?slack=${encodeURIComponent(permalink(entry))}`);
// Favorited threads, and threads with a favorited message (whose permalink carries `thread_ts`).
function favoriteKeys() {
  const keys = new Set();
  for (const href of helpers.favorites()) {
    try {
      const slack = new URL(new URL(href, location.href).searchParams.get("slack") || "");
      const ts = slack.searchParams.get("thread_ts") || slack.pathname.match(/p(\d{10})(\d{6})$/)?.slice(1).join(".");
      if (ts) keys.add(`${slack.pathname.split("/")[2]}/${ts}`);
    } catch {}
  }
  return keys;
}
// Replies since this browser last opened the thread; threads never opened aren't marked.
export const fresh = (entry) => { const read = slackLastRead(entry.key); return !!(read && entry.summary && entry.summary.last > read); };
export const channelLabel = (entry) => entry.channelName || (entry.channel.startsWith("D") ? "Direct message" : entry.channel);
export const docsFor = (entry) => entry.docs.map((path) => planning.documents().find((doc) => doc.path === path)).filter(Boolean)
  .sort((a, b) => !!b.task - !!a.task || (b.date || b.task?.updated || "").localeCompare(a.date || a.task?.updated || ""));
const docChip = (doc) => `<a class="slack-doc-chip" href="?${new URLSearchParams({ path: doc.path })}" data-planning-path="${escapeHtml(doc.path)}" data-tip="${escapeHtml(`${doc.task?.title || doc.title} · ${doc.path}`)}">${doc.task ? SERVICE_ICONS.task : icon("doc")}<code>${escapeHtml(doc.task?.id || doc.date || doc.kind)}</code></a>`;

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
  const on = starred(entry);
  const summary = entry.summary;
  const docs = docsFor(entry);
  const facts = [inChannel ? "" : `<span class="slack-row-channel">${escapeHtml(channelLabel(entry))}</span>`, fresh(entry) ? '<b class="slack-row-new">New replies</b>' : "", summary ? `${summary.replies ? `${summary.replies} ${summary.replies === 1 ? "reply" : "replies"}` : "no replies"}` : "not synced yet", summary?.people.length > 1 ? `${summary.people.length} people` : ""].filter(Boolean).join(" · ");
  const title = summary ? `<b>${escapeHtml(summary.author)}</b> ${escapeHtml(opener(entry))}` : `<span class="code-muted">Thread from ${new Date(Number(entry.thread) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>`;
  return `<tr class="code-row slack-row${summary ? "" : " is-unsynced"}${fresh(entry) ? " is-new" : ""}" data-slack-row="${escapeHtml(entry.key)}" data-href="${escapeHtml(href)}" aria-selected="${ui.sel === entry.key}">
    <td class="slack-col-star"><button type="button" class="code-icon-button slack-star${on ? " is-on" : ""}" data-slack-star aria-pressed="${on}" data-tip="${on ? "Remove from favorites" : "Add to favorites"} (S)"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.star}</svg></button></td>
    <td class="code-col-main"><div class="slack-row-title">${summary ? avatar("", summary.author, summary.email) : ""}<span>${title}</span></div><div class="code-sub slack-row-sub"><span class="code-muted">${facts}</span>${docs.length ? `<span class="slack-row-docs">${docs.slice(0, 4).map(docChip).join("")}${docs.length > 4 ? `<span class="code-muted">+${docs.length - 4}</span>` : ""}</span>` : ""}</div></td>
    <td class="code-col-when">${when(lastActive(entry))}</td></tr>`;
}

function listBody() {
  const threads = visible();
  if (!threads.length) return `<div class="code-empty"><p>${ui.filter ? `No threads match “${escapeHtml(ui.filter)}”.` : "No Slack threads are linked from the planning documents yet."}</p>${ui.filter ? '<button type="button" class="code-bar-button" data-slack-clear>Clear filter <kbd>Esc</kbd></button>' : ""}</div>`;
  const section = (label, rows, inChannel, extra = "") => `<tbody${extra}><tr class="code-group-row"><th colspan="3">${label} <span>${rows.length}</span></th></tr>${rows.map((entry) => row(entry, inChannel)).join("")}</tbody>`;
  // Favorites lead in both groupings and aren't repeated below.
  const keys = favoriteKeys();
  const favorites = threads.filter((entry) => keys.has(entry.key) || starred(entry));
  const rest = threads.filter((entry) => !favorites.includes(entry));
  const top = favorites.length ? section(`<svg class="slack-group-star" viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.star}</svg>Favorites`, favorites, false, ' class="slack-favorites"') : "";
  if (ui.group === "channel") {
    const channels = new Map();
    for (const entry of rest) channels.set(channelLabel(entry), [...(channels.get(channelLabel(entry)) || []), entry]);
    return `<table class="code-table slack-table">${COLS}${top}${[...channels].map(([label, rows]) => section(escapeHtml(label), rows, true)).join("")}</table>`;
  }
  const now = Date.now();
  const buckets = GROUPS.map(([label]) => [label, []]);
  for (const entry of rest) buckets[GROUPS.findIndex(([, age]) => now - lastActive(entry) < age)][1].push(entry);
  return `<table class="code-table slack-table">${COLS}${top}${buckets.filter(([, rows]) => rows.length).map(([label, rows]) => section(label, rows, false)).join("")}</table>`;
}

const detail = () => threadDetail(ui.data.threads.find((candidate) => candidate.key === ui.sel));
// The inspector for one thread, shared with the Activity page: its opening message, replies, and citing documents.
export function threadDetail(entry) {
  if (!entry) return `<p class="code-detail-empty">Select a thread to see how it starts and where it is cited.<br><br><kbd>J</kbd><kbd>K</kbd> move · <kbd>Enter</kbd> open · <kbd>S</kbd> star · <kbd>F</kbd> filter · <kbd>G</kbd> group · <kbd>R</kbd> sync</p>`;
  const summary = entry.summary;
  const docs = docsFor(entry);
  const body = summary ? `${fresh(entry) ? '<p class="slack-row-new">New replies since you last read it</p>' : ""}<div class="slack-detail-message"><header>${avatar("", summary.author, summary.email)}<b>${escapeHtml(summary.author)}</b>${when(Number(entry.thread) * 1000)} ago</header><div class="markdown issue-markdown">${renderMarkdown(slackMarkdown(summary.text), "")}</div></div><p class="code-muted">${summary.replies} ${summary.replies === 1 ? "reply" : "replies"} · ${summary.people.map(escapeHtml).join(", ")} · last ${when(lastActive(entry))} ago</p>` : `<p class="code-muted">Not synced yet. Open it to read it now, or press <kbd>R</kbd> to sync every unread thread.</p>`;
  return `<div class="code-detail-head">${SERVICE_ICONS.slack}<h3>${escapeHtml(channelLabel(entry))}</h3><span class="code-spacer"></span><button type="button" class="code-bar-button is-primary" data-slack-open-row>Open thread <kbd>Enter</kbd></button></div>${body}${docs.length ? `<section><h4 class="slack-detail-head">Linked from <span>${docs.length}</span></h4><ul class="issue-code-list">${docs.map((doc) => `<li><a class="issue-link-row" href="?${new URLSearchParams({ path: doc.path })}" data-planning-path="${escapeHtml(doc.path)}">${doc.task ? SERVICE_ICONS.task : icon("doc")}<code>${escapeHtml(doc.task?.id || doc.date || doc.kind)}</code><span>${escapeHtml(doc.task?.title || doc.title)}</span></a></li>`).join("")}</ul></section>` : ""}`;
}

function toolbar() {
  const total = ui.data.threads.length;
  const unread = ui.data.threads.filter((entry) => !entry.summary).length;
  const sync = ui.data.syncing;
  const status = sync ? `Syncing ${sync.done} of ${sync.total}…` : unread ? `${unread} not synced` : "All synced";
  const segment = `<div class="code-segment">${[["recent", "By activity"], ["channel", "By channel"]].map(([id, label]) => `<button type="button" data-slack-group="${id}" aria-pressed="${ui.group === id}">${label}</button>`).join("")}</div>`;
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
  // The inspector is never blank on a wide screen: the newest thread is selected until you pick one.
  if (wide() && !host.querySelector(`[data-slack-row="${CSS.escape(ui.sel)}"]`)) { ui.sel = host.querySelector("[data-slack-row]")?.dataset.slackRow || ""; for (const node of host.querySelectorAll("[data-slack-row]")) node.setAttribute("aria-selected", String(node.dataset.slackRow === ui.sel)); }
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
// The overlay walks the rows on screen with J/K and keeps this page's selection in step.
const open = (node) => node && openSlackThread(node.dataset.href, "", { list: rows().map((row) => row.dataset.href), onStep: (href) => { const next = rows().find((row) => row.dataset.href === href); if (next) select(next.dataset.slackRow, true); } });
const wide = () => matchMedia("(min-width: 1600px)").matches;
function syncUrl() {
  const url = new URL(location.href);
  for (const [name, value] of [["thread", ui.sel], ["group", ui.group === "recent" ? "" : ui.group]]) value ? url.searchParams.set(name, value) : url.searchParams.delete(name);
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
  ui.group = params.get("group") === "channel" ? "channel" : "recent";
  ui.sel = params.get("thread") || ui.sel;
  if (host !== container) {
    host = container;
    container.addEventListener("click", (event) => {
      if (!container.querySelector(".slack-surface")) return;
      const doc = event.target.closest("a[data-planning-path]");
      if (doc && !event.metaKey && !event.ctrlKey) { event.preventDefault(); return planning.peek(doc.dataset.planningPath); }
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
    document.addEventListener("overview-closed", refreshSlackPage); // the thread just read loses its New replies mark
  }
  container.innerHTML = `<p class="code-muted slack-loading">Loading Slack threads…</p>`;
  load().then(() => render()).catch((error) => { container.innerHTML = `<p class="work-warning">${escapeHtml(error.message)}</p>`; });
}

// Favorites and stars elsewhere change; the page redraws its stars when it is showing.
export const refreshSlackPage = () => { if (host?.querySelector(".slack-surface")) render(); };
