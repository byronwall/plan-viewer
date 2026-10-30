import { escapeHtml, renderMarkdown, SERVICE_ICONS } from "./markdown.js";
import { avatar, hideTip, icon, iconButton, planning, showTip, when } from "./code.js";
import { agentApp, agentName, config } from "./config.js";

const normalName = (name = "") => name.toLowerCase().replace(/[._-]+/g, " ").trim();
import { applyLinkMetadata, collectLinks, linkBrowser, metadataKey, selectDockSource } from "./dock.js";
import { emojiFor, emojify } from "./emoji.js";
import { glyph, GLYPHS } from "./icons.js";

// Slack mrkdwn as the viewer's Markdown: `<url|label>` links, `<@U…|Name>` mentions, `:emoji:` shortcodes,
// single-star bold, bullet glyphs, and single line breaks kept (two plain lines in a row become two paragraphs).
export function slackMarkdown(text = "") {
  const markdown = emojify(text)
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

// `+1::skin-tone-2 (1), eyes (2)` as emoji and counts; a custom emoji keeps its `:name:`.
export function slackReactions(text = "") {
  return text.split(/,\s*/).map((part) => part.match(/^(.+?)(?:::?(skin-tone-[2-6]))? \((\d+)\)$/)).filter(Boolean)
    .map(([, name, tone, count]) => ({ name, emoji: emojiFor(name, tone) || `:${name}:`, count: Number(count) }));
}

// The thread overlay a Slack link opens when `slack.codex` is set: the thread grouped like Slack (one header per run
// of messages from the same person), the planning documents that cite it, its links, find, and a box that opens an
// agent draft about it. The thread is read through the server and cached after the first read.
let dialog = null;
let current = null;
let notify = () => {};
export const setSlackNotice = (show) => { notify = show; };

const keys = () => `<span class="slack-keys"> · <kbd>F</kbd> find · <kbd>L</kbd> links${dialog?.querySelector("[data-slack-new-rule]") ? " · <kbd>N</kbd> new" : ""} · <kbd>O</kbd> Slack · <kbd>R</kbd> refresh</span>`;
const GROUP_GAP = 5 * 60; // seconds between messages that still share one header
// Per-browser memory: the last message read in each thread, and each thread's title for Recently viewed.
const local = (name) => ({
  get(key) { try { return JSON.parse(localStorage.getItem(name) || "{}")[key]; } catch { return undefined; } },
  set(key, value) { try { const all = JSON.parse(localStorage.getItem(name) || "{}"); all[key] = value; localStorage.setItem(name, JSON.stringify(all)); } catch {} },
});
const store = local("slack-last-read");
const titles = local("slack-titles");
export const slackThreadTitle = (href) => titles.get(href) || "Slack thread";
export const rememberSlackTitle = (href, title) => { if (titles.get(href) !== title) titles.set(href, title); };

// Favorites live in app.js; a message's star favorites its own permalink, so it reopens at that message.
let favorites = { toggle: () => {}, has: () => false };
export const setSlackFavorites = (next) => { favorites = next; };
const favoriteHref = (href) => `?slack=${encodeURIComponent(href)}`;
export function refreshSlackStars() {
  for (const button of dialog?.querySelectorAll("[data-slack-star]") || []) {
    const on = favorites.has(favoriteHref(button.dataset.slackStar));
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
    button.dataset.tip = `${on ? "Remove this message from" : "Add this message to"} favorites`;
  }
}

// `?slack=<permalink>` keeps the overlay open across a refresh, like `?issue=`.
function syncSlackUrl(href) {
  const url = new URL(location.href);
  if (href) url.searchParams.set("slack", href); else url.searchParams.delete("slack");
  if (url.href !== location.href) history.replaceState(history.state, "", url);
}

function ensureDialog() {
  if (dialog) return;
  dialog = Object.assign(document.body.appendChild(document.createElement("dialog")), { className: "code-diff issue-overview slack-overview", tabIndex: -1 });
  dialog.innerHTML = `<header class="code-diff-head slack-head" data-o="head"></header><div class="slack-body"><div class="slack-planning" data-o="planning" hidden></div><div class="slack-scroll" data-o="main"></div><form class="slack-composer" data-o="composer"></form></div><div class="doc-dock-panel doc-dock-panel-links slack-links" id="slack-links" popover style="position-anchor: --slack-links" role="dialog" aria-label="Links in this thread"></div>`;
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    dialog.querySelector("#slack-links").hidePopover?.();
    if (current) document.dispatchEvent(new CustomEvent("overview-closed", { detail: location.href })); // the Reopen toast
    syncSlackUrl("");
    current = null;
  });
  // Typed text survives Esc and backdrop clicks; clear it to close.
  dialog.addEventListener("cancel", (event) => {
    const links = dialog.querySelector("#slack-links");
    if (links.matches(":popover-open")) { event.preventDefault(); links.hidePopover(); return; }
    const box = dialog.querySelector(".slack-composer textarea");
    if (box?.value.trim()) { event.preventDefault(); box.focus(); hint("Draft kept — clear the box to close."); }
  });
  let pressedBackdrop = false;
  dialog.addEventListener("pointerdown", (event) => { pressedBackdrop = event.target === dialog; });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) { if (pressedBackdrop && !dialog.querySelector(".slack-composer textarea")?.value.trim()) dialog.close(); return; }
    const doc = event.target.closest("a[data-planning-path]");
    if (doc && !event.metaKey && !event.ctrlKey) { event.preventDefault(); dialog.close(); return planning.open(doc.dataset.planningPath); }
    const source = event.target.closest("[data-dock-source]");
    if (source) return selectDockSource(source);
    if (event.target.closest("[data-slack-close]")) dialog.close();
    else if (event.target.closest("[data-slack-open]")) openInSlack(event.target.closest("[data-slack-open]").dataset.slackOpen);
    else if (event.target.closest("[data-slack-refresh]")) load(true);
    else if (event.target.closest("[data-slack-new]")) jumpToNew();
    else if (event.target.closest("[data-slack-retry]")) load(true);
    else if (event.target.closest("[data-slack-star]")) {
      const button = event.target.closest("[data-slack-star]");
      const message = current.thread.messages.find((candidate) => permalink(candidate.ts) === button.dataset.slackStar);
      rememberSlackTitle(button.dataset.slackStar, `${current.thread.channelName || "Slack"} · ${message?.author}: ${(message?.text || "").replace(/<[^>|]*\|([^>]*)>/g, "$1").replace(/<([^>]*)>/g, "$1").replace(/\s+/g, " ").slice(0, 50)}`);
      favorites.toggle(favoriteHref(button.dataset.slackStar));
    }
  });
  dialog.addEventListener("pointerover", (event) => { const target = event.target.closest("[data-tip]"); if (target) showTip(target); else hideTip(); });
  dialog.addEventListener("pointerleave", hideTip);
  dialog.addEventListener("input", (event) => {
    if (event.target.matches("[data-slack-find]")) find(event.target.value);
    if (event.target.matches(".slack-composer textarea")) { fitComposer(event.target); hint(); }
  });
  dialog.addEventListener("submit", (event) => { event.preventDefault(); discuss(); });
  dialog.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    const field = event.target.closest?.("input, textarea");
    if (field?.matches("[data-slack-find]")) {
      if (key === "enter") { event.preventDefault(); stepMatch(event.shiftKey ? -1 : 1); }
      else if (key === "escape") { event.preventDefault(); event.target.value ? (event.target.value = "", find("")) : event.target.blur(); }
      return;
    }
    if (field) {
      if (key === "enter" && !event.shiftKey) { event.preventDefault(); discuss(); }
      return;
    }
    if (key === "o") openInSlack();
    else if (key === "r") load(true);
    else if (key === "f" || key === "/") dialog.querySelector("[data-slack-find]")?.focus();
    else if (key === "d") dialog.querySelector(".slack-composer textarea")?.focus();
    else if (key === "l") dialog.querySelector("#slack-links").togglePopover();
    else if (key === "n") jumpToNew();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
}

