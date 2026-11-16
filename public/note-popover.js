import { escapeHtml } from "./markdown.js";
import { glyph } from "./icons.js";

// Every button that would start an agent chat opens this popover instead: the prompt it would have sent is saved as an
// Up next note for an orchestrator thread to pick up. Enter saves, Shift+Enter is a new line, Esc cancels. The old
// launch stays one quiet button away (⌘Enter) and the clipboard icon copies the prompt; all three carry the comment
// typed here (`withNote` in config.js puts it on top). It sits under its button, inside an open dialog when there is one.
let pop = null;
let current = null;

const HINT = "<kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel";

/**
 * @param {Element} anchor the button that opened it; focus returns there on close
 * @param {{ heading: string, detail?: string, placeholder?: string, required?: boolean,
 *   prompt?: (comment: string) => Promise<string>, save?: (comment: string) => Promise<unknown>,
 *   send?: { label: string, run: (comment: string) => Promise<unknown> }, notify: (message: string, error?: boolean) => void }} options
 *   `prompt(comment)` is the prompt the button would send, with the comment applied (the launch routes take it as `note`);
 *   with it the popover saves through /api/notes and copies by itself. `save` replaces that (steps save through dispatch).
 */
export function openNotePopover(anchor, options) {
  pop ||= install();
  current = { ...options, anchor };
  const { heading, detail = "", placeholder = "Add a comment for the agent (optional)", required = false, send } = options;
  pop.innerHTML = `<header><b>${escapeHtml(heading)}</b>${detail ? `<span title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>` : ""}</header>
    <textarea name="comment" rows="2" aria-label="${escapeHtml(heading)}" placeholder="${escapeHtml(placeholder)}"${required ? " required" : ""}></textarea>
    <footer><span class="note-pop-hint" data-note-hint>${HINT}</span>
      ${options.prompt ? `<button type="button" class="note-pop-icon" data-note-copy title="Copy the prompt, with your comment" aria-label="Copy the prompt">${glyph("copy")}</button>` : ""}
      ${send ? `<button type="button" class="note-pop-send" data-note-send title="${escapeHtml(send.label)} now, with your comment (⌘Enter)">${escapeHtml(send.label)}</button>` : ""}
      <button type="submit" class="note-pop-save">Save note</button></footer>`;
  (anchor.closest("dialog[open]") || [...document.querySelectorAll("dialog[open]")].pop() || document.body).append(pop);
  if (!pop.matches(":popover-open")) pop.showPopover();
  const box = anchor.getBoundingClientRect(), width = pop.offsetWidth;
  pop.style.left = `${Math.max(16, Math.min(box.left, innerWidth - width - 16))}px`;
  const below = box.bottom + 6, height = pop.offsetHeight;
  pop.style.top = `${below + height > innerHeight - 16 ? Math.max(16, box.top - height - 6) : below}px`;
  pop.querySelector("textarea").focus();
}

export function closeNotePopover() {
  const anchor = current?.anchor;
  current = null;
  if (!pop?.matches(":popover-open")) return;
  const hadFocus = pop.contains(document.activeElement);
  pop.hidePopover();
  if (hadFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
}

// Saves a prompt as an Up next note (`/api/notes`); the server puts the comment on top.
export async function saveUpNextNote({ title, prompt, comment = "" }) {
  const response = await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, prompt, comment }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Couldn't save the note.");
  return body;
}

const hint = (message = "") => {
  const line = pop.querySelector("[data-note-hint]");
  line.classList.toggle("is-error", Boolean(message));
  line.title = message;
  line.innerHTML = message ? escapeHtml(message) : HINT;
};

async function save(options, comment) {
  if (options.save) return options.save(comment);
  const { note } = await saveUpNextNote({ title: options.heading, comment, prompt: await options.prompt("") });
  options.notify(`Saved a note for Up next: ${note}`);
}

async function act(kind, button) {
  const options = current, textarea = pop.querySelector("textarea");
  if (!options || textarea.readOnly) return;
  const comment = textarea.value.trim();
  // A required comment is the note itself; launching or copying without one is fine.
  if (kind === "save" && options.required && !comment) { textarea.focus(); return hint("Write the note first."); }
  hint();
  if (kind === "copy") {
    try {
      const prompt = options.prompt(comment).then((text) => new Blob([text], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": prompt })]);
      button.classList.remove("is-copied"); void button.offsetWidth; button.classList.add("is-copied");
    } catch (error) { hint(error.message); }
    return;
  }
  textarea.readOnly = true;
  for (const control of pop.querySelectorAll("footer button")) control.disabled = true;
  try {
    await (kind === "send" ? options.send.run(comment) : save(options, comment));
    if (current === options) closeNotePopover(); // a save that finishes after the popover was reopened leaves it be
  } catch (error) {
    if (current !== options) return;
    textarea.readOnly = false;
    for (const control of pop.querySelectorAll("footer button")) control.disabled = false;
    hint(error.message);
  }
}

// Built on first use, so modules that import this still load under Node's test runner.
function install() {
  const form = Object.assign(document.createElement("form"), { className: "note-pop", popover: "manual" });
  form.addEventListener("submit", (event) => { event.preventDefault(); act("save"); });
  form.addEventListener("click", (event) => {
    const button = event.target.closest("[data-note-copy], [data-note-send]");
    if (button) act("noteCopy" in button.dataset ? "copy" : "send", button);
  });
  form.addEventListener("keydown", (event) => {
    event.stopPropagation(); // page shortcuts (J/K, 1–4, D) never fire while typing here
    if (event.key === "Escape") { event.preventDefault(); closeNotePopover(); return; }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    act((event.metaKey || event.ctrlKey) && current?.send ? "send" : "save");
  });
  form.addEventListener("input", (event) => { event.target.style.height = "auto"; event.target.style.height = `${event.target.scrollHeight}px`; });
  // An outside click closes it while it is empty; typed text survives.
  document.addEventListener("pointerdown", (event) => {
    if (form.matches(":popover-open") && !form.contains(event.target) && !form.querySelector("textarea").value.trim()) closeNotePopover();
  }, true);
  return form;
}
