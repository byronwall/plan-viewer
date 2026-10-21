import { escapeHtml, isSlackLink, parseUpdates, relativeDate, SERVICE_ICONS } from "./markdown.js";

// The sticky document dock: a thin bar of icon buttons that open the task's working sections, the document's
// outgoing links grouped by source, and its backlinks — without scrolling away from what you're reading.

const ICONS = {
  draft: '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 10.5 12 6a3 3 0 0 1 4.25 4.25l-6 6a4.5 4.5 0 0 1-6.36-6.36l6-6a2 2 0 0 1 2.83 2.83l-6 6a.75.75 0 0 1-1.06-1.06L11 6.32"/></svg>',
  actions: '<svg class="dock-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8h10M9 4.5 12.5 8 9 11.5"/></svg>',
  work: '<svg class="dock-glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.25" width="5" height="3.5" rx="1"/><rect x="9.25" y="10.25" width="5" height="3.5" rx="1"/><path d="M4.25 5.75v4a2.25 2.25 0 0 0 2.25 2.25h2.75"/></svg>',
  updates: '<svg class="dock-glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5"/></svg>',
  links: '<svg class="dock-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2.1-2.1a2.75 2.75 0 0 0-3.9-3.9l-.6.6"/><path d="M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2.1 2.1a2.75 2.75 0 0 0 3.9 3.9l.6-.6"/></svg>',
  backlinks: '<svg class="dock-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5 2.5 8 6 11.5"/><path d="M2.75 8H9.5a4 4 0 0 1 4 4v.5"/></svg>',
  doc: '<svg class="dock-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5.5l3 3v9.5H4z"/><path d="M9.25 1.75v3.25h3.25"/></svg>',
  chat: '<svg class="dock-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.25h11v7.5H7l-3 2.5v-2.5H2.5z"/></svg>',
  web: '<svg class="dock-glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M2.25 8h11.5M8 2.25c1.75 1.9 1.75 9.6 0 11.5M8 2.25c-1.75 1.9-1.75 9.6 0 11.5"/></svg>',
};

const SOURCES = [
  ["tasks", "Tasks", SERVICE_ICONS.task],
  ["github", "GitHub", SERVICE_ICONS.github],
  ["linear", "Linear", SERVICE_ICONS.linear],
  ["jira", "Jira", SERVICE_ICONS.jira],
  ["slack", "Slack", SERVICE_ICONS.slack],
  ["docs", "Documents", ICONS.doc],
  ["chats", "Chats", ICONS.chat],
  ["web", "Web", ICONS.web],
];

// Server lookup keys for external references; the server's /api/link-metadata answers with titles and states.
export function metadataKey(href) {
  let url;
  try { url = new URL(href); } catch { return ""; }
  const github = url.hostname === "github.com" && url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/);
  if (github) return `github:${github[1]}/${github[2]}#${github[3]}`;
  const issue = url.pathname.match(/\/(?:issue|browse)\/([A-Z][A-Z0-9]*-\d+)/);
  if (issue && url.hostname === "linear.app") return `linear:${issue[1]}`;
  if (issue && url.hostname.endsWith(".atlassian.net")) return `jira:${issue[1]}`;
  const slack = url.hostname.endsWith(".slack.com") && url.pathname.match(/^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/);
  if (slack) return `slack:${slack[1]}/${slack[2]}.${slack[3]}${url.searchParams.get("thread_ts") ? `/${url.searchParams.get("thread_ts")}` : ""}`;
  return "";
}

export function applyLinkMetadata(root, metadata) {
  for (const row of root.querySelectorAll(".dock-link[data-meta-key]")) {
    const meta = metadata[row.dataset.metaKey];
    if (!meta) continue;
    if (meta.title) row.querySelector(".dock-link-detail").textContent = meta.title;
    const state = row.querySelector(".dock-link-state");
    if (!row.dataset.metaKey.startsWith("slack:")) {
      state.textContent = meta.state;
      state.dataset.tone = meta.tone;
    }
    row.title = [row.querySelector(".dock-link-label").textContent, meta.title, meta.state, meta.person].filter(Boolean).join(" · ");
    const channel = row.closest(".dock-channel")?.querySelector(".dock-channel-name");
    if (channel && meta.state.startsWith("#")) {
      channel.textContent = meta.state;
      channel.classList.remove("is-unnamed");
      channel.parentElement.removeAttribute("title");
    }
  }
  for (const link of root.querySelectorAll(".chunk-card a.markdown-external-link")) {
    const meta = metadata[metadataKey(link.href)];
    if (!meta) continue;
    // The hover card in app.js reads these; the visible label minus the ↗ mark is its first line.
    link.dataset.meta = JSON.stringify(meta);
    link.dataset.tone = meta.tone || ""; // colors merged/closed/draft references so state reads without opening them
    link.dataset.tip ||= link.textContent.replace(/\u2060/g, "").replace(/\s*↗[\s\S]*$/, "").trim();
  }
}