function openInSlack(href = current?.href) {
  if (!href) return;
  fetch("/api/open-slack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: href }) })
    .then((response) => { if (!response.ok) throw new Error(); })
    .catch(() => window.open(href, "_blank", "noreferrer"));
}

const day = (seconds) => new Date(seconds * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: new Date(seconds * 1000).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
const clock = (seconds) => new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const stamp = (seconds) => `<time data-tip="${escapeHtml(new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }))}">${clock(seconds)}</time>`;
const permalink = (ts) => {
  const parent = current.thread.messages[0].ts;
  return `${current.href.replace(/\/p\d{16}.*$/, "")}/p${ts.replace(".", "")}${ts === parent ? "" : `?thread_ts=${parent}`}`;
};

// Tasks first, then plans and notes that link any message in the thread; `messages` maps a message to its citers.
function citations() {
  const prefix = `${current.channel}/${current.thread.messages[0].ts}/`;
  const docs = planning.documents().filter((doc) => doc.slackLinks?.some((link) => link.startsWith(prefix)))
    .sort((a, b) => !!b.task - !!a.task || (b.date || b.task?.updated || "").localeCompare(a.date || a.task?.updated || ""));
  const messages = new Map();
  for (const doc of docs) for (const link of doc.slackLinks) if (link.startsWith(prefix)) messages.set(link.slice(prefix.length), [...(messages.get(link.slice(prefix.length)) || []), doc]);
  return { docs, messages };
}
const docLabel = (doc) => doc.task?.id || doc.date || doc.kind;
const docLink = (doc, title = true) => `<a href="?${new URLSearchParams({ path: doc.path })}" data-planning-path="${escapeHtml(doc.path)}" data-tip="${escapeHtml(`${doc.task?.title || doc.title} · ${doc.path}`)}">${doc.task ? SERVICE_ICONS.task : icon("doc")}<code>${escapeHtml(docLabel(doc))}</code>${title ? `<span>${escapeHtml(doc.task?.title || doc.title)}</span>` : ""}</a>`;

function renderHead(state, detail = "") {
  const thread = current.thread;
  const me = normalName(config().user);
  const others = thread ? [...new Set(thread.messages.map((message) => message.author))].filter((author) => normalName(author) !== me && !normalName(author).startsWith(`${me} `)) : [];
  const name = thread?.channelName || current.channelHint || (current.channel.startsWith("D") ? (others.length ? `DM with ${others.join(", ")}` : "Direct message") : "Slack thread");
  const parent = thread?.messages[0];
  const replies = thread ? thread.messages.length - 1 : 0;
  const people = thread ? [...thread.messages.reduce((all, message) => all.set(message.author, { ...message, count: (all.get(message.author)?.count || 0) + 1 }), new Map()).values()].sort((a, b) => b.count - a.count) : [];
  const fresh = thread && Date.now() - new Date(thread.fetchedAt) < 60_000;
  const facts = state === "loading" ? "Reading the thread…" : state === "error" ? escapeHtml(detail)
    : [`Started by <b>${escapeHtml(parent.author)}</b> on ${day(Number(parent.ts))}`, replies ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "no replies", replies ? `last ${when(Number(thread.messages.at(-1).ts) * 1000)} ago` : "", `synced ${fresh ? "just now" : `${when(thread.fetchedAt)} ago`}`].filter(Boolean).join(" · ");
  const faces = people.length > 1 ? `<span class="slack-people">${people.slice(0, 8).map((person) => `<span data-tip="${escapeHtml(`${person.author} · ${person.count} message${person.count === 1 ? "" : "s"}`)}">${avatar("", person.author, person.email)}</span>`).join("")}${people.length > 8 ? `<span class="code-muted" data-tip="${escapeHtml(people.slice(8).map((person) => person.author).join(", "))}">+${people.length - 8}</span>` : ""}</span>` : "";
  const links = state === "ready" ? `<button type="button" class="doc-dock-button slack-links-button" popovertarget="slack-links" style="anchor-name: --slack-links" data-tip="Links in this thread (L)"><span class="doc-dock-icon">${glyph("link", "dock-glyph")}</span><span class="doc-dock-label">Links</span><span class="doc-dock-badge" data-slack-link-count>0</span></button>` : "";
  const find = state === "ready" ? `<label class="code-filter slack-find"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.search}</svg><input type="search" data-slack-find placeholder="Find in thread" spellcheck="false" autocomplete="off"><span class="code-muted" data-slack-find-count></span><kbd>F</kbd></label>` : "";
  dialog.querySelector('[data-o="head"]').innerHTML = `<span class="slack-overview-mark${state === "loading" ? " issue-reading" : ""}">${state === "loading" ? icon("refresh") : SERVICE_ICONS.slack}</span><div class="issue-overview-title"><h3>${escapeHtml(name)}</h3><p class="code-muted">${facts}</p></div>${faces}<span class="code-spacer"></span>${find}${links}${iconButton("external", "Open in Slack (O)", "data-slack-open")}${iconButton("refresh", "Read again (R)", "data-slack-refresh")}${iconButton("fail", "Close (Esc)", "data-slack-close")}`;
}

function renderThread(scrollToLinked = true) {
  const { thread, href } = current;
  const linked = new URL(href).pathname.match(/p(\d{10})(\d{6})$/)?.slice(1).join(".");
  const lastRead = store.get(current.key);
  const { docs, messages: cited } = citations();
  const planningStrip = dialog.querySelector('[data-o="planning"]');
  planningStrip.hidden = !docs.length;
  planningStrip.innerHTML = docs.length ? `<span class="slack-planning-label">${glyph("corner-up-left", "dock-glyph")} Linked from</span>${docs.map((doc) => docLink(doc)).join("")}` : "";
  // Mentions read as people; the authors cover most names, and the raw text adds anyone only mentioned.
  const names = [...new Set([...thread.messages.map((message) => message.author), ...thread.messages.flatMap((message) => [...message.text.matchAll(/<@\w+\|([^>]+)>/g)].map((match) => match[1]))])].filter(Boolean).sort((a, b) => b.length - a.length);
  const mentions = (html) => names.reduce((out, name) => out.replaceAll(`@${escapeHtml(name)}`, `<span class="slack-mention">@${escapeHtml(name)}</span>`), html);
  let previous = null;
  let newShown = false;
  const rows = thread.messages.map((message, index) => {
    const seconds = Number(message.ts);
    const out = [];
    if (!previous || day(Number(previous.ts)) !== day(seconds)) out.push(`<li class="slack-day" role="separator"><span>${day(seconds)}</span></li>`);
    if (index === 1) out.push(`<li class="slack-replies-rule" role="separator"><span>${thread.messages.length - 1} ${thread.messages.length === 2 ? "reply" : "replies"}</span></li>`);
    if (lastRead && !newShown && index > 0 && message.ts > lastRead) { newShown = true; out.push(`<li class="slack-new" role="separator" data-slack-new-rule><span>New since you last read</span></li>`); }
    const continued = previous && index > 1 && previous.author === message.author && seconds - Number(previous.ts) < GROUP_GAP && !out.length;
    const marks = index ? (cited.get(message.ts) || []).map((doc) => docLink(doc, false)).join("") : ""; // the parent's citers are the strip
    const reactions = slackReactions(message.reactions).map((reaction) => `<span data-tip="${escapeHtml(`:${reaction.name}: · ${reaction.count}`)}">${escapeHtml(reaction.emoji)}<small>${reaction.count}</small></span>`).join("");
    const cites = marks ? `<span class="slack-cites">${marks}</span>` : "";
    const head = continued ? `<span class="slack-gutter-time">${clock(seconds)}</span>${cites}` : `${avatar("", message.author, message.email)}<header><b>${escapeHtml(message.author || "Unknown")}</b>${stamp(seconds)}${cites}</header>`;
    const classes = [index === 0 && "is-parent", continued && "is-continued", message.ts === linked && "is-linked", lastRead && index > 0 && message.ts > lastRead && "is-new"].filter(Boolean).join(" ");
    out.push(`<li class="slack-message ${classes}" data-ts="${message.ts}">${head}<div class="slack-message-body"><div class="markdown issue-markdown">${mentions(renderMarkdown(slackMarkdown(message.text), ""))}</div>${message.files?.length ? `<div class="slack-files">${message.files.map((file) => `<span data-tip="Attached in Slack; open the message to see it">${icon("doc")}${escapeHtml(file)}</span>`).join("")}</div>` : ""}${reactions ? `<div class="slack-reactions">${reactions}</div>` : ""}</div><span class="slack-message-actions"><button type="button" class="code-icon-button slack-star" data-slack-star="${escapeHtml(permalink(message.ts))}" aria-pressed="false" data-tip="Add this message to favorites"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.star}</svg></button>${iconButton("external", "Open this message in Slack", `data-slack-open="${escapeHtml(permalink(message.ts))}"`)}</span></li>`);
    previous = message;
    return out.join("");
  }).join("");
  const main = dialog.querySelector('[data-o="main"]');
  main.innerHTML = `<ol class="slack-thread">${rows}</ol>`;
  store.set(current.key, thread.messages.at(-1).ts);
  titles.set(current.href, `${thread.channelName || "Slack"} · ${thread.messages[0].text.replace(/<[^>|]*\|([^>]*)>/g, "$1").replace(/<([^>]*)>/g, "$1").replace(/\s+/g, " ").slice(0, 60)}`);
  renderLinks();
  refreshSlackStars();
  const target = main.querySelector(".slack-message.is-linked:not(.is-parent)") || (lastRead && main.querySelector("[data-slack-new-rule]"));
  if (target && scrollToLinked) target.scrollIntoView({ block: "center", behavior: "instant" });
}

// The dock's link browser over every link in the thread, with titles and states from the link metadata.
async function renderLinks() {
  const panel = dialog.querySelector("#slack-links");
  const groups = collectLinks(dialog, planning.documents(), "", ".slack-thread .markdown a[href]");
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const count = dialog.querySelector("[data-slack-link-count]");
  if (count) { count.textContent = String(total); count.closest("button").hidden = !total; }
  panel.style.minHeight = "";
  panel.innerHTML = total ? linkBrowser(groups) : "";
  const keys = [...new Set([...dialog.querySelectorAll(".slack-thread a[href], #slack-links a[href]")].map((link) => link.dataset.metaKey || metadataKey(link.href)).filter(Boolean))];
  if (!keys.length) return;
  const opened = current;
  try {
    const response = await fetch("/api/link-metadata", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys }) });
    if (response.ok && current === opened) applyLinkMetadata(dialog, (await response.json()).metadata || {});
  } catch {}
}

