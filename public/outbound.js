// The approval panel for an outbound draft (a task asset with `outbound:` front matter): what it is, where it goes, and
// Approve and send / Send back / Drop on the exact text shown. Used on the draft's own page and in the Steps inspector.
import { config } from "./config.js";
import { escapeHtml, inlineMarkdown, renderMarkdown, SERVICE_ICONS } from "./markdown.js";

export const OUTBOUND_KINDS = {
  "jira-issue": ["New Jira issue", "jira"], "jira-comment": ["Jira comment", "jira"], "jira-edit": ["Jira description", "jira"],
  "jira-transition": ["Jira transition", "jira"], slack: ["Slack message", "slack"], "pr-comment": ["PR comment", "github"],
  "review-request": ["Review request", "github"], pr: ["Pull request", "github"], email: ["Email", ""],
};
const STATUS = {
  draft: ["Drafting", "open"], ready: ["Ready for you", "due"], revise: ["Being revised", "deferred"], approved: ["Sending", "active"],
  sent: ["Sent", "completed"], failed: ["Didn't send", "failed"], dropped: ["Dropped", "open"],
};

export const outboundKindLabel = (kind) => OUTBOUND_KINDS[kind]?.[0] || kind;
export const outboundIcon = (kind) => SERVICE_ICONS[OUTBOUND_KINDS[kind]?.[1]] || "";
export const isManual = (draft) => draft.fields.send === "manual";

