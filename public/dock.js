import { escapeHtml, isSlackLink, parseUpdates, relativeDate, SERVICE_ICONS } from "./markdown.js";
import { glyph } from "./icons.js";

// The sticky document dock: a thin bar of icon buttons that open the task's working sections, the document's
// outgoing links grouped by source, and its backlinks — without scrolling away from what you're reading.

const ICONS = {
  draft: glyph("pen-line", "dock-glyph"),
  actions: glyph("arrow-right", "dock-glyph"),
  updates: glyph("history", "dock-glyph"),
  links: glyph("link", "dock-glyph"),
  backlinks: glyph("corner-up-left", "dock-glyph"),
  doc: glyph("file-text", "dock-glyph"),
  chat: glyph("message-square", "dock-glyph"),
  web: glyph("globe", "dock-glyph"),
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
    if (channel && /^[#@]/.test(meta.state)) {
      channel.textContent = meta.state;
      channel.classList.remove("is-unnamed");
      channel.parentElement.removeAttribute("title");
    }
  }
  for (const link of root.querySelectorAll("a.markdown-external-link")) {
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
  return [date, text || url.pathname, url.searchParams.has("thread_ts") ? "Thread" : ""];
}

const linkText = (a) => a.textContent.replace(/\(opens in [^)]*\)/g, "").replace(/[⁠↗→]/g, "").trim();
// Tasks and dated notes lead with their ID or date; other documents lead with their title, with the path under it
// (`where: ""` drops it where the folder is already known).
const docItem = (doc, path, where = path) => doc?.task ? { path, label: doc.task.id, detail: doc.task.title, status: doc.task.status }
  : doc?.date ? { path, label: `${doc.kind} · ${doc.date}`, detail: doc.title }
  : { path, label: "", detail: doc?.title || path, where };