function renderComposer() {
  const form = dialog.querySelector('[data-o="composer"]');
  form.innerHTML = `<textarea rows="1" placeholder="Ask ${escapeHtml(agentName())} about this thread…" aria-label="Ask ${escapeHtml(agentName())} about this thread"></textarea><button type="submit" class="code-bar-button is-primary">${icon("discuss")}Discuss in ${escapeHtml(agentName())}</button><p class="slack-composer-hint code-muted" data-slack-hint><kbd>Enter</kbd> opens a draft with the thread attached · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line${keys()}</p>`;
}
const hint = (message = "", error = false) => {
  const line = dialog.querySelector("[data-slack-hint]");
  if (!line) return;
  line.classList.toggle("is-error", error);
  line.innerHTML = message ? escapeHtml(message) : `<kbd>Enter</kbd> opens a draft with the thread attached · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line${keys()}`;
};
function fitComposer(box) {
  box.style.height = "0px";
  box.style.height = `${Math.min(box.scrollHeight + 2, 200)}px`;
}

async function discuss() {
  if (!current?.thread) return;
  const box = dialog.querySelector(".slack-composer textarea");
  const button = dialog.querySelector(".slack-composer button");
  button.disabled = true;
  hint(`Opening a draft in ${agentName()}…`);
  try {
    const response = await fetch("/api/slack/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: agentApp(), url: current.href, request: box.value }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not open the draft.");
    box.value = "";
    fitComposer(box);
    hint();
    notify(`Drafted a discussion of this thread in ${agentName()}. Review it and press Enter to send.`);
  } catch (error) {
    hint(error.message, true);
  } finally {
    button.disabled = false;
  }
}

