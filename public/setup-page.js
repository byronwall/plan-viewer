// The Setup page (`?view=setup&tab=…&item=…`): integrations and whether they work, every setting in config/viewer.json,
// every prompt the viewer sends, and the config files. Each tab is one list in the shared row grid (status rail, name
// over one line of detail, value, one action) beside an inspector for the selected row, the same toolbar, list and
// inspector as the Code, Issues and Plans pages. Nothing here signs in or stores a token: each helper opens the note
// popover with a prompt that has an agent do the setup (Enter saves it as an Up next note; the quiet button drafts it
// in the agent app now).
import { escapeHtml, inlineMarkdown, renderMarkdown } from "./markdown.js";
import { agentApp, agentName } from "./config.js";
import { openNotePopover } from "./note-popover.js";
import { GLYPHS, glyph } from "./icons.js";
import { formatDateTime } from "./dates.js";

let data = null;
let host = null;
let notify = () => {};
let installed = false;
let loading = false;
const ui = { tab: "integrations", item: "", query: "", only: "all" };
const fileText = new Map();

const TABS = { integrations: "Integrations", settings: "Settings", prompts: "Prompts", files: "Files" };
const STATE_LABEL = { ok: "Working", missing: "Not working", unused: "Not set up" };
const INT_ORDER = { missing: 0, unused: 1, ok: 2 };
const INT_GROUP = { missing: "Needs attention", unused: "Not set up", ok: "Working" };

async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The viewer couldn't do that.");
  return result;
}
const setupAgent = (body) => post("/api/setup/agent", body);

export async function renderSetupPage(element, options) {
  host = element;
  notify = options.showNotice;
  install();
  const params = new URLSearchParams(location.search);
  ui.tab = params.get("tab") in TABS ? params.get("tab") : "integrations";
  ui.item = params.get("item") || "";
  if (!data) host.innerHTML = `<section class="setup"><p class="code-muted setup-loading">Checking integrations…</p></section>`;
  else draw();
  await load();
}

async function load() {
  loading = true;
  if (data && onPage()) drawTabs();
  try { data = await fetch("/api/setup").then((response) => response.json()); }
  catch (error) { notify(error.message, true); return; }
  finally { loading = false; }
  if (onPage()) draw();
}

const onPage = () => host?.isConnected && host.classList.contains("setup-page");
const json = (value) => JSON.stringify(value);
const pretty = (value) => JSON.stringify(value, null, 2);
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
// The docs table is Markdown: `code`, **bold** and [links](url) render; the row shows its first sentence.
const inline = (text) => inlineMarkdown(text || "");
const firstSentence = (text = "") => text.match(/^.*?[.!?](?=\s|$)/)?.[0] || text;
const markdown = (text) => `<div class="markdown">${renderMarkdown(text)}</div>`;
const codeBlock = (code, language = "") => markdown(`\`\`\`${language}\n${code}\n\`\`\``);
const showSlots = (html) => html.replace(/\{([a-z][\w-]*)\}/g, '<span class="setup-slot">{$1}</span>');
const button = (attrs, label, primary = false) => `<button type="button" class="setup-btn${primary ? " is-primary" : ""}" ${attrs}>${label}</button>`;
const helpButton = (kind, id, label, primary = false) => button(`data-setup-help="${kind}" data-id="${escapeHtml(id)}"`, escapeHtml(label), primary);
const goto = (tab, id, label) => `<button type="button" class="setup-goto" data-setup-goto="${tab}" data-id="${escapeHtml(id)}">${label}</button>`;
const rail = (name, tone, label) => `<span class="setup-rail" data-tone="${tone}" data-tip="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${glyph(name, "setup-glyph")}</span>`;
const size = (bytes) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
const ago = (iso) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return minutes < 60 ? `${Math.max(minutes, 0)}m ago` : minutes < 1440 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
};

// --- Rows: every tab maps its data to the same shape, so every list reads and behaves the same.

const intRail = (row) => row.state === "ok" ? rail("circle-check", "ok", "Working") : row.state === "missing" ? rail("circle-alert", "bad", "Not working") : rail("circle-dashed", "quiet", "Not set up");