// Without a Slack API token the permalink itself is the metadata: its `p` timestamp dates the message.
function slackSummary(url, text) {
  const ts = url.pathname.match(/\/p(\d{10})\d*$/)?.[1];
  const date = ts ? new Date(Number(ts) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(Number(ts) * 1000).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) : "Channel";
  return [date, text || url.pathname, url.searchParams.has("thread_ts") ? "Thread" : ts ? "Message" : ""];
}

const linkText = (a) => a.textContent.replace(/\(opens in [^)]*\)/g, "").replace(/[⁠↗→]/g, "").trim();
const docLabel = (doc) => doc?.task ? doc.task.id : doc?.date ? `${doc.kind} · ${doc.date}` : doc?.title;

// Outgoing links, read from the rendered document so every detector (markdown links, bare IDs, task paths) counts.
export function collectLinks(root, documents) {
  const byPath = new Map(documents.map((doc) => [doc.path, doc]));
  const groups = new Map(SOURCES.map(([key]) => [key, new Map()]));
  for (const a of root.querySelectorAll(".chunk-card a[href]")) {
    const path = a.dataset.documentPath;
    if (path) {
      const doc = byPath.get(path);
      const group = /^tasks\/TASK-\d{4}\.md$/.test(path) ? "tasks" : "docs";
      if (!groups.get(group).has(path)) groups.get(group).set(path, { path, label: docLabel(doc) || path, detail: doc?.task?.title || (doc?.date ? path : doc?.title !== docLabel(doc) ? doc?.title : path), status: doc?.task?.status });
      continue;
    }
    const href = a.getAttribute("href");
    if (a.classList.contains("markdown-asset-link") || groups.get("web").has(href)) continue;
    let url;
    try { url = new URL(href); } catch { continue; }
    const text = linkText(a);
    let state = "";
    let group = "web", label = url.hostname.replace(/^www\./, ""), detail = text !== label ? text : url.pathname;
    const github = url.hostname === "github.com" && url.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/);
    const issue = url.pathname.match(/\/(?:issue|browse)\/([A-Z][A-Z0-9]*-\d+)/);
    if (url.hostname === "github.com") [group, label, detail] = ["github", github ? `#${github[4]}` : url.pathname.split("/")[2] || url.pathname.slice(1), github ? `${github[2]} · ${github[3] === "pull" ? "pull request" : "issue"}` : decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "GitHub")];
    else if (url.hostname === "linear.app") [group, label, detail] = ["linear", issue?.[1] || text, issue && text !== issue[1] ? text : "Linear issue"];
    else if (url.hostname.endsWith(".atlassian.net")) [group, label, detail] = ["jira", issue?.[1] || text, issue && text !== issue[1] ? text : "Jira issue"];
    else if (isSlackLink(href)) [group, label, detail, state] = ["slack", ...slackSummary(url, text)];
    else if (url.protocol === "codex:" || url.hostname === "chatgpt.com") [group, label, detail] = ["chats", text || "Conversation", url.protocol === "codex:" ? "Codex" : "ChatGPT"];
    for (const items of groups.values()) if (items.has(href)) group = "";
    if (group) groups.get(group).set(href, { href, label, detail, external: url.protocol !== "codex:", metaKey: metadataKey(href), state, slack: group === "slack", channel: group === "slack" ? url.pathname.split("/")[2] : "" });
  }
  return SOURCES.map(([key, name, icon]) => ({ key, name, icon, items: [...groups.get(key).values()] })).filter((group) => group.items.length);
}