// Find dims the messages without a match and marks each match; Enter and Shift+Enter step through them.
let matches = [];
let matchAt = -1;
function find(query) {
  for (const mark of dialog.querySelectorAll("mark.slack-hit")) mark.replaceWith(mark.textContent);
  for (const body of dialog.querySelectorAll(".slack-message-body")) body.normalize();
  const terms = query.trim().toLowerCase();
  const messages = [...dialog.querySelectorAll(".slack-message")];
  matches = [];
  matchAt = -1;
  for (const message of messages) {
    let hit = false;
    if (terms) {
      const walker = document.createTreeWalker(message.querySelector(".slack-message-body"), NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        let at = node.textContent.toLowerCase().indexOf(terms);
        let rest = node;
        while (at >= 0) {
          const match = rest.splitText(at);
          rest = match.splitText(terms.length);
          const mark = Object.assign(document.createElement("mark"), { className: "slack-hit", textContent: match.textContent });
          match.replaceWith(mark);
          matches.push(mark);
          hit = true;
          at = rest.textContent.toLowerCase().indexOf(terms);
        }
      }
      hit ||= message.querySelector("header b")?.textContent.toLowerCase().includes(terms);
    }
    message.classList.toggle("is-dimmed", Boolean(terms) && !hit);
  }
  const count = dialog.querySelector("[data-slack-find-count]");
  if (count) count.textContent = terms ? `${matches.length || "No"} match${matches.length === 1 ? "" : "es"}` : "";
  if (matches.length) stepMatch(1);
}
function stepMatch(step) {
  if (!matches.length) return;
  matches[matchAt]?.classList.remove("is-current");
  matchAt = (matchAt + step + matches.length) % matches.length;
  matches[matchAt].classList.add("is-current");
  matches[matchAt].scrollIntoView({ block: "center", behavior: "instant" });
  const count = dialog.querySelector("[data-slack-find-count]");
  if (count) count.textContent = `${matchAt + 1} of ${matches.length}`;
}
function jumpToNew() {
  dialog.querySelector("[data-slack-new-rule]")?.scrollIntoView({ block: "start", behavior: "instant" });
}