function integrationItems() {
  return [...data.integrations].sort((a, b) => INT_ORDER[a.state] - INT_ORDER[b.state]).map((row) => ({
    id: row.id, group: INT_GROUP[row.state], rail: intRail(row),
    name: `<b>${escapeHtml(row.label)}</b><span class="setup-state" data-state="${row.state}">${escapeHtml(row.detail)}</span>`,
    sub: escapeHtml(row.enables),
    act: row.state === "ok" ? "" : helpButton("integration", row.id, "Set up…"),
    search: `${row.label} ${row.detail} ${row.enables} ${row.docs}`,
  }));
}

function valueCell(row) {
  const name = escapeHtml(`setting-${row.key}`), key = escapeHtml(row.key);
  if (row.kind === "boolean") return `<label class="setup-check"><input type="checkbox" name="${name}" data-setting="${key}"${row.value ? " checked" : ""}><span>${row.value ? "On" : "Off"}</span></label>`;
  if (row.kind === "string" || row.kind === "number") {
    return `<input class="setup-input" name="${name}" data-setting="${key}" type="${row.kind === "number" ? "number" : "text"}" value="${escapeHtml(String(row.value ?? ""))}" placeholder="${escapeHtml(row.fallback === "" ? "empty" : String(row.fallback))}" spellcheck="false" autocomplete="off">`;
  }
  return `<span class="setup-value">${summary(row.value)}</span>`;
}

// A list, object or null as one short line; the inspector has the full JSON.
function summary(value) {
  if (value === null || value === undefined) return '<span class="setup-quiet">none</span>';
  const count = Array.isArray(value) ? value.length : Object.keys(value).length;
  if (!count) return '<span class="setup-quiet">empty</span>';
  if (json(value).length <= 30) return `<code>${escapeHtml(json(value))}</code>`;
  return Array.isArray(value) ? plural(count, "item") : plural(count, "key");
}

const scalar = (row) => ["string", "number", "boolean"].includes(row.kind);
const groupOf = (key) => key.includes(".") ? key.split(".")[0] : "general";

function settingItems() {
  // Keys come in docs order, which revisits a group (general keys after github); keep each group together.
  const order = [...new Set(data.settings.map((row) => groupOf(row.key)))];
  const rows = data.settings.filter((row) => ui.only === "all" || row.set).map((row, index) => [row, index]).sort(([a, i], [b, j]) => order.indexOf(groupOf(a.key)) - order.indexOf(groupOf(b.key)) || i - j).map(([row]) => row);
  return rows.map((row) => ({
    id: row.key, group: groupOf(row.key),
    rail: row.set ? rail("circle-dot", "accent", `Set in ${data.file}`) : rail("circle", "quiet", "Default"),
    name: `<code>${escapeHtml(row.key)}</code>${row.restart ? '<span class="setup-tag" data-tip="Read once, when the viewer starts">restart</span>' : ""}`,
    sub: inline(firstSentence(row.meaning)),
    meta: valueCell(row),
    act: scalar(row) ? (row.set ? button(`data-setup-reset="${escapeHtml(row.key)}" data-tip="Remove it from the file so the default applies"`, "Reset") : "") : helpButton("setting", row.key, "Edit…"),
    search: `${row.key} ${row.meaning} ${json(row.value)}`,
  }));
}

function promptItems() {
  const item = (row, group) => ({
    id: row.id, group,
    rail: row.customized ? rail("pen-line", "accent", "Customized in config/prompts/") : rail("file-text", "quiet", row.key ? "From settings" : "Default"),
    name: `<b>${escapeHtml(row.title)}</b>`,
    sub: escapeHtml(row.sent),
    meta: row.customized ? '<span class="setup-meta-accent">Customized</span>' : row.key ? `<code>${escapeHtml(row.key)}</code>` : "",
    act: row.routine ? helpButton("routine", row.id, "Start…") : "",
    search: `${row.title} ${row.sent} ${row.id} ${row.key || ""}`,
  });
  return [
    ...data.prompts.filter((row) => row.routine).map((row) => item(row, "Routines")),
    ...data.prompts.filter((row) => !row.routine).map((row) => item(row, "Buttons")),
    ...data.configured.map((row) => item(row, "From settings")),
  ];
}

