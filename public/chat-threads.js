import { escapeHtml } from "./markdown.js";
import { ago, icon, showTip, hideTip } from "./code.js";
import { setOverlayParams } from "./overlay.js";

const views = { active: "Active", completed: "Completed" };
const providers = { all: "All", codex: "Codex", claude: "Claude" };
const status = { active: "Running", waiting: "Waiting", interrupted: "Interrupted", completed: "Completed" };

function segment(options, attribute, selected, label) {
  return `<div class="code-segment" role="group" aria-label="${label}">${Object.entries(options).map(([key, name]) =>
    `<button type="button" ${attribute}="${key}" aria-pressed="${selected === key}">${name}<span class="chat-segment-count"></span></button>`).join("")}</div>`;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const workspace = thread => thread.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "";

function threadRow(thread, query, peak) {
  function mark(value) {
    const text = value || "";
    const at = text.toLowerCase().indexOf(query);
    if (!query || at < 0) return escapeHtml(text);
    const end = at + query.length;
    return escapeHtml(text.slice(0, at)) + "<mark>" + escapeHtml(text.slice(at, end)) + "</mark>" + escapeHtml(text.slice(end));
  }
  const title = mark(thread.title);
  const name = thread.url
    ? `<a class="chat-thread-link" href="${escapeHtml(thread.url)}" aria-label="Open ${escapeHtml(thread.title)} in ${thread.provider}">${title}${icon("external")}</a>`
    : title;
  const time = thread.updatedAt ? new Date(thread.updatedAt) : null;
  const known = Number.isSafeInteger(thread.tokens) && thread.tokens >= 0;
  const age = ago(thread.updatedAt);
  const exact = known ? `${thread.tokens.toLocaleString()} reported tokens` : "";
  return `<tr class="chat-thread" data-thread="${escapeHtml(String(thread.id))}">
    <td class="chat-thread-title">${name}${thread.url ? "" : "<small>Available in Claude Desktop after the CLI exits</small>"}</td>
    <td class="chat-workspace"><span data-tip="${escapeHtml(thread.cwd)}">${mark(workspace(thread))}</span>${thread.branch ? `<small class="chat-branch" tabindex="0" data-tip="${escapeHtml(thread.cwd + "\n" + thread.branch)}">${icon("branch")} ${mark(thread.branch)}</small>` : ""}</td>
    <td class="chat-agent"><span data-tip="${escapeHtml(thread.provider + " · " + thread.source)}">${icon(thread.source === "CLI" ? "terminal" : "local")}${mark(thread.provider)}</span><small class="chat-source">${mark(thread.source)}</small></td>
    <td class="chat-model">${mark(thread.model) || '<span class="chat-missing">—</span>'}${thread.role ? `<small>${mark(thread.role)}</small>` : ""}</td>
    <td class="chat-usage">${known ? `<span aria-label="${exact}" data-tip="${exact}"><span class="chat-compact-number">${compact.format(thread.tokens)}</span><span class="chat-touch-number">${thread.tokens.toLocaleString()}</span></span><i aria-hidden="true" style="--usage:${peak ? 100 * thread.tokens / peak : 0}%"></i>` : '<small>Unreported</small>'}</td>
    <td class="chat-activity"><span data-chat-state="${thread.state}">${mark(status[thread.state])}</span></td>
    <td class="chat-age">${time ? `<time datetime="${time.toISOString()}" data-tip="${escapeHtml(time.toLocaleString())}">${age === "0m" ? "Now" : age}</time>` : "—"}</td>
  </tr>`;
}

export function renderChatThreads(root) {
  const params = new URLSearchParams(location.search);
  let view = params.get("threads") === "completed" ? "completed" : "active";
  let provider = ["codex", "claude"].includes(params.get("app")) ? params.get("app") : "all";
  let inventory;
  let lastRows = "";
  const page = document.createElement("section");
  page.className = "chat-threads";
  page.dataset.chatThreadsState = "loading";
  page.innerHTML = `<div class="chat-threads-toolbar">
    ${segment(views, "data-chat-view", view, "Thread status")}
    ${segment(providers, "data-chat-provider", provider, "App")}
    <label class="code-filter">${icon("search")}<input type="search" aria-label="Find a thread" placeholder="Find a thread…"></label>
    <select aria-label="Sort threads"><option value="recent">Recent activity</option><option value="tokens">Most tokens</option><option value="workspace">By workspace</option></select>
    <span class="chat-count"></span>
  </div><div class="chat-feedback"><span class="chat-threads-status" role="status"></span> <button type="button" class="chat-reset" hidden></button></div><table hidden class="chat-thread-table" aria-label="Chat threads"><thead><tr><th>Thread</th><th class="chat-workspace-head">Workspace</th><th>Agent</th><th>Model</th><th>Tokens</th><th>Status</th><th>Updated</th></tr></thead><tbody class="chat-thread-list"></tbody></table>`;
  root.replaceChildren(page);
  const notice = page.querySelector(".chat-threads-status");
  const table = page.querySelector("table");
  const reset = page.querySelector(".chat-reset");
  const list = page.querySelector(".chat-thread-list");
  notice.textContent = "Loading threads…";

  const search = page.querySelector("input");
  const sort = page.querySelector("select");
  search.value = params.get("find") || "";
  sort.value = ["tokens", "workspace"].includes(params.get("order")) ? params.get("order") : "recent";
  function changeFilters() {
    setOverlayParams({ find: search.value, order: sort.value === "recent" ? "" : sort.value });
    render();
  }
  search.addEventListener("input", changeFilters);
  sort.addEventListener("change", changeFilters);

  function render() {
    if (!inventory) return;
    const query = search.value.trim().toLowerCase();
    for (const button of page.querySelectorAll("[data-chat-view], [data-chat-provider]")) {
      const { chatView, chatProvider } = button.dataset;
      const pool = inventory[chatView || view];
      const app = chatProvider || provider;
      const count = app === "all" ? pool.length : pool.filter(thread => thread.provider.toLowerCase() === app).length;
      button.querySelector(".chat-segment-count").textContent = count;
    }
    const rows = inventory[view].filter(thread => {
      if (provider !== "all" && provider !== thread.provider.toLowerCase()) return false;
      return [thread.title, workspace(thread), thread.branch, thread.provider, thread.source, thread.model, thread.role, status[thread.state]]
        .some(value => value?.toLowerCase().includes(query));
    });
    if (sort.value === "tokens") rows.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
    page.querySelector(".chat-count").textContent = query ? `${rows.length} ${rows.length === 1 ? "match" : "matches"}` : "";
    table.hidden = !rows.length;
    const scope = provider === "all" ? "" : providers[provider] + " ";
    const messages = [...inventory.issues];
    if (page.dataset.chatThreadsState === "error") messages.unshift("Refresh failed. Showing the last results. Retrying automatically.");
    if (!rows.length) {
      if (query) messages.push(`No ${scope}threads match your search.`);
      else if (!messages.length) messages.push(`No ${view} ${scope}threads.`);
    }
    const message = messages.join(" ");
    if (notice.textContent !== message) notice.textContent = message;
    reset.hidden = !!rows.length || (!query && provider === "all");
    reset.textContent = query ? "Clear search" : "Show all apps";
    notice.parentElement.hidden = !message;
    const peak = Math.max(0, ...rows.map(thread => thread.tokens || 0));
    const row = thread => threadRow(thread, query, peak);
    const grouped = sort.value === "workspace";
    table.classList.toggle("by-workspace", grouped);
    table.querySelector(".chat-workspace-head").textContent = grouped ? "Branch" : "Workspace";
    let html;
    if (grouped) {
      const groups = Map.groupBy(rows, thread => thread.cwd);
      html = [...groups].map(([cwd, threads]) => {
        const label = workspace(threads[0]) || "Unknown workspace";
        return `<tr class="chat-group"><th colspan="7" data-tip="${escapeHtml(cwd)}">${icon("folder")}${escapeHtml(label)} <span>${threads.length}</span></th></tr>` + threads.map(row).join("");
      }).join("");
    } else html = rows.map(row).join("");

    if (html === lastRows) return;
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusedThread = focused?.closest("tr")?.dataset.thread;
    const focusSelector = focused?.matches("a") ? "a" : ".chat-branch";
    list.innerHTML = html;
    if (focusedThread) list.querySelector(`tr[data-thread="${CSS.escape(focusedThread)}"] ${focusSelector}`)?.focus({ preventScroll: true });
    lastRows = html;
  }

  page.addEventListener("keydown", event => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    if (event.target !== search && !event.target.matches(".chat-thread-link")) return;
    const links = [...list.querySelectorAll(".chat-thread-link")];
    const index = links.indexOf(event.target);
    const next = index + (event.key === "ArrowDown" ? 1 : -1);
    const target = next === -1 && index === 0 ? search : links[next];
    if (target) { event.preventDefault(); target.focus(); }
  });
  reset.addEventListener("click", () => {
    if (search.value.trim()) {
      search.value = "";
      changeFilters();
      search.focus();
    } else {
      const all = page.querySelector('[data-chat-provider="all"]');
      all.click();
      all.focus();
    }
  });
  page.addEventListener("pointerover", event => {
    const target = event.target.closest("[data-tip]");
    if (target) showTip(target);
    else hideTip();
  });
  page.addEventListener("pointerleave", hideTip);
  page.addEventListener("focusin", event => {
    if (event.target.matches(".chat-branch")) showTip(event.target);
  });
  page.addEventListener("focusout", hideTip);

  page.addEventListener("click", event => {
    const control = event.target.closest("[data-chat-view], [data-chat-provider]");
    if (!control) return;
    if (control.dataset.chatView) view = control.dataset.chatView;
    if (control.dataset.chatProvider) provider = control.dataset.chatProvider;
    for (const button of page.querySelectorAll("[data-chat-view], [data-chat-provider]")) {
      button.setAttribute("aria-pressed", String(button.dataset.chatView === view || button.dataset.chatProvider === provider));
    }
    setOverlayParams({ threads: view === "active" ? "" : view, app: provider === "all" ? "" : provider });
    render();
  });

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
        else notice.textContent = "Could not load chat threads. Retrying automatically.";
      }
    }
    if (page.isConnected) window.setTimeout(refresh, 5000);
  }
  void refresh();
}