function linkRow(item, icon) {
  const body = `<span class="dock-link-icon">${icon}</span><span class="dock-link-text"><span class="dock-link-label">${escapeHtml(item.label)}</span> <span class="dock-link-detail">${escapeHtml(item.detail || "")}</span></span><span class="dock-link-state"${item.state ? ' data-tone="open"' : ""}>${escapeHtml(item.state || "")}</span>`;
  if (item.path) return `<a class="markdown-document-link dock-link${item.status ? ` task-status-ink-${item.status}` : ""}"${item.current ? ' aria-current="page"' : ""} href="?${new URLSearchParams({ path: item.path })}" data-document-path="${escapeHtml(item.path)}" data-document-anchor="" title="${escapeHtml(`${item.label} ${item.detail || ""}`)}">${body}<span class="dock-link-out" aria-hidden="true">→</span></a>`;
  return `<a class="dock-link${item.slack ? " slack-link" : ""}" href="${escapeHtml(item.href)}"${item.external ? ' target="_blank" rel="noreferrer"' : ""}${item.metaKey ? ` data-meta-key="${escapeHtml(item.metaKey)}"` : ""} title="${escapeHtml(item.href)}">${body}<span class="dock-link-out" aria-hidden="true">↗</span></a>`;
}

// Slack rows sit under their channel, busiest first. Headers show the channel ID until a name arrives with the
// link metadata (from reference/slack-channels.md or a Slack token).
function slackChannels(group) {
  const channels = new Map();
  for (const item of group.items) channels.set(item.channel, [...(channels.get(item.channel) || []), item]);
  return [...channels].sort((a, b) => b[1].length - a[1].length).map(([channel, items]) => `<section class="dock-channel"><h4 class="dock-channel-heading" data-slack-channel="${escapeHtml(channel)}" title="Name this channel in reference/slack-channels.md"><span class="dock-channel-name is-unnamed">${escapeHtml(channel.startsWith("D") ? "Direct message" : channel)}</span><small>${items.length}</small></h4>${items.map((item) => linkRow(item, group.icon)).join("")}</section>`).join("");
}

// Sources down the left, one source's links on the right; the first source starts selected.
function linkBrowser(groups) {
  const tabs = groups.map((group, index) => `<button type="button" class="dock-source" role="tab" data-dock-source="${group.key}" aria-selected="${index === 0}"><span class="dock-link-icon">${group.icon}</span><span>${escapeHtml(group.name)}</span><small>${group.items.length}</small></button>`).join("");
  const rows = (group) => group.key === "slack" ? slackChannels(group) : group.items.map((item) => linkRow(item, group.icon)).join("");
  const panes = groups.map((group, index) => `<div class="dock-source-list" role="tabpanel" data-dock-source-list="${group.key}"${index === 0 ? "" : " hidden"}>${rows(group)}</div>`).join("");
  return `<div class="dock-link-browser"><div class="dock-sources" role="tablist" aria-orientation="vertical">${tabs}</div><div class="dock-source-lists">${panes}</div></div>`;
}