function fileItems() {
  return data.files.map((row) => ({
    id: row.path,
    rail: row.secret ? rail("lock", row.exists ? "ok" : "quiet", row.exists ? "Present; holds tokens" : "Not created") : row.exists ? rail("circle-check", "ok", "Present") : rail("circle-dashed", "quiet", "Not created"),
    name: `<code>${escapeHtml(row.path)}</code>`,
    sub: inline(row.purpose),
    meta: row.exists ? `<span class="setup-quiet">${ago(row.modified)} · ${size(row.size)}</span>` : '<span class="setup-quiet">Not created</span>',
    act: row.secret || row.exists ? "" : helpButton("file", row.path, "Create…"),
    search: `${row.path} ${row.purpose} ${row.key}`,
  }));
}

const ITEMS = { integrations: integrationItems, settings: settingItems, prompts: promptItems, files: fileItems };
const matches = (item) => { const words = ui.query.toLowerCase().split(/\s+/).filter(Boolean); const text = item.search.toLowerCase(); return words.every((word) => text.includes(word)); };
const visible = () => ITEMS[ui.tab]().filter(matches);

function rowHtml(item) {
  return `<div class="setup-row" role="option" tabindex="-1" data-setup-row="${escapeHtml(item.id)}" aria-selected="${item.id === ui.item}">
    ${item.rail}
    <span class="setup-text"><span class="setup-name">${item.name}</span><span class="setup-sub">${item.sub}</span></span>
    <span class="setup-meta">${item.meta || ""}</span>
    <span class="setup-act">${item.act}</span>
  </div>`;
}

function listHtml(items) {
  if (!items.length) return `<p class="setup-empty">${ui.query ? `Nothing on this tab matches “${escapeHtml(ui.query)}”.` : ui.only === "set" ? `${data.file} sets no keys yet.` : "Nothing here."}</p>`;
  let group = null;
  return items.map((item) => {
    const head = item.group && item.group !== group ? `<h3 class="setup-group">${escapeHtml(item.group)} <span>${items.filter((other) => other.group === item.group).length}</span></h3>` : "";
    group = item.group;
    return head + rowHtml(item);
  }).join("");
}

// --- Inspector: the full record for the selected row, with its actions.

const facts = (rows) => `<dl class="code-side-facts setup-facts">${rows.filter(([, value]) => value).map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("")}</dl>`;
const section = (title, body, meta = "") => body ? `<section class="setup-insp-section"><h4>${title}${meta ? ` <span>${meta}</span>` : ""}</h4>${body}</section>` : "";
const head = (railHtml, title, sub, acts) => `<header class="setup-insp-head">${railHtml}<h3>${title}</h3></header>${sub ? `<p class="setup-insp-sub">${sub}</p>` : ""}${acts ? `<div class="setup-insp-acts">${acts}</div>` : ""}`;
const settingLinks = (keys) => keys.filter(Boolean).map((key) => goto("settings", key, `<code>${escapeHtml(key)}</code>`)).join(" ");
// Who points at a setting: integrations whose docs name it, files it names, prompts it holds.
const usedBy = (key) => [
  ...data.integrations.filter((row) => row.docs.split(/,\s*/).includes(key)).map((row) => goto("integrations", row.id, escapeHtml(row.label))),
  ...data.files.filter((row) => row.key === key).map((row) => goto("files", row.path, `<code>${escapeHtml(row.path)}</code>`)),
  ...data.configured.filter((row) => row.key === key).map((row) => goto("prompts", row.id, escapeHtml(row.title))),
].join(" ");

function integrationInspector(row) {
  return head(intRail(row), escapeHtml(row.label), `<span class="setup-state" data-state="${row.state}">${escapeHtml(row.detail)}</span>`,
    helpButton("integration", row.id, row.state === "ok" ? "Ask for help…" : "Set up…", row.state !== "ok") + button("data-setup-recheck", "Recheck"))
    + facts([["Status", STATE_LABEL[row.state]], ["Turns on", escapeHtml(row.enables)], ["Settings", settingLinks(row.docs.split(/,\s*/))], ["Check", `<code>${escapeHtml(row.check)}</code>`]])
    + section("Setup steps", `<div class="step-prompt setup-prose">${markdown(row.how)}</div>`, "what the helper asks an agent to do");
}

