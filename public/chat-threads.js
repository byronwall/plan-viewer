import { escapeHtml } from "./markdown.js";
import { ago, icon, showTip, hideTip } from "./code.js";
import { GLYPHS, brandMark } from "./icons.js";
import { setOverlayParams } from "./overlay.js";

// Every Codex and Claude Code thread on this Mac in one table: live threads on top, history by day below. A thread an
// agent spawned (a Codex subagent, a Claude side session) sits under its parent, so workers never read as peers.

const apps = { all: "All", codex: "Codex", claude: "Claude" };
const STATES = {
  waiting: { label: "Waiting for you", glyph: "circle-dot" },
  active: { label: "Running", glyph: "" },
  interrupted: { label: "Interrupted", glyph: "circle-alert" },
  completed: { label: "Completed", glyph: "circle-check" },
};
const live = (thread) => thread.state === "active" || thread.state === "waiting";
const glyph = (name, className = "code-icon") => `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${GLYPHS[name]}</svg>`;

// App marks: the real Claude spark (Simple Icons) and Codex blossom (lobe-icons), from icons.js.
const CLAUDE_MARK = brandMark("claude", "chat-app-mark is-claude");
const CODEX_MARK = brandMark("codex", "chat-app-mark is-codex");
const appMark = (provider) => (provider === "Claude" ? CLAUDE_MARK : CODEX_MARK);

// Model IDs as people say them, with a hue per family so Opus, Fable, Sol and Luna read apart at a glance.
const FAMILY_HUES = { opus: 280, sonnet: 212, haiku: 150, fable: 18, sol: 38, luna: 238, terra: 128, astra: 186, codex: 200, mini: 330 };
const title = (word) => word.charAt(0).toUpperCase() + word.slice(1);
export function modelInfo(id) {
  if (!id) return null;
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\b|-)/i.exec(id);
  if (claude) return { name: `${title(claude[1])} ${claude[2]}${claude[3] ? "." + claude[3] : ""}`, family: claude[1].toLowerCase() };
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/i.exec(id);
  if (gpt) {
    const words = (gpt[2] || "").split("-").filter(Boolean);
    return { name: [`GPT-${gpt[1]}`, ...words.map(title)].join(" "), family: (words[0] || "gpt").toLowerCase() };
  }
  if (id === "codex-auto-review") return { name: "Auto review", family: "codex" };
  return { name: id, family: id.toLowerCase() };
}
const hueOf = (text) => [...text].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 7);
const EFFORT = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 5 };

function modelCell(thread) {
  const model = modelInfo(thread.model);
  if (!model) return '<span class="chat-none">—</span>';
  const hue = FAMILY_HUES[model.family] ?? hueOf(model.family);
  const level = EFFORT[thread.effort];
  const effort = thread.effort
    ? `<span class="chat-effort" data-level="${level ?? 0}" data-tip="Reasoning effort: ${escapeHtml(thread.effort)}${level === undefined ? "" : ` (${level} of 5)`}" aria-label="Reasoning effort: ${escapeHtml(thread.effort)}">${"<i></i>".repeat(5)}</span>`
    : "";
  return `<div class="chat-model-line"><span class="chat-model" style="--hue:${hue}" data-tip="${escapeHtml(thread.model)}"><i aria-hidden="true"></i>${escapeHtml(model.name)}</span>${effort}</div>`;
}