function countUpdates(markdown) {
  const headings = markdown.match(/^###\s/gm)?.length || 0;
  return headings || markdown.match(/^[-*]\s/gm)?.length || 0;
}

function progressRing(done, total) {
  const length = 2 * Math.PI * 5.5;
  return `<svg class="dock-ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="5.5" stroke-dasharray="${(done / total) * length} ${length}"/></svg>`;
}

// `body(chunk)` renders a chunk exactly as the page does; the panels reuse it so actions stay launchable.
export function renderDock({ doc, documents, links, body }) {
  const chunk = (pattern) => doc.chunks.find((candidate) => pattern.test(candidate.title));
  const actions = chunk(/^(next actions|next steps)$/i);
  const work = chunk(/^work breakdown$/i);
  const updates = chunk(/^updates$/i);
  const backlinks = [...(documents.find((candidate) => candidate.path === doc.path)?.backlinks || [])]
    .map((path) => documents.find((candidate) => candidate.path === path))
    .filter(Boolean)
    .sort((a, b) => (b.date || b.task?.updated || "").localeCompare(a.date || a.task?.updated || "") || a.path.localeCompare(b.path));
  // Supporting documents an agent filed under the task's `TASK-NNNN-assets/` folder. An asset page lists its siblings
  // the same way, with the parent task first, so the task's other files are one click away.
  const taskId = doc.task?.id || doc.path.match(/^tasks\/(TASK-\d{4})-assets\//)?.[1];
  const assetsDir = `tasks/${taskId}-assets/`;
  const parentTask = !doc.task && documents.find((candidate) => candidate.path === `tasks/${taskId}.md`);
  const subDocuments = taskId ? documents.filter((candidate) => candidate.path.startsWith(assetsDir)) : [];
  const linkCount = links.reduce((sum, group) => sum + group.items.length, 0);
  const leaves = (doc.work?.nodes || []).filter((node) => !doc.work.nodes.some((child) => child.parent === node.id));
  const doneLeaves = leaves.filter((node) => node.status === "completed").length;
  const readyActions = (doc.nextActions || []).filter((action) => !action.blocked).length;

  const items = [];
  const add = (key, label, icon, badge, title, meta, content, jump) => items.push({ key, label, icon, badge, title, meta, content, jump });
  if (actions) add("actions", "Next actions", ICONS.actions, `${readyActions || (doc.nextActions || []).length}`, actions.title, readyActions ? `${readyActions} ready of ${(doc.nextActions || []).length}` : `${(doc.nextActions || []).length} recorded`, body(actions), actions.id);
  if (work && leaves.length) add("work", "Work", progressRing(doneLeaves, leaves.length), `${doneLeaves}/${leaves.length}`, work.title, `${doneLeaves} of ${leaves.length} items completed`, body(work), work.id);
  const entries = updates && parseUpdates(updates.markdown);
  const latest = entries?.map((entry) => entry.date).sort().at(-1);
  if (updates) add("updates", "Updates", ICONS.updates, `${entries?.length || countUpdates(updates.markdown) || ""}`, updates.title, latest ? `Latest ${relativeDate(latest)} · ${entries.length} ${entries.length === 1 ? "entry" : "entries"}` : "Recorded in the task", body(updates), updates.id);
  if (subDocuments.length) add("documents", "Documents", ICONS.doc, `${subDocuments.length}`, "Task documents", `${subDocuments.length} in ${taskId}-assets`, `<div class="dock-source-list">${parentTask ? linkRow({ path: parentTask.path, label: taskId, detail: parentTask.task?.title || parentTask.title, status: parentTask.task?.status }, SERVICE_ICONS.task) : ""}${subDocuments.map((sub) => linkRow({ path: sub.path, label: sub.title, detail: sub.path.slice(assetsDir.length), current: sub.path === doc.path }, ICONS.doc)).join("")}</div>`);
  add("links", "Links", ICONS.links, `${linkCount}`, "Links out", linkCount ? `${linkCount} across ${links.length} ${links.length === 1 ? "source" : "sources"}` : "No links in this document", linkCount ? linkBrowser(links) : '<p class="dock-empty">This document doesn\'t link anywhere yet.</p>');
  add("backlinks", "Backlinks", ICONS.backlinks, `${backlinks.length}`, "Linked from", backlinks.length ? `${backlinks.length} ${backlinks.length === 1 ? "document links" : "documents link"} here` : "Nothing links here yet", backlinks.length
    ? `<div class="dock-source-list">${backlinks.map((source) => linkRow({ path: source.path, label: docLabel(source), detail: source.task?.title || source.title, status: source.task?.status }, source.task ? SERVICE_ICONS.task : ICONS.doc)).join("")}</div>`
    : '<p class="dock-empty">No other document mentions this one yet.</p>');

  return `<div class="doc-dock" data-doc-dock><div class="doc-dock-bar">
    <span class="doc-dock-title" aria-hidden="true">${escapeHtml(doc.task ? `${doc.task.id} · ${doc.title}` : doc.title)}</span>
    <div class="doc-dock-buttons" role="toolbar" aria-label="Document overview"><button type="button" class="doc-dock-button doc-dock-draft" data-dock-draft aria-haspopup="dialog" aria-controls="handoff-popover" aria-expanded="false" title="Open an agent draft for ${escapeHtml(doc.path)}"><span class="doc-dock-icon">${ICONS.draft}</span><span class="doc-dock-label">Draft</span></button><span class="doc-dock-divider" aria-hidden="true"></span>${items.map((item) => `<button type="button" class="doc-dock-button" popovertarget="dock-${item.key}" aria-expanded="false" style="anchor-name: --dock-${item.key}" title="${escapeHtml(item.meta)}"><span class="doc-dock-icon">${item.icon}</span><span class="doc-dock-label">${escapeHtml(item.label)}</span>${item.badge && item.badge !== "0" ? `<span class="doc-dock-badge">${escapeHtml(item.badge)}</span>` : ""}</button>`).join("")}</div>
  </div>${items.map((item) => `<div class="doc-dock-panel doc-dock-panel-${item.key}" id="dock-${item.key}" popover style="position-anchor: --dock-${item.key}" role="dialog" aria-label="${escapeHtml(item.title)}">
    <header class="doc-dock-panel-header"><span class="doc-dock-icon">${item.icon}</span><div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.meta)}</p></div>${item.jump ? `<button type="button" class="doc-dock-jump" data-dock-jump="${escapeHtml(item.jump)}">Go to section <span aria-hidden="true">↓</span></button>` : ""}</header>
    <div class="doc-dock-panel-body">${item.content}</div>
  </div>`).join("")}</div>`;
}