function settingInspector(row) {
  const acts = (scalar(row) ? "" : helpButton("setting", row.key, "Edit…", true)) + (row.set && scalar(row) ? button(`data-setup-reset="${escapeHtml(row.key)}"`, "Reset to default") : "");
  const same = json(row.value) === json(row.fallback);
  return head(row.set ? rail("circle-dot", "accent", "Set") : rail("circle", "quiet", "Default"), `<code>${escapeHtml(row.key)}</code>`, "", acts)
    + facts([["Source", row.set ? `Set in <code>${escapeHtml(data.file)}</code>` : "Default"], ["Value", scalar(row) ? valueCell(row) : ""], ["Restart", row.restart ? "Read once, when the viewer starts" : ""], ["Used by", usedBy(row.key)]])
    + section("Meaning", `<div class="setup-prose">${markdown(row.meaning || "No entry in docs/configuration.md.")}</div>`)
    + (scalar(row) ? "" : section("Value", codeBlock(pretty(row.value), "json")))
    + (same ? "" : section("Default", codeBlock(pretty(row.fallback), "json")));
}

// Lines of `after` that are new since `before`, and lines of `before` that are gone, by longest common subsequence.
function lineDiff(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push([" ", a[i]]); i++; j++; }
    else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) out.push(["+", b[j++]]);
    else out.push(["-", a[i++]]);
  }
  return out;
}

function promptInspector(row) {
  const configured = Boolean(row.key);
  const acts = configured ? helpButton("setting", row.key, "Edit…", true)
    : (row.routine ? helpButton("routine", row.id, "Start…", true) : "") + helpButton("prompt", row.id, "Edit…", !row.routine) + (row.customized ? button(`data-setup-prompt-reset="${escapeHtml(row.id)}" data-tip="Delete config/prompts/${escapeHtml(row.id)}.md so the default applies"`, "Reset to default") : "");
  const diff = row.customized && row.body !== row.fallback
    ? `<pre class="setup-diff">${lineDiff(row.fallback, row.body).filter(([mark]) => mark !== " ").map(([mark, line]) => `<span class="${mark === "+" ? "is-add" : "is-del"}">${mark} ${escapeHtml(line)}</span>`).join("\n")}</pre>` : "";
  return head(row.customized ? rail("pen-line", "accent", "Customized") : rail("file-text", "quiet", "Default"), escapeHtml(row.title), escapeHtml(row.sent), acts)
    + facts(configured ? [["Setting", settingLinks([row.key])]] : [
      ["Status", row.customized ? `Customized in <code>config/prompts/${escapeHtml(row.id)}.md</code>` : "Default"],
      ["Slots", row.slots?.map((slot) => `<span class="setup-slot">{${escapeHtml(slot)}}</span>`).join(" ") || '<span class="setup-quiet">none</span>'],
    ])
    + section("Changes from the default", diff)
    + section("Text", row.body ? `<div class="step-prompt setup-prose">${showSlots(markdown(row.body))}</div>` : '<p class="setup-quiet">No text.</p>', configured ? "" : "the viewer fills the marked slots");
}

function fileInspector(row) {
  const acts = row.secret ? "" : helpButton("file", row.path, row.exists ? "Edit…" : "Create…", true);
  const text = fileText.get(row.path);
  const contents = row.secret ? '<p class="setup-quiet">Holds tokens, so the viewer never shows it.</p>'
    : !row.exists ? '<p class="setup-quiet">Not created yet.</p>'
    : text === undefined ? '<p class="setup-quiet">Reading…</p>'
    : text instanceof Error ? `<p class="setup-state" data-state="missing">${escapeHtml(text.message)}</p>`
    : row.path.endsWith(".md") ? `<div class="step-prompt setup-prose">${markdown(text)}</div>`
    : codeBlock(text.trimEnd(), row.path.match(/\.(\w+)$/)?.[1] || "");
  return head(row.secret ? rail("lock", "quiet", "Hidden") : row.exists ? rail("circle-check", "ok", "Present") : rail("circle-dashed", "quiet", "Not created"), `<code>${escapeHtml(row.path)}</code>`, inline(row.purpose), acts)
    + facts([["Status", row.exists ? "Present" : "Not created"], ["Changed", row.exists ? `${formatDateTime(row.modified, undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${ago(row.modified)}` : ""], ["Size", row.exists ? size(row.size) : ""], ["Setting", settingLinks([row.key])]])
    + section("Contents", contents);
}