// Outgoing links, read from the rendered document so every detector (markdown links, bare IDs, task paths) counts.
export function collectLinks(root, documents) {
  const byPath = new Map(documents.map((doc) => [doc.path, doc]));
  const groups = new Map(SOURCES.map(([key]) => [key, new Map()]));
  for (const a of root.querySelectorAll(".chunk-card a[href]")) {
    const path = a.dataset.documentPath;
    if (path) {
      const doc = byPath.get(path);
      const group = /^tasks\/TASK-\d{4}\.md$/.test(path) ? "tasks" : "docs";
      if (!groups.get(group).has(path)) groups.get(group).set(path, doc ? docItem(doc, path) : { path, label: "", detail: path });
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
    else if (url.protocol === "codex:" || url.hostname === "chatgpt.com") [group, label, detail] = ["chats", url.protocol === "codex:" ? "Codex" : "ChatGPT", text || "Conversation"];
    for (const items of groups.values()) if (items.has(href)) group = "";
    if (group) groups.get(group).set(href, { href, label, detail, external: url.protocol !== "codex:", metaKey: metadataKey(href), state, slack: group === "slack", channel: group === "slack" ? url.pathname.split("/")[2] : "" });
  }
  return SOURCES.map(([key, name, icon]) => ({ key, name, icon, items: [...groups.get(key).values()] })).filter((group) => group.items.length);
}

// Rows share their list's columns (label, title, state, arrow) so keys, titles and states line up from row to row.
// The icon rides in the label cell; inside the link browser only tasks keep one, since the source rail names the kind.
// Paths break only after a slash, never at a hyphen.
const shownPath = (path) => escapeHtml(path).replaceAll("-", "\u2011").replaceAll("/", "/<wbr>");
function linkRow(item, icon = "") {
  const body = `<span class="dock-link-label">${icon ? `<span class="dock-link-icon">${icon}</span>` : ""}${escapeHtml(item.label || "")}</span><span class="dock-link-detail">${escapeHtml(item.detail || "")}${item.where ? `<span class="dock-link-path">${shownPath(item.where)}</span>` : ""}</span><span class="dock-link-state">${escapeHtml(item.state || "")}</span>`;
  if (item.path) return `<a class="markdown-document-link dock-link${item.status ? ` task-status-ink-${item.status}` : ""}"${item.current ? ' aria-current="page"' : ""} href="?${new URLSearchParams({ path: item.path })}" data-document-path="${escapeHtml(item.path)}" data-document-anchor="" title="${escapeHtml(item.path)}">${body}<span class="dock-link-out" aria-hidden="true">→</span></a>`;
  return `<a class="dock-link${item.slack ? " slack-link" : ""}" href="${escapeHtml(item.href)}"${item.external ? ' target="_blank" rel="noreferrer"' : ""}${item.metaKey ? ` data-meta-key="${escapeHtml(item.metaKey)}"` : ""} title="${escapeHtml(item.href)}">${body}<span class="dock-link-out" aria-hidden="true">↗</span></a>`;
}

// A list without any label or icon drops the label column instead of indenting every title by an empty one.
const linkList = (rows, labeled, attrs = "") => `<div class="dock-source-list${labeled ? "" : " is-unlabeled"}" ${attrs}>${rows}</div>`;

// Slack rows sit under their channel or DM, busiest first. Headers show the ID until a name arrives with the link
// metadata (from reference/slack-channels.md, `- C…: #channel` or `- D…: @Person`, or from a Slack token).
function slackChannels(group) {
  const channels = new Map();
  for (const item of group.items) channels.set(item.channel, [...(channels.get(item.channel) || []), item]);
  return [...channels].sort((a, b) => b[1].length - a[1].length).map(([channel, items]) => {
    const dm = channel.startsWith("D");
    return `<section class="dock-channel"><h4 class="dock-channel-heading" data-slack-channel="${escapeHtml(channel)}" title="Name ${dm ? "this DM" : "this channel"} in reference/slack-channels.md: - ${escapeHtml(channel)}: ${dm ? "@Person" : "#channel-name"}"><span class="dock-channel-name is-unnamed">${dm ? `Direct message <code>${escapeHtml(channel)}</code>` : escapeHtml(channel)}</span><small>${items.length}</small></h4>${items.map((item) => linkRow(item)).join("")}</section>`;
  }).join("");
}

// A tab per source across the top, with "All" first: every link grouped by source, to scroll through in one go.
// 1–9 pick a tab while the panel is open (app.js).
function linkBrowser(groups) {
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const tab = (key, name, icon, count, index) => `<button type="button" class="dock-source" role="tab" data-dock-source="${key}" aria-selected="${index === 0}" title="${escapeHtml(name)} (${index + 1})">${icon ? `<span class="dock-link-icon">${icon}</span>` : ""}<span>${escapeHtml(name)}</span><small>${count}</small></button>`;
  const tabs = [tab("all", "All", "", total, 0), ...groups.map((group, index) => tab(group.key, group.name, group.icon, group.items.length, index + 1))].join("");
  const rows = (group) => group.key === "slack" ? slackChannels(group) : group.items.map((item) => linkRow(item, group.key === "tasks" ? group.icon : "")).join("");
  const labeled = (group) => group.key === "tasks" || group.items.some((item) => item.label);
  const all = groups.map((group) => `<section class="dock-channel dock-group"><h4 class="dock-channel-heading dock-group-heading"><span class="dock-link-icon">${group.icon}</span><span class="dock-channel-name">${escapeHtml(group.name)}</span><small>${group.items.length}</small></h4>${rows(group)}</section>`).join("");
  const panes = linkList(all, true, 'role="tabpanel" data-dock-source-list="all"')
    + groups.map((group) => linkList(rows(group), labeled(group), `role="tabpanel" data-dock-source-list="${group.key}" hidden`)).join("");
  return `<div class="dock-link-browser"><div class="dock-sources" role="tablist">${tabs}</div><div class="dock-source-lists">${panes}</div></div>`;
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
  if (subDocuments.length) add("documents", "Documents", ICONS.doc, `${subDocuments.length}`, "Task documents", `${subDocuments.length} in ${taskId}-assets`, linkList(`${parentTask ? linkRow(docItem(parentTask, parentTask.path), SERVICE_ICONS.task) : ""}${subDocuments.map((sub) => linkRow({ ...docItem(sub, sub.path, ""), current: sub.path === doc.path }, ICONS.doc)).join("")}`, true));
  add("links", "Links", ICONS.links, `${linkCount}`, "Links out", linkCount ? `${linkCount} across ${links.length} ${links.length === 1 ? "source" : "sources"} · 1–${links.length + 1} switch tabs` : "No links in this document", linkCount ? linkBrowser(links) : '<p class="dock-empty">This document doesn\'t link anywhere yet.</p>');
  add("backlinks", "Backlinks", ICONS.backlinks, `${backlinks.length}`, "Linked from", backlinks.length ? `${backlinks.length} ${backlinks.length === 1 ? "document links" : "documents link"} here` : "Nothing links here yet", backlinks.length
    ? linkList(backlinks.map((source) => linkRow(docItem(source, source.path), source.task ? SERVICE_ICONS.task : ICONS.doc)).join(""), true)
    : '<p class="dock-empty">No other document mentions this one yet.</p>');

  return `<div class="doc-dock" data-doc-dock><div class="doc-dock-bar">
    <span class="doc-dock-title" aria-hidden="true">${escapeHtml(doc.task ? `${doc.task.id} · ${doc.title}` : doc.title)}</span>
    <div class="doc-dock-buttons" role="toolbar" aria-label="Document overview"><button type="button" class="doc-dock-button doc-dock-draft" data-dock-draft aria-haspopup="dialog" aria-controls="handoff-popover" aria-expanded="false" title="Open an agent draft for ${escapeHtml(doc.path)}"><span class="doc-dock-icon">${ICONS.draft}</span><span class="doc-dock-label">Draft</span></button><span class="doc-dock-divider" aria-hidden="true"></span>${items.map((item) => `<button type="button" class="doc-dock-button" popovertarget="dock-${item.key}" aria-expanded="false" style="anchor-name: --dock-${item.key}" title="${escapeHtml(item.meta)}"><span class="doc-dock-icon">${item.icon}</span><span class="doc-dock-label">${escapeHtml(item.label)}</span>${item.badge && item.badge !== "0" ? `<span class="doc-dock-badge">${escapeHtml(item.badge)}</span>` : ""}</button>`).join("")}</div>
  </div>${items.map((item) => `<div class="doc-dock-panel doc-dock-panel-${item.key}" id="dock-${item.key}" popover style="position-anchor: --dock-${item.key}" role="dialog" aria-label="${escapeHtml(item.title)}">
    <header class="doc-dock-panel-header"><span class="doc-dock-icon">${item.icon}</span><div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.meta)}</p></div>${item.jump ? `<button type="button" class="doc-dock-jump" data-dock-jump="${escapeHtml(item.jump)}">Go to section <span aria-hidden="true">↓</span></button>` : ""}</header>
    <div class="doc-dock-panel-body">${item.content}</div>
  </div>`).join("")}</div>`;
}
