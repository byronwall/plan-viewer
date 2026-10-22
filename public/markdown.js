import { decorate, lineClasses, markWords } from "./word-diff.js";
import { escapeRegExp, githubSlug, referenceConfig } from "./config.js";

export function escapeHtml(value = "") {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function markdownHeadingId(value = "") {
  return value
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~\[\]]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function markdownHeadingLabel(value = "") {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .trim();
}

export function markdownOutline(markdown = "", minimumLevel = 1) {
  const roots = [];
  const stack = [];
  let inCode = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const match = line.match(/^(#{2,5})\s+(.+)$/);
    if (!match || match[1].length <= minimumLevel) continue;
    const title = markdownHeadingLabel(match[2]);
    const node = { level: match[1].length, title, anchor: markdownHeadingId(match[2]), children: [] };
    while (stack.length && stack.at(-1).level >= node.level) stack.pop();
    if (stack.length) stack.at(-1).children.push(node);
    else roots.push(node);
    stack.push(node);
  }

  return roots;
}

export function markdownExcerpt(markdown = "", maxLength = 560) {
  const plainText = markdown
    .replace(/^```.*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\[[ xX]\]\s+/gm, "")
    .replace(/[`*_~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (plainText.length <= maxLength) return plainText;
  const candidate = plainText.slice(0, maxLength + 1);
  const wordBoundary = candidate.lastIndexOf(" ");
  const end = wordBoundary > maxLength * 0.7 ? wordBoundary : maxLength;
  return `${candidate.slice(0, end).trimEnd()}…`;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Only existing conversations qualify; new-chat and shared-snapshot URLs do not.
export function chatLink(href) {
  try {
    const url = new URL(href);
    if (url.username || url.password || url.port) return null;
    if (url.protocol === "codex:" && url.hostname === "threads" && /^\/[a-z0-9-]+\/?$/i.test(url.pathname) && url.pathname.replaceAll("/", "") !== "new" && !url.search && !url.hash) {
      return { href: url.href, provider: "Codex" };
    }
    if (url.protocol === "https:" && ["chatgpt.com", "chat.openai.com"].includes(url.hostname) && /^\/(?:g\/[^/]+\/)?c\/[a-z0-9-]+\/?$/i.test(url.pathname)) {
      return { href: url.href, provider: "ChatGPT" };
    }
  } catch { /* Unavailable or malformed URLs are not conversation links. */ }
  return null;
}

export function extractChatLinks(markdown = "") {
  const links = new Map();
  // Examples and executable prompts must not create apparent chat associations.
  const prose = markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gm, "").replace(/`[^`\n]*`/g, "");
  for (const match of prose.matchAll(/(?<!!)\[([^\]]+)\]\(([^\s)]+)\)/g)) {
    const link = chatLink(match[2]);
    if (link && !links.has(link.href)) links.set(link.href, { ...link, label: match[1] });
  }
  return [...links.values()];
}

export function renderChatLinks(links = []) {
  const valid = links.filter(link => chatLink(link.href));
  if (!valid.length) return "";
  return `<span class="chat-links" aria-label="Related chats">${valid.map(link => {
    const provider = chatLink(link.href).provider;
    return `<a class="chat-link" href="${escapeHtml(link.href)}" ${provider === "ChatGPT" ? 'target="_blank" rel="noreferrer"' : ""} title="${escapeHtml(link.label)}">${escapeHtml(provider)} · ${escapeHtml(link.label)}&nbsp;<span aria-hidden="true">↗</span></a>`;
  }).join("")}</span>`;
}

export function resolveMarkdownLink(href, currentPath) {
  const value = href.trim();
  if (!value) return { kind: "unavailable" };

  try {
    const repositoryRelative = /^(daily|tasks|plans|reference)\//.test(value) ? `/${value}` : value;
    const url = new URL(repositoryRelative, `https://plan-viewer.local/${currentPath}`);
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (url.origin !== "https://plan-viewer.local") return { kind: "external", href: url.href };
      const path = safeDecode(url.pathname.slice(1));
      if (!/^(daily|plans|reference)\/.+\.(md|txt)$/.test(path) && !/^tasks\/TASK-\d{4}(\.md|-assets\/.+\.(md|txt))$/.test(path)) return { kind: "unavailable" };
      return { kind: "document", path, anchor: safeDecode(url.hash.slice(1)) };
    }
    if (url.protocol === "mailto:") return { kind: "external", href: url.href };
    if (url.protocol === "codex:" && chatLink(value)) return { kind: "app", href: url.href };
  } catch {
    // Malformed and unsafe links remain readable, but never become interactive.
  }

  return { kind: "unavailable" };
}

// Linear uploads need the API key, so the server downloads them once into the workspace's tmp/ and serves the copy.
const LINEAR_UPLOAD = /^https:\/\/uploads\.linear\.app\/[\w./-]+$/;

export function resolveMarkdownAsset(href, currentPath) {
  const value = href.trim();
  if (!value) return { kind: "unavailable" };
  if (LINEAR_UPLOAD.test(value)) return { kind: "remote", href: `/api/linear-image?${new URLSearchParams({ url: value })}` };
  if (/^\/api\/github-image\?[\w=&%./-]+$/.test(value)) return { kind: "remote", href: value };

  try {
    const repositoryRelative = /^(daily|tasks|plans|reference)\//.test(value) ? `/${value}` : value;
    const url = new URL(repositoryRelative, `https://plan-viewer.local/${currentPath}`);
    if (url.origin !== "https://plan-viewer.local" || url.search || url.hash) return { kind: "unavailable" };
    const path = safeDecode(url.pathname.slice(1));
    if (!/^(daily|tasks|plans|reference)\/.+\.(?:png|jpe?g|gif|webp|svg)$/i.test(path)) return { kind: "unavailable" };
    return { kind: "asset", path };
  } catch {
    return { kind: "unavailable" };
  }
}

export function resolveMarkdownAttachment(href, currentPath) {
  const value = href.trim();
  if (!value) return { kind: "unavailable" };

  try {
    const repositoryRelative = /^(daily|tasks|plans|reference)\//.test(value) ? `/${value}` : value;
    const url = new URL(repositoryRelative, `https://plan-viewer.local/${currentPath}`);
    if (url.origin !== "https://plan-viewer.local" || url.search || url.hash) return { kind: "unavailable" };
    const path = safeDecode(url.pathname.slice(1));
    if (!/^(daily|tasks|plans|reference)\/.+\.(?:png|jpe?g|gif|webp|svg|dot)$/i.test(path)) return { kind: "unavailable" };
    return { kind: "asset", path };
  } catch {
    return { kind: "unavailable" };
  }
}

export const SERVICE_ICONS = {
  github: '<svg class="service-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.49c-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z"/></svg>',
  linear: '<svg class="service-icon" viewBox="0 0 100 100" aria-hidden="true"><path d="M1.2 61.5c-.2-1 1-1.6 1.7-.9l36.5 36.5c.7.7.1 1.9-.9 1.7A50 50 0 0 1 1.2 61.5ZM0 46.9c0 .4.1.7.4 1l51.7 51.7c.3.3.6.4 1 .4 2.3-.1 4.6-.4 6.8-.9.8-.2 1-1.1.5-1.6L2.5 39.6c-.5-.5-1.4-.3-1.6.5-.5 2.2-.8 4.5-.9 6.8Zm4.2-17.2c-.2.4-.1.9.2 1.2l64.7 64.7c.3.3.8.4 1.2.2 1.8-.8 3.5-1.7 5.1-2.7.5-.4.6-1.1.2-1.6L8.5 24.4c-.5-.5-1.2-.4-1.6.1-1 1.6-1.9 3.3-2.7 5.2Zm8.4-11.6c-.4-.4-.4-1 0-1.4A50 50 0 1 1 83.3 87.4c-.4.4-1 .4-1.4 0L12.6 18.1Z"/></svg>',
  jira: '<svg class="service-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M15.5 7.5 8.6.6 8 0 2.8 5.2.5 7.5a.7.7 0 0 0 0 1l4.7 4.7L8 16l5.2-5.2.1-.1 2.2-2.2a.7.7 0 0 0 0-1ZM8 10.3 5.7 8 8 5.7 10.3 8 8 10.3Z"/></svg>',
  slack: '<svg class="service-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 1.5a1.5 1.5 0 0 0 0 3h1.5V3A1.5 1.5 0 0 0 6 1.5Zm0 4H2.5a1.5 1.5 0 0 0 0 3H6a1.5 1.5 0 0 0 0-3Zm8.5 1.5a1.5 1.5 0 0 0-3 0v1.5H13A1.5 1.5 0 0 0 14.5 7Zm-4 0V3.5a1.5 1.5 0 0 0-3 0V7a1.5 1.5 0 0 0 3 0ZM10 14.5a1.5 1.5 0 0 0 0-3H8.5V13a1.5 1.5 0 0 0 1.5 1.5Zm0-4h3.5a1.5 1.5 0 0 0 0-3H10a1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 0 0 3 0V7.5H3A1.5 1.5 0 0 0 1.5 9Zm4 0v3.5a1.5 1.5 0 0 0 3 0V9a1.5 1.5 0 0 0-3 0Z"/></svg>',
  task: '<svg class="service-icon is-stroke" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="3"/><path d="m5.6 8.2 1.7 1.7 3.2-3.5"/></svg>',
};

// Slack permalinks open in the desktop app (see /api/open-slack) instead of leaving a dead browser tab behind.
export const isSlackLink = (href) => /^https:\/\/[\w-]+\.slack\.com\/archives\//.test(href);

function serviceIcon(href) {
  if (/^https:\/\/github\.com\//.test(href)) return SERVICE_ICONS.github;
  if (/^https:\/\/linear\.app\//.test(href)) return SERVICE_ICONS.linear;
  if (/^https:\/\/[\w-]+\.atlassian\.net\//.test(href)) return SERVICE_ICONS.jira;
  if (isSlackLink(href)) return SERVICE_ICONS.slack;
  return "";
}

// Word joiners keep an icon with its label, and trailing punctuation with its link, when lines wrap.
const withIcon = (icon, label) => icon ? `${icon}&#8288;${label}` : label;

// Labels over 28 characters clip to 24ch so links stay on one line; app.js shows the full label in a hover card.
function clipLabel(label) {
  const text = label.replace(/<[^>]*>/g, "");
  return text.length <= 28 ? [label, ""] : [`<span class="link-label-clip">${label}</span>`, ` data-tip="${text.replace(/"/g, "&quot;")}"`];
}

function externalLink(href, label) {
  const [shown, tip] = clipLabel(label);
  return `<a class="markdown-external-link${isSlackLink(href) ? " slack-link" : ""}" href="${escapeHtml(href)}" target="_blank" rel="noreferrer"${tip}>${withIcon(serviceIcon(href), shown)}&#8288;<span class="external-mark" aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>&#8288;`;
}

function documentLink(link, label, className = "") {
  const icon = /^tasks\/TASK-\d{4}\.md$/.test(link.path) ? SERVICE_ICONS.task : "";
  const [shown, tip] = clipLabel(label);
  return `<a class="markdown-document-link${className}" href="${escapeHtml(documentHref(link.path, link.anchor))}" data-document-path="${escapeHtml(link.path)}" data-document-anchor="${escapeHtml(link.anchor)}"${tip}>${withIcon(icon, shown)}&#8288;</a>&#8288;`;
}

// References are driven by viewer.config.json (see config.js): a bare `#1234` is a PR in `github.defaultRepo`, `<repo>#1234` a PR in
// one of `github.repos`, `<PREFIX>-1234` an issue in a configured tracker, and `TASK-0001` a planning task. IDs must stand alone,
// not sit inside branch names or paths; text is already HTML-escaped, so skip `&#39;`-style entities.

// Commits: `<repo>@052702c8234c` names its repository explicitly (GitHub's own autolink form). A bare SHA belongs to the repository of the
// nearest earlier PR reference or GitHub link in the same paragraph, else the default repository. Bare SHAs need a digit and a letter so
// words and numbers stay text.
const SHA = /^[0-9a-f]{7,40}$/;
const isCommitSha = (sha, qualified) => SHA.test(sha) && (qualified || (/\d/.test(sha) && /[a-f]/.test(sha)));

let patterns = null;
function referencePatterns() {
  const refs = referenceConfig();
  if (patterns?.refs === refs) return patterns;
  const owner = refs.owner ? escapeRegExp(refs.owner) : "[\\w.-]+";
  patterns = {
    refs,
    mention: new RegExp(`github\\.com/${owner}/(${refs.repoNames})\\b|\\b(${refs.repoNames})[#@]|(?:^|[^\\w&/#])#\\d{3,}\\b`, "gi"),
    commit: new RegExp(`(^|[^\\w/@#&.-])(?:${refs.ownerPattern}(${refs.repoNames})@)?([0-9a-f]{7,40})(?![\\w-])`, "gi"),
    codeCommit: new RegExp(`^(?:${refs.ownerPattern}(${refs.repoNames})@)?([0-9a-f]{7,40})$`, "i"),
  };
  return patterns;
}

export function commitRepo(textBefore) {
  const { mention, refs } = referencePatterns();
  const found = [...textBefore.matchAll(mention)].pop();
  return refs.repos[(found?.[1] || found?.[2] || refs.defaultRepo).toLowerCase()] || "";
}

function commitLink(repo, sha, label) {
  return repo ? externalLink(`https://github.com/${githubSlug(repo)}/commit/${sha}`, label) : label;
}

function linkifyCommits(html, textBefore) {
  const { commit, refs } = referencePatterns();
  return html.replace(commit, (match, lead, repoName, sha, offset) => {
    if (!isCommitSha(sha, repoName)) return match;
    const repo = repoName ? refs.repos[repoName.toLowerCase()] : commitRepo(textBefore + html.slice(0, offset));
    if (!repo) return match;
    const short = sha.slice(0, 8);
    return `${lead}${commitLink(repo, sha, repoName ? `${repo}@${short}` : short)}`;
  });
}

// Slash lists share the first reference's prefix: `TASK-0016/0017/0024`, `ATL-2733/2734`, `#1831/#1872`, `Orbit#2738/2740`. Each item links on its own,
// labelled as written; an item running into `-` or a word (a URL slug such as `ATL-2312/fix-totals`) ends the list before it.
const LIST = "((?:/#?\\d+)*)(?![\\w-]|\\.\\w)";
export const slashListItems = (rest = "") => rest.split("/").slice(1);
const linkList = (first, rest, link) => first + slashListItems(rest).map((item) => `/${link(item.replace("#", ""), item)}`).join("");

function linkifyReferences(html, textBefore = "") {
  const { refs } = referencePatterns();
  const pull = (repo) => (n, label) => externalLink(`https://github.com/${githubSlug(repo)}/pull/${n}`, label);
  const task = (n, label) => documentLink({ path: `tasks/TASK-${n.padStart(4, "0")}.md`, anchor: "" }, label);
  let output = linkifyCommits(html, textBefore)
    .replace(new RegExp(`(^|[^\\w/-])${refs.ownerPattern}(${refs.repoNames})#(\\d+)${LIST}`, "gi"), (_, lead, name, n, rest) => {
      const repo = refs.repos[name.toLowerCase()];
      return lead + linkList(pull(repo)(n, `${repo}#${n}`), rest, pull(repo));
    });
  if (refs.defaultSlug) output = output.replace(new RegExp(`(^|[^\\w&;/#])#(\\d{3,})${LIST}`, "g"), (_, lead, n, rest) => lead + linkList(pull(refs.defaultRepo)(n, `#${n}`), rest, pull(refs.defaultRepo)));
  for (const tracker of refs.trackers) {
    const issue = (n, label) => externalLink(tracker.url.replace("{id}", `${tracker.prefix}-${n}`), label);
    output = output.replace(new RegExp(`(^|[^\\w/-])${tracker.prefix}-(\\d+)${LIST}`, "g"), (_, lead, n, rest) => lead + linkList(issue(n, `${tracker.prefix}-${n}`), rest, issue));
  }
  return output.replace(new RegExp(`(^|[^\\w/-])(TASK-(\\d{4}))${LIST}`, "gi"), (_, lead, id, n, rest) => lead + linkList(task(n, id), rest, task));
}

function formatInlineText(value, currentPath, linkify = true, textBefore = "") {
  let output = escapeHtml(value);
  if (linkify) output = output.split(/(`[^`]+`)/).map((part, i, parts) => i % 2 ? part : linkifyReferences(part, textBefore + parts.slice(0, i).join(""))).join("");
  output = output.replace(/`([^`]+)`/g, (_, code, offset) => {
    const commit = linkify && code.match(referencePatterns().codeCommit);
    const repo = commit && isCommitSha(commit[2], commit[1]) && (commit[1] ? referenceConfig().repos[commit[1].toLowerCase()] : commitRepo(textBefore + output.slice(0, offset)));
    if (repo) {
      return commitLink(repo, commit[2], `<code>${commit[1] ? `${repo}@` : ""}${commit[2].slice(0, 8)}</code>`);
    }
    const link = resolveMarkdownLink(/^TASK-\d{4}$/.test(code) ? `tasks/${code}.md` : code, currentPath);
    if (link.kind !== "document") return `<code>${code}</code>`;
    return documentLink(link, `<code>${code}</code>`, " code-file-link");
  });
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return output;
}

export function documentHref(path, anchor) {
  const query = new URLSearchParams({ path });
  return `?${query}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
}

function assetHref(path) {
  return `/api/asset?${new URLSearchParams({ path })}`;
}

export function inlineMarkdown(value, currentPath = "") {
  const linkPattern = /(!?)\[([^\]]*)\]\(([^\s)]+)\)/g;
  const output = [];
  let cursor = 0;

  for (const match of value.matchAll(linkPattern)) {
    output.push(formatInlineText(value.slice(cursor, match.index), currentPath, true, value.slice(0, cursor)));
    const isImage = match[1] === "!";
    const labelSource = match[2];
    const target = match[3].replace(/^<(.+)>$/, "$1"); // CommonMark's `(<url>)` destination, which Linear writes
    if (isImage) {
      const asset = resolveMarkdownAsset(target, currentPath);
      if (asset.kind === "asset" || asset.kind === "remote") {
        const accessibleLabel = labelSource ? `Open ${labelSource} in image viewer` : "Open image in viewer";
        output.push(`<button class="markdown-image-trigger" type="button" aria-label="${escapeHtml(accessibleLabel)}"><img class="markdown-image" src="${escapeHtml(asset.href || assetHref(asset.path))}" alt="${escapeHtml(labelSource)}" loading="lazy" decoding="async"></button>`);
      } else {
        const label = formatInlineText(labelSource || "Image", currentPath);
        output.push(`<span class="markdown-unavailable-image" role="img" aria-label="Unavailable image: ${escapeHtml(labelSource || "Image")}">${label} <span aria-hidden="true">— image unavailable</span></span>`);
      }
      cursor = match.index + match[0].length;
      continue;
    }

    const label = formatInlineText(labelSource, currentPath, false);
    const link = resolveMarkdownLink(target, currentPath);
    const attachment = link.kind === "unavailable" ? resolveMarkdownAttachment(target, currentPath) : null;
    if (link.kind === "document") {
      output.push(documentLink(link, label));
    } else if (link.kind === "app") {
      output.push(`<a class="markdown-external-link" href="${escapeHtml(link.href)}">${label}&#8288;<span class="external-mark" aria-hidden="true">↗</span><span class="sr-only"> (opens in Codex)</span></a>`);
    } else if (link.kind === "external") {
      output.push(externalLink(link.href, label));
    } else if (attachment?.kind === "asset") {
      output.push(`<a class="markdown-asset-link" href="${escapeHtml(assetHref(attachment.path))}" target="_blank" rel="noreferrer">${label}&#8288;<span class="external-mark" aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>`);
    } else {
      output.push(`<span class="markdown-unavailable-link" title="This target is not available in the plan viewer">${label}</span>`);
    }
    cursor = match.index + match[0].length;
  }

  output.push(formatInlineText(value.slice(cursor), currentPath, true, value.slice(0, cursor)));
  // `**[label](href)**`: the bold markers land in the text on either side of the link.
  return output.join("").replace(/\*\*(<a\b[^>]*>[\s\S]*?<\/a>(?:&#8288;)?)\*\*/g, "<strong>$1</strong>");
}

function splitTableRow(line) {
  const value = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cell = "";
  let inCode = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "`" && value[index - 1] !== "\\") inCode = !inCode;
    if (character === "|" && !inCode && value[index - 1] !== "\\") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells.map((value) => value.replace(/\\\|/g, "|"));
}

// Every rendered table carries its Markdown source; app.js turns these buttons into copies and the table overlay.
const TABLE_TOOLS = `<div class="table-tools" role="toolbar" aria-label="Table actions"><span>Copy</span>${["Markdown", "HTML", "CSV", "TSV"].map((label) => `<button type="button" data-table-copy="${label.toLowerCase()}">${label}</button>`).join("")}<button type="button" data-table-expand aria-label="Open table in an overlay">Expand</button></div>`;

// CSV quotes fields holding a comma, quote or line break; TSV flattens tabs and line breaks so each row stays one line.
export function delimitedTable(rows, delimiter) {
  const field = delimiter === "\t" ? (value) => value.replace(/[\t\r\n]+/g, " ") : (value) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return rows.map((row) => row.map(field).join(delimiter)).join("\n");
}

function tableAlignments(line) {
  const cells = splitTableRow(line);
  if (!cells.length || cells.some((cell) => !/^:?-+:?$/.test(cell))) return null;
  return cells.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

function markdownListItem(line) {
  const match = line.match(/^([ \t]*)([-+*]|\d+\.)\s+(.+)$/);
  if (!match) return null;
  return {
    indent: match[1].replaceAll("\t", "    ").length,
    type: match[2].endsWith(".") ? "ol" : "ul",
    content: match[3],
  };
}

function renderMarkdownList(lines, currentPath) {
  const roots = [];
  const stack = [];

  for (const line of lines) {
    const item = markdownListItem(line);
    if (!item) continue;

    while (stack.length && item.indent < stack.at(-1).indent) stack.pop();

    if (!stack.length || item.indent > stack.at(-1).indent) {
      const parentLists = stack.length ? stack.at(-1).list.items.at(-1).children : roots;
      const list = { type: item.type, items: [] };
      parentLists.push(list);
      stack.push({ indent: item.indent, type: item.type, list, parentLists });
    } else if (item.type !== stack.at(-1).type) {
      const { parentLists } = stack.pop();
      const list = { type: item.type, items: [] };
      parentLists.push(list);
      stack.push({ indent: item.indent, type: item.type, list, parentLists });
    }

    stack.at(-1).list.items.push({ content: item.content, children: [] });
  }

  const renderList = (list) => `<${list.type}>${list.items.map((item) => {
    const task = item.content.match(/^\[([ xX])\]\s+(.+)$/);
    const content = task
      ? `<input class="task-box" type="checkbox" ${task[1].toLowerCase() === "x" ? "checked" : ""} tabindex="-1" aria-hidden="true">${inlineMarkdown(task[2], currentPath)}`
      : inlineMarkdown(item.content, currentPath);
    return `<li>${content}${item.children.map(renderList).join("")}</li>`;
  }).join("")}</${list.type}>`;

  return roots.map(renderList).join("");
}

// Task updates are single bullets in the form `- **2026-10-13 — Title:** body`. Anything else returns null so the
// section falls back to ordinary Markdown.
export function parseUpdates(markdown = "") {
  const lines = markdown.split("\n").filter((line) => line.trim());
  const entries = lines.map((line) => line.match(/^[-*]\s+\*\*(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+?):?\*\*:?\s*(.*)$/));
  if (!entries.length || entries.some((entry) => !entry)) return null;
  return entries.map(([, date, title, body]) => ({ date, title: title.trim(), body: body.trim() }));
}

const DAY = 24 * 60 * 60 * 1000;

export function relativeDate(isoDate, now = new Date()) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(year, month - 1, day)) / DAY);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(days) < 7) return format.format(-days, "day");
  if (Math.abs(days) < 35) return format.format(-Math.round(days / 7), "week");
  if (Math.abs(days) < 365) return format.format(-Math.round(days / 30), "month");
  return format.format(-Math.round(days / 365), "year");
}

const longDate = (isoDate) => new Date(`${isoDate}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });

// Newest first, as a timeline: title with its relative date (absolute on hover) at the right, then the entry body.
export function renderUpdates(markdown, currentPath = "") {
  const entries = parseUpdates(markdown);
  if (!entries) return null;
  const sorted = entries.map((entry, index) => ({ ...entry, index })).sort((a, b) => b.date.localeCompare(a.date) || b.index - a.index);
  return `<div class="markdown"><ol class="update-timeline">${sorted.map((entry) => `<li class="update-entry">
    <div class="update-head"><p class="update-title">${inlineMarkdown(entry.title, currentPath)}</p>
    <time class="update-when" datetime="${entry.date}" title="${escapeHtml(longDate(entry.date))}">${escapeHtml(relativeDate(entry.date).replace(/^\p{Ll}/u, (letter) => letter.toUpperCase()))}</time></div>
    ${entry.body ? `<p class="update-body">${inlineMarkdown(entry.body, currentPath)}</p>` : ""}
  </li>`).join("")}</ol></div>`;
}

// A ```diff (or ```patch) fence colors each line by its leading +, - or @@, edge to edge, as GitHub does.
const DIFF_KINDS = { "+": "add", "-": "del", "@": "hunk" };
export function codeBlock(lines, language = "") {
  if (!/^(diff|patch)$/i.test(language)) return `<pre><code>${escapeHtml(lines.join("\n"))}</code></pre>`;
  const parsed = lines.map((line) => {
    const kind = line.startsWith("@@") ? "hunk" : DIFF_KINDS[line[0]] || "ctx";
    const sign = kind === "add" || kind === "del" ? line[0] : "";
    return { kind, sign, text: sign || line[0] === " " ? line.slice(1) : line }; // a context line's leading space is its sign column
  });
  markWords(parsed);
  const rows = parsed.map((line) => {
    const html = line.marks ? decorate(escapeHtml(line.text), lineClasses(line, false)) : escapeHtml(line.text);
    return `<span class="markdown-diff-${line.kind}"><span class="markdown-diff-sign">${line.sign}</span>${html || " "}</span>`;
  });
  return `<pre class="markdown-diff"><code>${rows.join("")}</code></pre>`;
}

// GitHub bodies write images as raw `<img>` tags; only their src and alt are kept, as Markdown images.
const htmlImages = (markdown) => markdown.replace(/<img\b[^>]*>/gi, (tag) => {
  const attr = (name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1] || "";
  return attr("src") ? `![${attr("alt").replace(/[[\]]/g, "")}](${attr("src")})` : "";
});

export function renderMarkdown(markdown, currentPath = "") {
  const lines = htmlImages(markdown).split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let inCode = false;
  let code = [];
  let language = "";

  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${inlineMarkdown(paragraph.join(" "), currentPath)}</p>`);
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("```")) {
      flushParagraph();
      if (inCode) { html.push(codeBlock(code, language)); code = []; }
      else language = line.slice(3).trim().split(/\s/)[0];
      inCode = !inCode;
      continue;
    }
    if (inCode) { code.push(line); continue; }

    // `<details><summary>…</summary> … </details>`, the collapsible GitHub bodies use; the inside is Markdown.
    if (/^\s*<details>/i.test(line)) {
      flushParagraph();
      const block = [line];
      let depth = 0;
      for (let at = index; ; at += 1) {
        depth += (lines[at].match(/<details>/gi) || []).length - (lines[at].match(/<\/details>/gi) || []).length;
        if (at > index) block.push(lines[at]);
        if (depth <= 0 || at + 1 === lines.length) { index = at; break; }
      }
      const [, summary = "Details", inner = ""] = block.join("\n").match(/^\s*<details>\s*(?:<summary>([\s\S]*?)<\/summary>)?([\s\S]*?)(?:<\/details>\s*)?$/i) || [];
      html.push(`<details class="markdown-details"><summary>${inlineMarkdown(summary.trim(), currentPath)}</summary>${renderMarkdown(inner, currentPath)}</details>`);
      continue;
    }

    if (/^!\[[^\]]*\]\([^\s)]+\)$/.test(line.trim())) {
      flushParagraph();
      html.push(`<figure class="markdown-figure">${inlineMarkdown(line.trim(), currentPath)}</figure>`);
      continue;
    }

    const alignments = index + 1 < lines.length ? tableAlignments(lines[index + 1]) : null;
    const headerCells = alignments ? splitTableRow(line) : [];
    if (alignments && headerCells.length === alignments.length) {
      flushParagraph();
      const rows = [];
      const start = index;
      index += 2;
      while (index < lines.length && lines[index].trim() && splitTableRow(lines[index]).length === headerCells.length) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      const header = headerCells.map((cell, cellIndex) => `<th class="align-${alignments[cellIndex]}" scope="col">${inlineMarkdown(cell, currentPath)}</th>`).join("");
      const body = rows.map((row) => `<tr>${row.map((cell, cellIndex) => `<td class="align-${alignments[cellIndex]}">${inlineMarkdown(cell, currentPath)}</td>`).join("")}</tr>`).join("");
      html.push(`<div class="markdown-table" data-table-source="${escapeHtml(lines.slice(start, index + 1).join("\n"))}">${TABLE_TOOLS}<div class="markdown-table-scroll" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div></div>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quoted = [line];
      while (index + 1 < lines.length && /^\s*>/.test(lines[index + 1])) quoted.push(lines[++index]);
      html.push(`<blockquote>${renderMarkdown(quoted.map((text) => text.replace(/^\s*> ?/, "")).join("\n"), currentPath)}</blockquote>`);
      continue;
    }

    const heading = line.match(/^(#{2,5})\s+(.+)$/);
    const listItem = markdownListItem(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(4, heading[1].length + 1);
      const headingId = markdownHeadingId(heading[2]);
      html.push(`<h${level}${headingId ? ` id="${escapeHtml(headingId)}"` : ""}>${inlineMarkdown(heading[2], currentPath)}</h${level}>`);
    } else if (listItem) {
      flushParagraph();
      const listLines = [line];
      while (index + 1 < lines.length && markdownListItem(lines[index + 1])) listLines.push(lines[++index]);
      html.push(renderMarkdownList(listLines, currentPath));
    } else if (!line.trim()) {
      flushParagraph();
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  if (inCode) html.push(codeBlock(code, language));
  return html.join("");
}