function record(tab = ui.tab, id = ui.item) {
  if (tab === "integrations") return data.integrations.find((row) => row.id === id);
  if (tab === "settings") return data.settings.find((row) => row.key === id);
  if (tab === "prompts") return data.prompts.find((row) => row.id === id) || data.configured.find((row) => row.id === id);
  return data.files.find((row) => row.path === id);
}

function inspectorHtml() {
  const row = record();
  if (!row) return `<p class="code-detail-empty">Select a row to see all of it here.<br><kbd>J</kbd> <kbd>K</kbd> move · <kbd>F</kbd> filter</p>`;
  if (ui.tab === "files" && row.exists && !row.secret && !fileText.has(row.path)) readFile(row.path);
  return { integrations: integrationInspector, settings: settingInspector, prompts: promptInspector, files: fileInspector }[ui.tab](row);
}

async function readFile(path) {
  fileText.set(path, undefined);
  try {
    const response = await fetch(`/api/setup/file?${new URLSearchParams({ path })}`);
    const file = await response.json();
    fileText.set(path, response.ok ? file.text : new Error(file.error || "Couldn't read the file."));
  } catch (error) { fileText.set(path, error); }
  if (ui.tab === "files" && ui.item === path) drawDetail();
}

// --- Getting started: shown above the tabs while the workspace has no daily plan or no task.

function startHtml() {
  if (!data.start || (data.start.plan && data.start.task)) return "";
  const named = data.settings.find((row) => row.key === "user")?.set;
  const done = [data.start.plan, data.start.task, named].filter(Boolean).length;
  const lead = !data.start.task ? "task" : !data.start.plan ? "plan" : "name";
  const row = (ok, name, sub, act) => rowHtml({ id: "", rail: ok ? rail("circle-check", "ok", "Done") : rail("circle-dashed", "quiet", "To do"), name: `<b>${name}</b>`, sub, meta: ok ? '<span class="setup-quiet">Done</span>' : "", act: ok ? "" : act });
  return `<section class="setup-start" aria-labelledby="setup-start">
    <header><h2 id="setup-start">Getting started</h2><span class="code-muted">${done} of 3 done · goes away once there is a daily plan and a task</span></header>
    <p class="setup-start-intro">This workspace is new. Each button saves a prompt for your agent as an Up next note, or opens it in ${escapeHtml(agentName())} now. <code>docs/setup.md</code> in the viewer's checkout covers the whole first run.</p>
    ${row(data.start.task, "A first task", "One real piece of work, with its steps.", helpButton("start", "task", "Write…", lead === "task"))}
    ${row(data.start.plan, "Today's plan", "What you want to get done today, with tasks scheduled. The viewer opens on it.", helpButton("routine", "daily-plan", "Write…", lead === "plan"))}
    ${row(named, "Your name", "The <code>user</code> setting: who the viewer means by you.", button('data-setup-goto="settings" data-id="user" data-focus', "Set…", lead === "name"))}
  </section>`;
}

// --- Drawing. The page is drawn once; tabs, list and inspector redraw on their own so typing never loses focus.

