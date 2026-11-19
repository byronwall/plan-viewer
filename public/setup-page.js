// The Setup page (`?view=setup`): every integration the viewer can use and whether it works, and every setting in
// config/viewer.json. Nothing here signs in or stores a token: each helper opens the note popover with a prompt that
// has an agent do the setup (Enter saves it as an Up next note; the quiet button drafts it in the agent app now).
import { escapeHtml } from "./markdown.js";
import { agentApp, agentName } from "./config.js";
import { openNotePopover } from "./note-popover.js";

let data = null;
let host = null;
let notify = () => {};
let installed = false;

const STATE_LABEL = { ok: "Working", missing: "Not working", unused: "Not set up" };

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
  if (!data) host.innerHTML = `<section class="setup"><p class="library-intro">Checking integrations…</p></section>`;
  else draw();
  await load();
}

async function load() {
  try { data = await fetch("/api/setup").then((response) => response.json()); }
  catch (error) { notify(error.message, true); return; }
  if (host?.isConnected && host.classList.contains("setup-page")) draw();
}

const json = (value) => JSON.stringify(value);
// The docs table is Markdown: `code` and [links](url) render; everything else stays text.
const inline = (text) => escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
const helpButton = (kind, id, label) => `<button type="button" class="setup-help" data-setup-help="${kind}" data-id="${escapeHtml(id)}">${escapeHtml(label)}</button>`;

function integrationRow(row) {
  return `<div class="setup-int" data-state="${row.state}">
    <span class="setup-dot" title="${STATE_LABEL[row.state]}" aria-label="${STATE_LABEL[row.state]}"></span>
    <b>${escapeHtml(row.label)}</b>
    <span class="setup-int-detail">${escapeHtml(row.detail)}</span>
    <span class="setup-int-enables">${escapeHtml(row.enables)}</span>
    ${helpButton("integration", row.id, row.state === "ok" ? "Help…" : "Set up…")}
  </div>`;
}

function valueCell(row) {
  const name = `setting-${row.key}`;
  if (row.kind === "boolean") return `<label class="setup-check"><input type="checkbox" name="${escapeHtml(name)}" data-setting="${escapeHtml(row.key)}"${row.value ? " checked" : ""}><span>${row.value ? "true" : "false"}</span></label>`;
  if (row.kind === "string" || row.kind === "number") {
    return `<input class="setup-input" name="${escapeHtml(name)}" data-setting="${escapeHtml(row.key)}" type="${row.kind === "number" ? "number" : "text"}" value="${escapeHtml(String(row.value ?? ""))}" placeholder="${escapeHtml(row.fallback === "" ? "empty" : String(row.fallback))}" spellcheck="false" autocomplete="off">`;
  }
  return `<code class="setup-json">${escapeHtml(json(row.value))}</code>`;
}

function settingRow(row) {
  const scalar = ["string", "number", "boolean"].includes(row.kind);
  return `<tr data-key="${escapeHtml(row.key)}" data-search="${escapeHtml(`${row.key} ${row.meaning}`.toLowerCase())}">
    <th scope="row"><code>${escapeHtml(row.key)}</code>${row.restart ? '<span class="setup-note" title="Read once, at startup">restart</span>' : ""}</th>
    <td class="setup-value">${valueCell(row)}</td>
    <td class="setup-source">${row.set ? `Set <button type="button" class="setup-reset" data-setup-reset="${escapeHtml(row.key)}" title="Remove it from the file so the default applies">Reset</button>` : '<span class="setup-default">Default</span>'}</td>
    <td class="setup-meaning">${inline(row.meaning)}</td>
    <td class="setup-act">${scalar ? "" : helpButton("setting", row.key, "Configure…")}</td>
  </tr>`;
}

function fileRow(row) {
  const action = row.secret ? '<span class="setup-default">Hidden</span>'
    : `${row.exists ? `<button type="button" class="setup-help" data-setup-view="${escapeHtml(row.path)}">View</button>` : ""}${helpButton("file", row.path, row.exists ? "Edit…" : "Create…")}`;
  return `<div class="setup-file" data-state="${row.exists ? "ok" : "unused"}">
    <span class="setup-dot" aria-label="${row.exists ? "Present" : "Not created"}"></span>
    <code>${escapeHtml(row.path)}</code>
    <span class="setup-int-detail"><span>${inline(row.purpose)}${row.key ? ` <span class="setup-default">· <code>${escapeHtml(row.key)}</code></span>` : ""}</span></span>
    <span class="setup-default">${row.exists ? `${ago(row.modified)} · ${size(row.size)}` : "Not created"}</span>
    <span class="setup-acts">${action}</span>
  </div>`;
}

const size = (bytes) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
const ago = (iso) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return minutes < 60 ? `${Math.max(minutes, 0)}m ago` : minutes < 1440 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
};