const folder = (thread) => thread.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "";
// The Code view's two-letter repo mark, keyed by folder name so a workspace keeps its color across refreshes.
function folderMark(name) {
  const words = name.split(/[-_.\s]+/).filter(Boolean);
  const label = (words.length > 1 ? words[0][0] + words[1][0] : name.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?").toUpperCase();
  return `<i class="code-repo-mark" style="--hue:${hueOf(name)}" aria-hidden="true">${escapeHtml(label)}</i>`;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const DAY = 86_400_000;
function dayLabel(time) {
  const start = new Date().setHours(0, 0, 0, 0);
  if (time >= start) return "Today";
  if (time >= start - DAY) return "Yesterday";
  if (time >= start - 6 * DAY) return new Date(time).toLocaleDateString("en", { weekday: "long" });
  return "Earlier";
}

export function renderChatThreads(root) {
  const params = new URLSearchParams(location.search);
  let app = params.get("app") in apps ? params.get("app") : "all";
  let group = params.get("group") === "workspace" || params.get("order") === "workspace" ? "workspace" : "status";
  let order = params.get("order") === "tokens" ? "tokens" : "recent";
  let inventory;
  let lastHtml = "";
  // Rows the user opened or closed. Without a choice, a family is open while any of it is live.
  const opened = new Map();

  const segment = (name, options, selected, label, marks = {}) => `<div class="code-segment" role="group" aria-label="${label}">${Object.entries(options).map(([key, text]) =>
    `<button type="button" data-chat-${name}="${key}" aria-pressed="${selected === key}">${marks[key] || ""}${text}${name === "app" ? '<span class="code-count" data-count>–</span>' : ""}</button>`).join("")}</div>`;
  root.classList.add("code-page");
  const page = document.createElement("section");
  page.className = "chat-threads code-surface";
  page.dataset.chatThreadsState = "loading";
  page.innerHTML = `<div data-region="toolbar"><div class="code-toolbar"><div class="code-toolbar-row">
      ${segment("app", apps, app, "App", { codex: CODEX_MARK, claude: CLAUDE_MARK })}
      <label class="code-filter">${icon("search")}<input type="search" aria-label="Find a thread by title, agent, folder, branch or model" placeholder="Find a thread…"></label>
      <span class="chat-bar-group"><span class="chat-bar-label">Group</span>${segment("group", { status: "Status", workspace: "Workspace" }, group, "Group")}</span>
      <span class="chat-bar-group"><span class="chat-bar-label">Sort</span>${segment("order", { recent: "Recent", tokens: "Tokens" }, order, "Sort")}</span>
      <span class="chat-issues" role="status"></span>
      <span class="chat-summary"></span>
    </div></div></div>
    <div class="code-list chat-list"><table class="code-table chat-table" aria-label="Chat threads"><colgroup><col class="chat-col-state"><col><col class="chat-col-workspace"><col class="chat-col-model"><col class="chat-col-tokens"><col class="chat-col-age"></colgroup>
      <thead><tr><th><span class="sr-only">Status</span></th><th>Thread</th><th>Workspace</th><th>Model</th><th class="chat-num">Tokens</th><th class="chat-num">Updated</th></tr></thead>
      <tbody class="chat-thread-list"></tbody></table>
      <p class="code-empty chat-empty"><span class="chat-notice"><i class="chat-spinner"></i>Reading local Codex and Claude sessions…</span><button type="button" class="chat-reset" hidden></button></p></div>`;
  root.replaceChildren(page);
  new ResizeObserver(([entry]) => page.style.setProperty("--code-bar-h", `${Math.ceil(entry.borderBoxSize[0].blockSize)}px`)).observe(page.querySelector('[data-region="toolbar"]'));

  const search = page.querySelector("input");
  const list = page.querySelector(".chat-thread-list");
  const table = page.querySelector("table");
  const empty = page.querySelector(".chat-empty");
  const notice = page.querySelector(".chat-notice");
  const reset = page.querySelector(".chat-reset");
  const summary = page.querySelector(".chat-summary");
  const issues = page.querySelector(".chat-issues");
  search.value = params.get("find") || "";

  function saveParams() {
    setOverlayParams({ find: search.value, app: app === "all" ? "" : app, group: group === "status" ? "" : group, order: order === "recent" ? "" : order, threads: "" });
  }

  // How a thread started rides on its app mark as a corner badge, so titles stay clean and the cue sits in one place.
  function appCell(thread) {
    const app = thread.provider === "Claude" ? "Claude Code" : "Codex";
    const [badge, how] = thread.kind === "automation" ? ["calendar-clock", "started by a Codex automation"]
      : thread.kind === "agent" && !thread.parent ? ["network", "started by another agent"]
      : thread.source === "CLI" ? ["terminal", `started from the ${thread.provider === "Claude" ? "claude" : "codex"} command line`]
      : ["", thread.source === "Desktop" ? "desktop app" : thread.source.toLowerCase()];
    return `<span class="chat-app" data-tip="${app} · ${how}" aria-label="${app}, ${how}">${appMark(thread.provider)}${badge ? `<i class="chat-app-badge">${glyph(badge)}</i>` : ""}</span>`;
  }

  function threadCell(thread, query, kids, depth, open) {
    const mark = (value) => {
      const text = value || "";
      const at = query ? text.toLowerCase().indexOf(query) : -1;
      if (at < 0) return escapeHtml(text);
      return `${escapeHtml(text.slice(0, at))}<mark>${escapeHtml(text.slice(at, at + query.length))}</mark>${escapeHtml(text.slice(at + query.length))}`;
    };
    const spawned = thread.kind === "subagent";
    const lead = spawned
      ? `${glyph("bot", "code-icon chat-kind")}${thread.nickname ? `<b>${mark(thread.nickname)}</b>` : ""}`
      : appCell(thread);
    // Long prompts used as titles often start with an absolute path; home reads as ~.
    const label = (spawned && thread.role && thread.title.toLowerCase() === thread.role.replaceAll("_", " ").toLowerCase() ? thread.role.replaceAll("_", " ") : thread.title).replace(/\/Users\/[^/\s]+/g, "~");
    const text = `<span class="chat-title-text">${mark(label)}</span>`;
    const name = thread.url
      ? `<a class="chat-thread-link" href="${escapeHtml(thread.url)}" aria-label="Open ${escapeHtml(thread.title)} in ${thread.provider}">${text}</a>`
      : `<span class="chat-thread-link is-closed" tabindex="0" data-tip="Opens in Claude Desktop after the terminal session exits">${text}</span>`;
    let toggle = "";
    if (kids.length) {
      const running = kids.filter(live).length;
      const noun = kids.every((kid) => kid.kind === "subagent") ? "subagent" : kids.every((kid) => kid.kind !== "subagent") ? "session" : "agent";
      toggle = `<button type="button" class="chat-kids" data-chat-toggle="${escapeHtml(thread.id)}" aria-expanded="${open}">${glyph("chevron-right", "code-icon chat-caret")}${kids.length} ${noun}${kids.length === 1 ? "" : "s"}${running ? ` <em>${running} live</em>` : ""}</button>`;
    }
    return `<td class="chat-thread-cell" style="--depth:${depth}"><div class="chat-title">${lead}${name}${toggle}</div></td>`;
  }

  // A finished thread whose spawned threads still run shows a faint spinner, so the Running section never shows only checks.
  function stateCell(thread, kids) {
    const running = live(thread) ? 0 : kids.filter(live).length;
    const state = STATES[thread.state];
    const tip = running ? `${state.label} its turn · ${running} spawned ${running === 1 ? "thread is" : "threads are"} still running`
      : thread.state === "active" ? "Running · a turn is in progress" : state.label;
    const mark = running ? '<i class="chat-spinner is-family"></i>' : state.glyph ? glyph(state.glyph) : '<i class="chat-spinner"></i>';
    return `<td class="chat-state"><span data-tip="${tip}" aria-label="${tip}">${mark}</span></td>`;
  }

  function row(thread, query, kids, depth, parent, open, last) {
    const time = thread.updatedAt ? new Date(thread.updatedAt) : null;
    const age = ago(thread.updatedAt);
    const known = Number.isSafeInteger(thread.tokens) && thread.tokens >= 0;
    const usage = thread.usage;
    const exact = !known ? "" : usage
      ? `${thread.tokens.toLocaleString()} tokens: ${usage.input.toLocaleString()} input (${Math.round(100 * usage.cached / (usage.input || 1))}% from cache) and ${usage.output.toLocaleString()} output`
      : `${thread.tokens.toLocaleString()} tokens reported by Codex`;
    // Under its parent, or in a workspace group, the folder is already said once above the row.
    const sameFolder = (parent && parent.cwd === thread.cwd) || group === "workspace";
    const branch = thread.branch && !(parent && parent.cwd === thread.cwd && parent.branch === thread.branch) ? `<small class="chat-branch" data-tip="${escapeHtml(thread.branch)}">${icon("branch")}${escapeHtml(thread.branch)}</small>` : "";
    return `<tr class="code-row chat-thread${depth ? " is-child" : ""}${last ? " is-last" : ""}" data-thread="${escapeHtml(String(thread.id))}" data-state="${thread.state}">
      ${stateCell(thread, kids)}
      ${threadCell(thread, query, kids, depth, open)}
      <td class="chat-workspace${sameFolder ? " is-bare" : ""}">${sameFolder ? "" : `<span class="chat-folder" data-tip="${escapeHtml(thread.cwd)}">${folderMark(folder(thread))}<span>${escapeHtml(folder(thread))}</span></span>`}${branch}</td>
      <td class="chat-model-cell">${modelCell(thread)}</td>
      <td class="chat-num chat-usage">${known ? `<span data-tip="${exact}">${compact.format(thread.tokens)}</span>` : '<span class="chat-none is-unknown" data-tip="No usage recorded for this thread">—</span>'}</td>
      <td class="chat-num chat-age">${time ? `<time datetime="${time.toISOString()}" data-tip="${escapeHtml(time.toLocaleString())}">${age === "0m" ? "now" : age}</time>` : "—"}</td>
    </tr>`;
  }

  function isOpen(thread, kids) {
    if (opened.has(thread.id)) return opened.get(thread.id);
    return live(thread) || kids.some(live);
  }

  function render() {
    if (!inventory) return;
    const query = search.value.trim().toLowerCase();
    const everything = [...inventory.active, ...inventory.completed];
    const ids = new Set(everything.map((thread) => thread.id));
    const isRoot = (thread) => !thread.parent || !ids.has(thread.parent);
    for (const button of page.querySelectorAll("[data-chat-app]")) {
      const key = button.dataset.chatApp;
      button.querySelector("[data-count]").textContent = everything.filter((thread) => isRoot(thread) && (key === "all" || thread.provider.toLowerCase() === key)).length;
    }
    const pool = everything.filter((thread) => app === "all" || thread.provider.toLowerCase() === app);
    const children = Map.groupBy(pool.filter((thread) => !isRoot(thread)), (thread) => thread.parent);
    for (const kids of children.values()) kids.sort((a, b) => (a.startedAt || a.updatedAt) - (b.startedAt || b.updatedAt) || a.id.localeCompare(b.id));
    const family = (thread) => [thread, ...(children.get(thread.id) || []).flatMap(family)];
    const matches = (thread) => !query || [thread.title, thread.nickname, thread.role, folder(thread), thread.branch, thread.provider, thread.source, thread.model, modelInfo(thread.model)?.name, thread.effort, STATES[thread.state].label]
      .some((value) => value?.toLowerCase().includes(query));
    const roots = pool.filter(isRoot).filter((thread) => family(thread).some(matches));
    const liveCount = (state) => pool.filter((thread) => thread.state === state).length;

    // Live threads keep their start order, so a busy thread never jumps past its neighbours on refresh.
    const started = (thread) => thread.startedAt || thread.updatedAt;
    const tokens = (thread) => family(thread).reduce((sum, member) => sum + (member.tokens || 0), 0);
    const byOrder = (a, b) => order === "tokens" ? tokens(b) - tokens(a) : 0;
    const section = (thread) => thread.state === "waiting" ? "waiting" : live(thread) || (children.get(thread.id) || []).some(live) ? "active" : "done";

    const groups = new Map();
    const add = (key, label, thread) => { if (!groups.has(key)) groups.set(key, { label, threads: [] }); groups.get(key).threads.push(thread); };
    if (group === "workspace") {
      const recent = new Map();
      for (const thread of roots) recent.set(thread.cwd, Math.max(recent.get(thread.cwd) || 0, thread.updatedAt));
      for (const thread of [...roots].sort((a, b) => recent.get(b.cwd) - recent.get(a.cwd) || a.cwd.localeCompare(b.cwd))) add(thread.cwd, folder(thread) || "Unknown folder", thread);
      for (const { threads } of groups.values()) threads.sort((a, b) => byOrder(a, b) || (section(a) === "done") - (section(b) === "done") || b.updatedAt - a.updatedAt);
    } else {
      for (const key of ["waiting", "active"]) for (const thread of roots.filter((candidate) => section(candidate) === key).sort((a, b) => byOrder(a, b) || started(b) - started(a))) add(key, STATES[key].label, thread);
      const done = roots.filter((thread) => section(thread) === "done").sort((a, b) => b.updatedAt - a.updatedAt);
      if (order === "tokens") for (const thread of done.sort(byOrder)) add("done", "Finished", thread);
      else for (const thread of done) add(dayLabel(thread.updatedAt), dayLabel(thread.updatedAt), thread);
    }

    const rows = (thread, depth, parent, last) => {
      const kids = (children.get(thread.id) || []).filter((kid) => !query || matches(thread) || family(kid).some(matches));
      const open = query ? kids.length > 0 : isOpen(thread, kids);
      return row(thread, query, kids, depth, parent, open, last) + (open ? kids.map((kid, index) => rows(kid, depth + 1, thread, index === kids.length - 1)).join("") : "");
    };
    const html = [...groups].map(([key, { label, threads }]) => {
      const tip = group === "workspace" ? ` data-tip="${escapeHtml(threads[0].cwd)}"` : "";
      const lead = group === "workspace" ? folderMark(label) : key === "waiting" || key === "active" ? `<span class="chat-group-state" data-state="${key}"></span>` : "";
      return `<tr class="code-group-row chat-group" data-group="${escapeHtml(key)}"><th colspan="6"><span class="chat-group-label"${tip}>${lead}${escapeHtml(label)}</span> <span>${threads.length}</span></th></tr>${threads.map((thread) => rows(thread, 0)).join("")}`;
    }).join("");

    const waiting = liveCount("waiting");
    const running = liveCount("active");
    summary.innerHTML = `<span data-state="waiting"${waiting ? "" : ' class="is-zero"'} data-tip="Threads waiting for your input, subagents included">${glyph("circle-dot")}${waiting} waiting</span><span data-state="active"${running ? "" : ' class="is-zero"'} data-tip="Threads with a turn in progress, subagents included"><i class="chat-spinner"></i>${running} running</span>`;
    // Problems reading a source stay in view at the top, not under a long list.
    const problems = [...inventory.issues];
    if (page.dataset.chatThreadsState === "error") problems.unshift("Refresh failed; showing the last results.");
    const problemText = problems.join(" ");
    if (issues.textContent !== problemText) issues.innerHTML = problemText ? `${icon("conflict")}${escapeHtml(problemText)}` : "";

    const messages = [];
    if (!roots.length) messages.push(query ? `No ${app === "all" ? "" : apps[app] + " "}threads match “${search.value.trim()}”.` : `No ${app === "all" ? "" : apps[app] + " "}threads yet.`);
    notice.textContent = messages.join(" ");
    empty.hidden = !messages.length;
    reset.hidden = roots.length > 0 || (!query && app === "all");
    reset.textContent = query ? "Clear search" : "Show all apps";
    table.hidden = !roots.length;

    if (html === lastHtml) return;
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusRow = focused?.closest("tr")?.dataset.thread;
    const focusSelector = focused?.matches(".chat-kids") ? ".chat-kids" : ".chat-thread-link";
    list.innerHTML = html;
    lastHtml = html;
    if (focusRow) list.querySelector(`tr[data-thread="${CSS.escape(focusRow)}"] ${focusSelector}`)?.focus({ preventScroll: true });
  }

  search.addEventListener("input", () => { saveParams(); render(); });
  page.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-chat-toggle]");
    if (toggle) {
      opened.set(toggle.dataset.chatToggle, toggle.getAttribute("aria-expanded") !== "true");
      render();
      return;
    }
    const control = event.target.closest("[data-chat-app], [data-chat-group], [data-chat-order]");
    if (!control) return;
    const { chatApp, chatGroup, chatOrder } = control.dataset;
    if (chatApp) app = chatApp;
    if (chatGroup) group = chatGroup;
    if (chatOrder) order = chatOrder;
    for (const button of page.querySelectorAll("[data-chat-app], [data-chat-group], [data-chat-order]")) {
      const pressed = button.dataset.chatApp === app || button.dataset.chatGroup === group || button.dataset.chatOrder === order;
      button.setAttribute("aria-pressed", String(pressed));
    }
    saveParams();
    render();
  });
  reset.addEventListener("click", () => {
    if (search.value.trim()) {
      search.value = "";
      saveParams();
      render();
      search.focus();
    } else page.querySelector('[data-chat-app="all"]').click();
  });

  // Down from the search field, then Up and Down between conversations; Right and Left open and close a family.
  page.addEventListener("keydown", (event) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "Escape" && event.target === search && search.value) {
      event.preventDefault();
      search.value = "";
      saveParams();
      render();
      return;
    }
    const onLink = event.target.matches?.(".chat-thread-link");
    if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && onLink) {
      const toggle = event.target.closest("tr").querySelector(".chat-kids");
      if (toggle && (toggle.getAttribute("aria-expanded") === "true") !== (event.key === "ArrowRight")) { event.preventDefault(); toggle.click(); }
      return;
    }
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    if (event.target !== search && !onLink) return;
    const links = [...list.querySelectorAll(".chat-thread-link")];
    const index = links.indexOf(event.target);
    const next = index + (event.key === "ArrowDown" ? 1 : -1);
    const target = next === -1 && index === 0 ? search : links[next];
    if (target) { event.preventDefault(); target.focus(); target.scrollIntoView?.({ block: "nearest" }); }
  });
  page.addEventListener("pointerover", (event) => {
    const target = event.target.closest("[data-tip]");
    if (target) showTip(target);
    else hideTip();
  });
  page.addEventListener("pointerleave", hideTip);
  page.addEventListener("focusin", (event) => { if (event.target.matches("[data-tip]")) showTip(event.target); });
  page.addEventListener("focusout", hideTip);

  async function refresh() {
    if (!page.isConnected) return;
    if (!document.hidden) {
      try {
        const response = await fetch("/api/chat-threads");
        if (!response.ok) throw new Error();
        inventory = await response.json();
        page.dataset.chatThreadsState = "ready";
        render();
      } catch {
        page.dataset.chatThreadsState = "error";
        if (inventory) render();
        else notice.innerHTML = `${icon("conflict")}Could not load chat threads. Retrying every few seconds.`;
      }
    }
    if (page.isConnected) window.setTimeout(refresh, 5000);
  }
  void refresh();
}