function tabsHtml() {
  const count = (tab) => {
    if (ui.query) { const hits = ITEMS[tab]().filter(matches).length; return `<span class="code-count${hits ? "" : " is-zero"}">${hits}</span>`; }
    if (tab === "integrations") { const bad = data.integrations.filter((row) => row.state === "missing").length; return bad ? `<span class="code-count setup-count-bad" data-tip="${plural(bad, "integration")} not working">${bad}</span>` : `<span class="code-count">${data.integrations.filter((row) => row.state === "ok").length}/${data.integrations.length}</span>`; }
    if (tab === "settings") return `<span class="code-count" data-tip="Set in ${escapeHtml(data.file)}">${data.settings.filter((row) => row.set).length}/${data.settings.length}</span>`;
    if (tab === "prompts") return `<span class="code-count">${data.prompts.length + data.configured.length}</span>`;
    return `<span class="code-count">${data.files.filter((row) => row.exists).length}/${data.files.length}</span>`;
  };
  return Object.entries(TABS).map(([id, label]) => `<button type="button" data-setup-tab="${id}" aria-pressed="${ui.tab === id}">${label} ${count(id)}</button>`).join("");
}

function controlsHtml() {
  if (ui.tab === "settings") return `<span class="code-group-pick"><span class="setup-pick-label">Show</span><div class="code-segment">${[["all", "All"], ["set", "Set in file"]].map(([id, label]) => `<button type="button" data-setup-only="${id}" aria-pressed="${ui.only === id}">${label}</button>`).join("")}</div></span><span class="code-muted">Text, number and on/off keys save as you change them; lists and commands go through <b>Edit…</b>.</span>`;
  if (ui.tab === "integrations") return `<span class="code-muted">Tools and tokens the viewer reads. A helper drafts the setup for an agent; sign-ins and tokens stay with you.</span>`;
  if (ui.tab === "prompts") return `<span class="code-muted"><b>Start…</b> fills a routine in for today. <b>Edit…</b> copies a prompt into <code>config/prompts/</code>, where your copy wins.</span>`;
  return `<span class="code-muted">Files in <code>config/</code> and the others the tooling reads. They are not in the library, so read them here.</span>`;
}

function draw() {
  if (!record()) ui.item = visible()[0]?.id || "";
  host.innerHTML = `<section class="setup code-surface" data-setup-state="ready">
    <div data-region="start">${startHtml()}</div>
    <div data-region="toolbar"><div class="code-toolbar"><div class="code-toolbar-row">
      <div class="code-segment code-tabs" data-region="tabs">${tabsHtml()}</div>
      <label class="code-filter"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.search}</svg><input type="search" data-setup-filter placeholder="Filter every tab  (F)" aria-label="Filter every tab" value="${escapeHtml(ui.query)}" spellcheck="false" autocomplete="off"></label>
      <span class="code-spacer"></span>
      <button type="button" class="code-icon-button setup-recheck${loading ? " is-spinning" : ""}" data-setup-recheck data-tip="Run the integration checks again" aria-label="Recheck integrations"><svg class="code-icon" viewBox="0 0 24 24" aria-hidden="true">${GLYPHS["refresh-cw"]}</svg></button>
    </div><div class="code-controls" data-region="controls">${controlsHtml()}</div></div></div>
    <div class="code-split setup-split"><div class="code-list setup-list" role="listbox" aria-label="${TABS[ui.tab]}" data-region="list"></div><aside class="code-detail setup-detail" data-region="detail" aria-live="polite"></aside></div>
  </section>`;
  drawList();
}

function drawTabs() {
  const tabs = host.querySelector('[data-region="tabs"]');
  if (tabs) tabs.innerHTML = tabsHtml();
  host.querySelector(".setup-recheck")?.classList.toggle("is-spinning", loading);
}

function drawList() {
  const focused = document.activeElement?.dataset?.setting;
  const list = host.querySelector('[data-region="list"]');
  list.setAttribute("aria-label", TABS[ui.tab]);
  list.innerHTML = listHtml(visible());
  host.querySelector('[data-region="controls"]').innerHTML = controlsHtml();
  drawTabs();
  drawDetail();
  highlight();
  if (focused) host.querySelector(`.setup-list [data-setting="${CSS.escape(focused)}"]`)?.focus();
}

function drawDetail() {
  const detail = host.querySelector('[data-region="detail"]');
  if (detail) detail.innerHTML = inspectorHtml();
  const dialog = document.querySelector("dialog.setup-viewer[open]");
  if (dialog) dialog.querySelector(".setup-viewer-body").innerHTML = inspectorHtml();
  highlight();
}

