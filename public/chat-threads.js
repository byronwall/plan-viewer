import { escapeHtml } from "./markdown.js";
import { ago, icon } from "./code.js";
import { setOverlayParams } from "./overlay.js";

const views = { active: "Active", completed: "Completed" };
const providers = { all: "All", codex: "Codex", claude: "Claude" };
const status = { active: "Running", waiting: "Waiting", interrupted: "Interrupted" };

function segment(options, attribute, selected, label) {
  return `<div class="code-segment" role="group" aria-label="${label}">${Object.entries(options).map(([key, name]) =>
    `<button type="button" ${attribute}="${key}" aria-pressed="${selected === key}">${name}</button>`).join("")}</div>`;
}

function threadRow(thread) {
  const title = escapeHtml(thread.title);
  const workspace = thread.cwd.split(/[\\/]/).filter(Boolean).at(-1);
  const app = thread.provider === "Codex" ? "Codex" : "Claude Desktop";
  const label = `${thread.provider} · ${thread.source}`;
  const name = thread.url
    ? `<a class="chat-thread-link" href="${escapeHtml(thread.url)}" aria-label="Open ${title} in ${app}">${title}${icon("external")}</a>`
    : `<span>${title}</span>`;
  const time = thread.updatedAt ? new Date(thread.updatedAt) : null;
  return `<li class="chat-thread">
    <div class="chat-thread-detail"><div class="chat-thread-title">${name}</div><div class="chat-thread-meta">${escapeHtml(label)}${workspace ? ` · ${escapeHtml(workspace)}` : ""}</div></div>
    <div class="chat-thread-activity">${status[thread.state] ? `<span data-chat-state="${thread.state}">${status[thread.state]}</span>` : ""}${time ? `<time datetime="${time.toISOString()}" title="${escapeHtml(time.toLocaleString())}">${ago(thread.updatedAt)} ago</time>` : ""}</div>
    ${thread.url ? "" : '<span class="chat-thread-availability">Available in Claude Desktop after the CLI exits</span>'}
  </li>`;
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
  </div><p class="chat-threads-status" role="status"></p><ul class="chat-thread-list" aria-label="Chat threads"></ul>`;
  root.replaceChildren(page);
  const notice = page.querySelector(".chat-threads-status");
  const list = page.querySelector(".chat-thread-list");
  notice.textContent = "Loading threads…";

  function render() {
    if (!inventory) return;
    const rows = inventory[view].filter(thread => provider === "all" || provider === thread.provider.toLowerCase());
    notice.textContent = [...inventory.issues, ...(!rows.length && !inventory.issues.length ? [`No ${view} threads.`] : [])].join(" ");
    notice.hidden = !notice.textContent;
    const html = rows.map(threadRow).join("");
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