// A config file, read-only, in a dialog over the page. The backdrop or Esc closes it.
async function viewFile(path) {
  let dialog = document.querySelector("dialog.setup-viewer");
  if (!dialog) {
    dialog = Object.assign(document.createElement("dialog"), { className: "setup-viewer" });
    dialog.addEventListener("click", (event) => { if (event.target === dialog || event.target.closest("[data-setup-close]")) dialog.close(); });
    document.body.append(dialog);
  }
  try {
    const response = await fetch(`/api/setup/file?${new URLSearchParams({ path })}`);
    const file = await response.json();
    if (!response.ok) throw new Error(file.error || "Couldn't read the file.");
    dialog.innerHTML = `<header><code>${escapeHtml(path)}</code><button type="button" class="setup-help" data-setup-close>Close</button></header><pre>${escapeHtml(file.text)}</pre>`;
    dialog.showModal();
  } catch (error) { notify(error.message, true); }
}

function draw() {
  const query = host.querySelector(".setup-filter")?.value || "";
  const counts = { ok: 0, missing: 0, unused: 0 };
  for (const row of data.integrations) counts[row.state]++;
  const groups = new Map();
  for (const row of data.settings) {
    const group = row.key.includes(".") ? row.key.split(".")[0] : "general";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  host.innerHTML = `<section class="setup">
    <section class="setup-section" aria-labelledby="setup-integrations">
      <header><h2 id="setup-integrations">Integrations</h2>
        <span class="setup-sum">${counts.ok} working · ${counts.missing} not working · ${counts.unused} not set up</span>
        <button type="button" class="setup-recheck" data-setup-recheck>Recheck</button></header>
      <p class="library-intro">Tools and tokens the viewer reads. A helper drafts the setup for an agent; sign-ins and tokens stay with you.</p>
      <div class="setup-ints">${data.integrations.map(integrationRow).join("")}</div>
    </section>
    <section class="setup-section" aria-labelledby="setup-files">
      <header><h2 id="setup-files">Config files</h2>
        <span class="setup-sum">${data.files.filter((row) => row.exists).length} of ${data.files.length} present</span></header>
      <p class="library-intro">Files in <code>config/</code> and the others the tooling reads. They are not in the library, so this is where to read them.</p>
      <div class="setup-files">${data.files.map(fileRow).join("")}</div>
    </section>
    <section class="setup-section" aria-labelledby="setup-settings">
      <header><h2 id="setup-settings">Settings</h2>
        <span class="setup-sum"><code>${escapeHtml(data.file)}</code> · ${data.settings.filter((row) => row.set).length} of ${data.settings.length} set</span>
        <input class="setup-filter" type="search" placeholder="Filter settings" aria-label="Filter settings" value="${escapeHtml(query)}" spellcheck="false"></header>
      <p class="library-intro">Text, number and on/off settings save as you change them. Lists and commands go through Configure…, which drafts the change for an agent.</p>
      <table class="setup-table"><colgroup><col class="setup-col-key"><col class="setup-col-value"><col class="setup-col-source"><col><col class="setup-col-act"></colgroup>
        ${[...groups].map(([group, rows]) => `<tbody><tr class="setup-group"><th colspan="5" scope="rowgroup">${escapeHtml(group)}</th></tr>${rows.map(settingRow).join("")}</tbody>`).join("")}
      </table>
    </section>
  </section>`;
  if (query) filter(query);
}

function filter(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const body of host.querySelectorAll(".setup-table tbody")) {
    let shown = 0;
    for (const row of body.querySelectorAll("tr[data-key]")) {
      const hit = words.every((word) => row.dataset.search.includes(word));
      row.hidden = !hit;
      shown += hit;
    }
    body.hidden = !shown;
  }
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
  const label = kind !== "integration" ? id : data.integrations.find((row) => row.id === id)?.label || id;
  openNotePopover(button, {
    heading: kind === "setting" ? `Configure ${label}` : kind === "file" ? `${button.textContent.replace("…", "")} ${label}` : `Set up ${label}`, notify,
    prompt: async (note) => (await setupAgent({ kind, id, note, copy: true })).prompt,
    send: { label: `Open in ${agentName()}`, run: async (note) => { await setupAgent({ kind, id, note, app: agentApp() }); notify(`Drafted the ${label} setup in ${agentName()}. Review it and press Enter to send.`); } },
  });
}

// One set of listeners on document, scoped to the page by its class, so redraws never stack handlers.
function install() {
  if (installed) return;
  installed = true;
  const onPage = (event) => event.target.closest?.(".setup-page .setup");
  document.addEventListener("click", (event) => {
    if (!onPage(event)) return;
    const target = event.target.closest("[data-setup-help], [data-setup-reset], [data-setup-recheck], [data-setup-view]");
    if (!target) return;
    if ("setupView" in target.dataset) viewFile(target.dataset.setupView);
    else if ("setupHelp" in target.dataset) help(target);
    else if ("setupReset" in target.dataset) save(target.dataset.setupReset, null, true);
    else { target.disabled = true; target.textContent = "Checking…"; load(); }
  });
  document.addEventListener("change", (event) => {
    const input = event.target.closest?.(".setup-page [data-setting]");
    if (!input) return;
    save(input.dataset.setting, input.type === "checkbox" ? input.checked : input.value);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches?.(".setup-page input.setup-input")) event.target.blur();
  });
  document.addEventListener("input", (event) => {
    if (event.target.matches?.(".setup-page .setup-filter")) filter(event.target.value);
  });
}