// Matched words get a highlight through the CSS Custom Highlight API, so the rendered rows stay untouched.
function highlight() {
  if (!globalThis.CSS?.highlights) return;
  const words = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) { CSS.highlights.delete("setup-match"); return; }
  const ranges = [];
  for (const scope of host.querySelectorAll(".setup-list .setup-text")) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.data.toLowerCase();
      for (const word of words) for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) {
        const range = new Range();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        ranges.push(range);
      }
    }
  }
  CSS.highlights.set("setup-match", new Highlight(...ranges));
}

function syncUrl() {
  const url = new URL(location.href);
  url.searchParams.set("view", "setup");
  url.searchParams.set("tab", ui.tab);
  if (ui.item) url.searchParams.set("item", ui.item); else url.searchParams.delete("item");
  history.replaceState(history.state, "", url);
}

function select(id, { reveal = false, open = false } = {}) {
  ui.item = id;
  syncUrl();
  for (const row of host.querySelectorAll(".setup-list .setup-row")) row.setAttribute("aria-selected", String(row.dataset.setupRow === id));
  const row = host.querySelector(`.setup-list [data-setup-row="${CSS.escape(id)}"]`);
  if (reveal) row?.scrollIntoView({ block: "nearest", behavior: "instant" });
  drawDetail();
  // Below the inspector breakpoint there is no side panel, so the same inspector opens over the page.
  if (open && host.querySelector('[data-region="detail"]')?.offsetParent === null) openViewer();
}