async function load(refresh = false) {
  if (!current) return;
  const opened = current;
  if (!opened.thread || refresh) renderHead("loading");
  const skeleton = (width) => `<li class="slack-message slack-skeleton" aria-hidden="true"><span class="code-avatar"></span><header><i style="width: 110px"></i></header><div class="slack-message-body"><i style="width: ${width}%"></i></div></li>`;
  if (!opened.thread) dialog.querySelector('[data-o="main"]').innerHTML = `<ol class="slack-thread" aria-busy="true">${[78, 52, 66, 40].map(skeleton).join("")}</ol>`;
  try {
    const response = await fetch(`/api/slack/thread?${new URLSearchParams({ url: opened.href, ...(refresh ? { refresh: "1" } : {}) })}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not read the thread.");
    if (current !== opened) return;
    const main = dialog.querySelector('[data-o="main"]');
    const keep = refresh && opened.thread ? main.scrollTop : null;
    Object.assign(opened, { thread: body, channel: body.channel, key: body.key });
    renderHead("ready");
    renderThread(keep === null);
    if (keep !== null) main.scrollTop = keep;
    hint();
  } catch (error) {
    if (current !== opened) return;
    renderHead("error", error.message);
    if (!opened.thread) dialog.querySelector('[data-o="main"]').innerHTML = `<div class="slack-empty"><p>Couldn't read this thread.</p><button type="button" class="code-bar-button" data-slack-retry>${icon("refresh")}Try again</button><button type="button" class="code-bar-button" data-slack-open>${icon("external")}Open in Slack <kbd>O</kbd></button></div>`;
  }
}

export function openSlackThread(href, channelHint = "") {
  ensureDialog();
  current = { href, channelHint, channel: new URL(href).pathname.split("/")[2] || "" };
  syncSlackUrl(href);
  renderComposer();
  dialog.querySelector('[data-o="planning"]').hidden = true;
  if (!dialog.open) { dialog.showModal(); dialog.focus({ preventScroll: true }); }
  dialog.querySelector('[data-o="main"]').scrollTop = 0;
  load();
}