function targetHtml(target = "", path = "") {
  if (/^https?:\/\//.test(target)) return inlineMarkdown(`[${/slack\.com/.test(target) ? "the thread" : "link"}](${target})`, path);
  return inlineMarkdown(target, path);
}

function stepHtml(step = "", path = "") {
  const [, task, item] = step.match(/^(TASK-\d{4})\s+(\S+)/) || [];
  return task ? `${inlineMarkdown(task, path)} <span class="outbound-step-id">${escapeHtml(item)}</span>` : escapeHtml(step);
}

function buttons(draft) {
  const { status } = draft.fields;
  const send = (label, action = "approve") => config().outbound.send.length
    ? `<button type="button" class="outbound-primary" data-outbound-action="${action}">${label}</button>`
    : `<button type="button" class="outbound-primary" disabled title="Set outbound.send in viewer.config.json">${label}</button>`;
  const back = `<button type="button" class="outbound-secondary" data-outbound-action="open-feedback">Send back</button>`;
  const drop = `<button type="button" class="outbound-quiet" data-outbound-action="drop">Drop</button>`;
  if (status === "ready" && isManual(draft)) return `<button type="button" class="outbound-primary" data-outbound-action="copy">Copy text</button><button type="button" class="outbound-secondary" data-outbound-action="open-mark">Mark sent</button>${back}${drop}`;
  if (status === "ready") return send("Approve and send") + back + drop;
  if (status === "failed") return send("Retry") + back + drop;
  return "";
}

function note(draft) {
  const f = draft.fields;
  if (f.status === "failed" && f.error) return `<p class="outbound-note is-error">${escapeHtml(f.error)}</p>`;
  if (f.status === "ready" && f.error) return `<p class="outbound-note is-error">${escapeHtml(f.error)}</p>`;
  if (f.status === "ready" && isManual(draft)) return `<p class="outbound-note is-friction">You send this by hand. Fix: add a Slack user token with chat:write so it can send on approval.</p>`;
  if (f.status === "draft" && f.waits) return `<p class="outbound-note">Waits on ${escapeHtml(f.waits)}</p>`;
  if (f.status === "revise") return `<p class="outbound-note">Sent back with your feedback; an agent is revising it and it comes back here.</p>`;
  if (f.status === "approved") return `<p class="outbound-note">Approved ${escapeHtml((f.approved || "").split(" ")[0].replace("T", " "))}; sending.</p>`;
  if (f.status === "sent") return `<p class="outbound-note">Sent ${escapeHtml((f.sent || "").replace("T", " ").slice(0, 16))}${/^https?:/.test(f.result || "") ? ` · <a href="${escapeHtml(f.result)}" target="_blank" rel="noreferrer">${escapeHtml(f.result.replace(/^https?:\/\//, "").slice(0, 60))}</a>` : f.result ? ` · ${escapeHtml(f.result)}` : ""}</p>`;
  return "";
}

// `showBody` adds the exact text that will go (the Steps inspector); the draft page shows it in its own sections.
export function outboundPanel(draft, { showBody = false } = {}) {
  const f = draft.fields;
  const [label, tone] = STATUS[f.status] || [f.status || "No status", "open"];
  return `<section class="outbound-panel" data-outbound-path="${escapeHtml(draft.path)}" data-outbound-sha="${escapeHtml(draft.sha)}" data-outbound-status="${escapeHtml(f.status || "")}">
    <div class="outbound-head">
      <span class="outbound-kind">${outboundIcon(f.outbound)}${escapeHtml(outboundKindLabel(f.outbound))}</span>
      <span class="outbound-target">to ${targetHtml(f.target, draft.path)}</span>
      ${f.step ? `<span class="outbound-meta">step ${stepHtml(f.step, draft.path)}</span>` : ""}
      ${f.dry_run === "true" ? `<span class="outbound-meta outbound-dry-run" title="dry_run: true in its front matter; sending only converts and checks">dry run</span>` : ""}
      <span class="outbound-meta" title="Hash of the text below and its send line; any edit needs a new approval">sha ${escapeHtml(draft.sha.slice(0, 8))}</span>
      <span class="task-status outbound-status outbound-status-${tone}">${escapeHtml(label)}</span>
    </div>
    ${buttons(draft) ? `<div class="outbound-actions">${buttons(draft)}</div>` : ""}
    ${note(draft)}
    <form class="outbound-form" data-outbound-form="feedback" hidden>
      <textarea rows="3" placeholder="What should change? An agent revises the draft and it comes back here."></textarea>
      <div class="outbound-actions"><button type="submit" class="outbound-primary">Send back</button><button type="button" class="outbound-quiet" data-outbound-action="cancel">Cancel</button></div>
    </form>
    <form class="outbound-form" data-outbound-form="mark" hidden>
      <input type="url" placeholder="Link to the message you sent (optional)">
      <div class="outbound-actions"><button type="submit" class="outbound-primary">Mark sent</button><button type="button" class="outbound-quiet" data-outbound-action="cancel">Cancel</button></div>
    </form>
    ${showBody && draft.body ? `<div class="outbound-body"><h5>Will go out</h5><div class="markdown">${renderMarkdown(draft.body, draft.path)}</div></div>` : ""}
  </section>`;
}

async function post(action, body) {
  const response = await fetch(`/api/outbound/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The viewer couldn't do that.");
  return data;
}

// One delegated listener for every panel under `root`. `notice(message, error)` reports; `refresh()` redraws.
export function bindOutbound(root, { notice, refresh, bodyOf }) {
  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-outbound-action]");
    const panel = button?.closest(".outbound-panel");
    if (!panel) return;
    const action = button.dataset.outboundAction;
    const path = panel.dataset.outboundPath;
    const show = (name) => {
      for (const form of panel.querySelectorAll("[data-outbound-form]")) form.hidden = form.dataset.outboundForm !== name;
      panel.querySelector(`[data-outbound-form="${name}"] textarea, [data-outbound-form="${name}"] input`)?.focus();
    };
    if (action === "open-feedback") return show("feedback");
    if (action === "open-mark") return show("mark");
    if (action === "cancel") return show("");
    if (action === "copy") {
      const markdown = bodyOf(path) || "";
      const html = renderMarkdown(markdown, path);
      try { await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([markdown], { type: "text/plain" }) })]); }
      catch { await navigator.clipboard.writeText(markdown); }
      button.classList.add("is-copied");
      setTimeout(() => button.classList.remove("is-copied"), 900);
      return notice("Copied the message; paste it, then Mark sent.");
    }
    button.disabled = true;
    try {
      if (action === "approve") {
        button.textContent = "Sending…";
        const result = await post("approve", { path, sha: panel.dataset.outboundSha });
        if (result.changed) notice("The draft changed since you read it; read it again before approving.", true);
        else if (result.draft.fields.status === "sent") notice(result.draft.fields.result === "dry-run" ? "Sent as a dry run; nothing left the machine." : "Sent.");
        else notice(result.draft.fields.error || "It didn't send.", true);
      } else if (action === "drop") {
        await post("drop", { path });
        notice("Dropped.");
      }
    } catch (error) {
      notice(error.message, true);
    }
    refresh();
  });
  root.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-outbound-form]");
    const panel = form?.closest(".outbound-panel");
    if (!panel) return;
    event.preventDefault();
    const path = panel.dataset.outboundPath;
    try {
      if (form.dataset.outboundForm === "feedback") {
        const result = await post("send-back", { path, feedback: form.querySelector("textarea").value });
        notice(result.started ? "Sent back; an agent is revising it." : "Sent back. No revision run started (dry run or no outbound.revise).");
      } else {
        await post("mark-sent", { path, result: form.querySelector("input").value });
        notice("Marked sent.");
      }
    } catch (error) {
      return notice(error.message, true);
    }
    refresh();
  });
}