function switchTab(tab, id = "") {
  ui.tab = tab;
  ui.item = id;
  if (tab === "settings" && id && ui.only === "set" && !record(tab, id)?.set) ui.only = "all";
  if (id && !visible().some((item) => item.id === id)) { ui.query = ""; const filter = host.querySelector("[data-setup-filter]"); if (filter) filter.value = ""; }
  if (!record()) ui.item = visible()[0]?.id || "";
  syncUrl();
  drawList();
  if (id) host.querySelector(`.setup-list [data-setup-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "instant" });
}

function openViewer() {
  let dialog = document.querySelector("dialog.setup-viewer");
  if (!dialog) {
    dialog = Object.assign(document.createElement("dialog"), { className: "setup-viewer" });
    dialog.innerHTML = `<header><button type="button" class="code-icon-button" data-setup-close aria-label="Close" data-tip="Close  (Esc)"><svg class="code-icon" viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.x}</svg></button></header><div class="setup-viewer-body code-detail"></div>`;
    dialog.addEventListener("click", (event) => { if (event.target === dialog || event.target.closest("[data-setup-close]")) dialog.close(); });
    document.body.append(dialog);
  }
  dialog.querySelector(".setup-viewer-body").innerHTML = inspectorHtml();
  if (!dialog.open) dialog.showModal();
}

async function promptReset(id) {
  try {
    data.prompts = (await post("/api/setup/prompt", { id, action: "reset" })).prompts;
    notify(`Reset the ${id} prompt to its default.`);
    drawList();
  } catch (error) { notify(error.message, true); }
}

async function save(key, value, reset = false) {
  try {
    await post("/api/setup/config", { key, value, reset });
    notify(reset ? `Reset ${key} to its default.` : `Saved ${key}.`);
    await load();
  } catch (error) { notify(error.message, true); }
}

function help(button) {
  const kind = button.dataset.setupHelp, id = button.dataset.id;
  const label = kind === "start" ? "first task" : kind === "prompt" || kind === "routine" ? data.prompts.find((row) => row.id === id)?.title || id : kind !== "integration" ? id : data.integrations.find((row) => row.id === id)?.label || id;
  openNotePopover(button, {
    heading: kind === "start" ? "Write the first task" : kind === "routine" ? `${label} for today` : kind === "setting" ? `Configure ${label}` : kind === "prompt" ? `Edit the ${label} prompt` : kind === "file" ? `${button.textContent.replace("…", "")} ${label}` : `Set up ${label}`, notify,
    prompt: async (note) => { const { prompt } = await setupAgent({ kind, id, note, copy: true }); if (kind === "prompt") load(); return prompt; },
    send: { label: `Open in ${agentName()}`, run: async (note) => { await setupAgent({ kind, id, note, app: agentApp() }); notify(`Drafted the ${label} setup in ${agentName()}. Review it and press Enter to send.`); } },
  });
}

// One set of listeners on document, scoped to the page (and its narrow-screen inspector dialog) by class, so redraws
// never stack handlers.
function install() {
  if (installed) return;
  installed = true;
  const inScope = (event) => event.target.closest?.(".setup-page .setup, dialog.setup-viewer");
  document.addEventListener("click", (event) => {
    if (!inScope(event)) return;
    const target = event.target.closest("[data-setup-help], [data-setup-reset], [data-setup-recheck], [data-setup-prompt-reset], [data-setup-goto], [data-setup-tab], [data-setup-only]");
    if (!target) {
      const row = event.target.closest(".setup-list [data-setup-row]");
      if (row && !event.target.closest("input, label, a")) select(row.dataset.setupRow, { open: true });
      return;
    }
    const { dataset } = target;
    if ("setupTab" in dataset) { if (dataset.setupTab !== ui.tab) switchTab(dataset.setupTab); }
    else if ("setupOnly" in dataset) { ui.only = dataset.setupOnly; drawList(); }
    else if ("setupGoto" in dataset) {
      document.querySelector("dialog.setup-viewer[open]")?.close();
      switchTab(dataset.setupGoto, dataset.id);
      if ("focus" in dataset) host.querySelector(`.setup-list [data-setting="${CSS.escape(dataset.id)}"]`)?.focus();
    }
    else if ("setupPromptReset" in dataset) promptReset(dataset.setupPromptReset);
    else if ("setupHelp" in dataset) help(target);
    else if ("setupReset" in dataset) save(dataset.setupReset, null, true);
    else load();
  });
  // Focusing a setting's field selects its row, so its full meaning shows beside the field being edited.
  document.addEventListener("focusin", (event) => {
    const row = event.target.closest?.(".setup-page .setup-list [data-setup-row]");
    if (row && event.target.matches("input") && row.dataset.setupRow !== ui.item) select(row.dataset.setupRow);
  });
  document.addEventListener("change", (event) => {
    const input = event.target.closest?.(".setup-page [data-setting], dialog.setup-viewer [data-setting]");
    if (!input) return;
    save(input.dataset.setting, input.type === "checkbox" ? input.checked : input.value);
  });
  document.addEventListener("input", (event) => {
    if (!event.target.matches?.(".setup-page [data-setup-filter]")) return;
    ui.query = event.target.value;
    // A filter that empties this tab moves to the first tab that still has matches.
    if (ui.query && !visible().length) { const tab = Object.keys(TABS).find((id) => ITEMS[id]().some(matches)); if (tab) { ui.tab = tab; ui.item = ""; } }
    if (!visible().some((item) => item.id === ui.item)) ui.item = visible()[0]?.id || "";
    syncUrl();
    drawList();
  });
  document.addEventListener("keydown", (event) => {
    if (!onPage() || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (event.target.matches?.(".setup-page input.setup-input") && key === "Enter") { event.target.blur(); return; }
    const filter = event.target.closest?.("[data-setup-filter]");
    if (filter) {
      if (key === "Escape") { event.stopPropagation(); if (filter.value) { filter.value = ""; filter.dispatchEvent(new Event("input", { bubbles: true })); } else filter.blur(); }
      else if (key === "Enter" || key === "ArrowDown") { event.preventDefault(); filter.blur(); }
      return;
    }
    if (document.querySelector("dialog[open]") || event.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (key === "f" || key === "/") { event.preventDefault(); host.querySelector("[data-setup-filter]")?.select(); return; }
    const step = { j: 1, k: -1, ArrowDown: 1, ArrowUp: -1 }[key];
    if (!step) return;
    const ids = visible().map((item) => item.id);
    if (!ids.length) return;
    event.preventDefault();
    const at = ids.indexOf(ui.item);
    select(ids[at < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, at + step))], { reveal: true });
  });
}
