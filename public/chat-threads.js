import { escapeHtml } from "./markdown.js";
import { ago, icon } from "./code.js";
import { setOverlayParams } from "./overlay.js";

const views = { active: "Active", completed: "Completed" };
const providers = { all: "All", codex: "Codex", claude: "Claude" };
const status = { active: "Running", waiting: "Waiting", interrupted: "Interrupted", completed: "Completed" };

function segment(options, attribute, selected, label) {
  return `<div class="code-segment" role="group" aria-label="${label}">${Object.entries(options).map(([key, name]) =>
    `<button type="button" ${attribute}="${key}" aria-pressed="${selected === key}">${name}</button>`).join("")}</div>`;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const workspace = thread => thread.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "";

function threadRow(thread, query) {
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
  return `<tr class="chat-thread">
    <td><div class="chat-thread-title">${name}</div><small data-tip="${escapeHtml(thread.cwd)}">${[workspace(thread), thread.branch].filter(Boolean).map(mark).join(" · ")}</small>
      ${thread.url ? "" : "<small>Available in Claude Desktop after the CLI exits</small>"}</td>
    <td class="chat-agent"><span>${mark(thread.provider)}</span> <small>${mark(thread.source)}</small><small class="chat-model">${[thread.model, thread.role].filter(Boolean).map(mark).join(" · ")}</small></td>
    <td class="chat-usage">${known ? `<span data-tip="${thread.tokens.toLocaleString()} reported tokens">${compact.format(thread.tokens)}</span>` : "<small>Unreported</small>"}<small class="chat-mobile-unit">${known ? "tokens" : "usage"}</small></td>
    <td class="chat-activity"><span data-chat-state="${thread.state}">${mark(status[thread.state])}</span>${time ? `<small><time datetime="${time.toISOString()}" data-tip="${escapeHtml(time.toLocaleString())}">${age === "0m" ? "Just now" : age + " ago"}</time></small>` : ""}</td>
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
    <input type="search" aria-label="Find a thread" placeholder="Find a thread…">
    <select aria-label="Sort threads"><option value="recent">Recent activity</option><option value="tokens">Most tokens</option></select>
  </div><p class="chat-threads-status" role="status"></p><table class="chat-thread-table" aria-label="Chat threads"><thead><tr><th>Thread <span class="chat-count"></span></th><th>Agent</th><th>Tokens</th><th>Activity</th></tr></thead><tbody class="chat-thread-list"></tbody></table>`;
  root.replaceChildren(page);
  const notice = page.querySelector(".chat-threads-status");
  const list = page.querySelector(".chat-thread-list");
  notice.textContent = "Loading threads…";

  const search = page.querySelector("input");
  const sort = page.querySelector("select");
  search.value = params.get("find") || "";
  sort.value = params.get("order") === "tokens" ? "tokens" : "recent";
  function changeFilters() {
    setOverlayParams({ find: search.value, order: sort.value === "tokens" ? "tokens" : "" });
    render();
  }
  search.addEventListener("input", changeFilters);
  sort.addEventListener("change", changeFilters);

  function render() {
    if (!inventory) return;
    const query = search.value.trim().toLowerCase();
    const rows = inventory[view].filter(thread => {
      if (provider !== "all" && provider !== thread.provider.toLowerCase()) return false;
      return [thread.title, workspace(thread), thread.branch, thread.provider, thread.source, thread.model, thread.role, status[thread.state]]
        .some(value => value?.toLowerCase().includes(query));
    });
    if (sort.value === "tokens") rows.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
    page.querySelector(".chat-count").textContent = String(rows.length);

    notice.textContent = [...inventory.issues, ...(!rows.length && !inventory.issues.length ? [query ? "No threads match your search." : `No ${view} threads.`] : [])].join(" ");
    notice.hidden = !notice.textContent;
    const html = rows.map(thread => threadRow(thread, query)).join("");
    if (html === lastRows) return;
    const focused = list.contains(document.activeElement) && document.activeElement.getAttribute("href");
    list.innerHTML = html;
    if (focused) [...list.querySelectorAll("a")].find(link => link.getAttribute("href") === focused)?.focus({ preventScroll: true });
    lastRows = html;
  }

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
        notice.textContent = inventory ? "Could not refresh. Showing the last results." : "Could not load chat threads.";
        notice.hidden = false;
        page.dataset.chatThreadsState = "error";
      }
    }
    if (page.isConnected) window.setTimeout(refresh, 5000);
  }
  void refresh();
}
