// The tab brief: an agent that opens a viewer tab for you passes `?brief=<Markdown>` saying why the tab is open, what
// you're asked to do and the decision waiting. Its first line is the title; the rest renders like any document, so
// `#anchor` links jump to sections and task, PR and issue keys become links. The brief lives in this tab's
// sessionStorage, so it survives navigation and reloads, and a dismissed brief stays a one-click chip.
import { escapeHtml, inlineMarkdown, renderMarkdown } from "./markdown.js";
import { glyph } from "./icons.js";

const KEY = "plan-viewer:brief";

// Reads the brief from the URL, else from this tab's storage. A new brief from the URL replaces the stored one and
// opens; the same brief keeps its dismissed state, so a reload doesn't bring back what you closed. `page` is the
// document the brief came with, which its `#anchor` links point into.
export function loadBrief(search, store) {
  const params = new URLSearchParams(search);
  const fromUrl = params.get("brief")?.trim();
  let saved = null;
  try { saved = JSON.parse(store.getItem(KEY)); } catch {}
  if (fromUrl && fromUrl !== saved?.text) saved = { text: fromUrl, page: params.get("path") || "", dismissed: false };
  if (!saved?.text) return null;
  try { store.setItem(KEY, JSON.stringify(saved)); } catch {}
  return saved;
}

// The first non-empty line is the title (any leading `#` or `**` dropped); the rest is the body.
export function splitBrief(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const at = lines.findIndex((line) => line.trim());
  const title = (lines[at] || "").trim().replace(/^#+\s*/, "").replace(/^\*\*(.+)\*\*$/, "$1");
  return { title, body: lines.slice(at + 1).join("\n").trim() };
}

// Shows the brief, if this tab has one. Links resolve against the document the tab opened on, so `#next-actions`
// names its section; `follow(path, anchor)` opens a document link in place.
export function installBrief({ follow }) {
  const brief = loadBrief(location.search, sessionStorage);
  // The URL stays clean for favorites and history; the tab remembers the brief.
  if (new URLSearchParams(location.search).has("brief")) {
    const url = new URL(location.href);
    url.searchParams.delete("brief");
    history.replaceState(history.state, "", url);
  }
  if (!brief) return;
  const { title, body } = splitBrief(brief.text);
  const panel = Object.assign(document.body.appendChild(document.createElement("aside")), { className: "tab-brief", popover: "manual" });
  panel.setAttribute("aria-label", "Why this tab is open");
  const render = () => {
    panel.classList.toggle("is-collapsed", brief.dismissed);
    panel.innerHTML = brief.dismissed
      ? `<button type="button" class="tab-brief-chip" data-brief-open aria-label="Show why this tab is open: ${escapeHtml(title)}">${glyph("info")}<span>${escapeHtml(title.replace(/[*`]/g, ""))}</span></button>`
      : `<header class="tab-brief-head">${glyph("info")}<strong>${inlineMarkdown(title, brief.page)}</strong><button type="button" class="tab-brief-hide" data-brief-hide aria-label="Hide brief">${glyph("x")}</button></header>${body ? `<div class="markdown tab-brief-body">${renderMarkdown(body, brief.page)}</div>` : ""}`;
  };
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(brief)); } catch {} };
  // A manual popover draws in the top layer, but a modal dialog makes everything outside it inert, so the brief lives
  // inside the newest open modal (the diagram viewer, a PR or issue overview) and is shown again to sit above it.
  const raise = (opened) => {
    const host = opened?.matches(":modal") ? opened : [...document.querySelectorAll("dialog")].filter((dialog) => dialog.matches(":modal")).at(-1) || document.body;
    if (panel.parentElement !== host) host.append(panel);
    if (panel.matches(":popover-open")) panel.hidePopover();
    panel.showPopover();
  };
  // Clicks stay in the brief: the dialog it lives in has its own link and close handlers.
  panel.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target.closest("[data-brief-hide], [data-brief-open]")) {
      brief.dismissed = !brief.dismissed;
      save();
      render();
      return;
    }
    const link = event.target.closest(".markdown-document-link");
    if (!link) return;
    event.preventDefault();
    follow(link.dataset.documentPath, link.dataset.documentAnchor);
  });
  // A dialog opening or closing moves the brief; one that redraws its contents may have taken the brief with it.
  new MutationObserver((records) => {
    const dialogs = records.filter((record) => record.type === "attributes" && record.target.localName === "dialog").map((record) => record.target);
    if (dialogs.length || !panel.isConnected) raise(dialogs.findLast((dialog) => dialog.open));
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
  render();
  raise();
}
