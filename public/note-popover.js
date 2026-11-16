import { escapeHtml } from "./markdown.js";
import { glyph } from "./icons.js";

// Every button that would start an agent chat opens this popover instead: the prompt it would have sent is saved as an
// Up next note for an orchestrator thread to pick up. Enter saves (with an optional comment), Shift+Enter is a new line,
// Esc cancels. The old launch stays one quiet button away (⌘Enter), and the clipboard icon copies the prompt.
// It sits under its button, inside an open dialog when there is one so it stays interactive.
// Built on first use, so modules that import this still load under Node's test runner.
let pop = null;
let current = null;

/**
 * @param {Element} anchor the button that opened it
 * @param {{ heading: string, detail?: string, placeholder?: string, required?: boolean,
 *   save: (comment: string) => Promise<unknown>, send?: { label: string, run: (comment: string) => Promise<unknown> },
 *   copy?: (comment: string) => Promise<string> }} options
 */
export function openNotePopover(anchor, options) {
  pop ||= install();
  current = options;
  const { heading, detail = "", placeholder = "Add a comment for the agent (optional)", required = false, send, copy } = options;
  pop.innerHTML = `<header><b>${escapeHtml(heading)}</b>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</header>
    <textarea name="comment" rows="2" aria-label="${escapeHtml(heading)}" placeholder="${escapeHtml(placeholder)}"${required ? " required" : ""}></textarea>
    <footer><span class="note-pop-hint" data-note-hint><kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
      ${copy ? `<button type="button" class="note-pop-icon" data-note-copy title="Copy the prompt" aria-label="Copy the prompt">${glyph("copy")}</button>` : ""}
      ${send ? `<button type="button" class="note-pop-send" data-note-send title="${escapeHtml(send.label)} now (⌘Enter)">${escapeHtml(send.label)}</button>` : ""}
      <button type="submit" class="note-pop-save">Save note</button></footer>`;
  (anchor.closest("dialog[open]") || [...document.querySelectorAll("dialog[open]")].pop() || document.body).append(pop);
  if (!pop.matches(":popover-open")) pop.showPopover();
  const box = anchor.getBoundingClientRect(), width = pop.offsetWidth;
  pop.style.left = `${Math.max(16, Math.min(box.left, innerWidth - width - 16))}px`;
  const below = box.bottom + 6, height = pop.offsetHeight;
  pop.style.top = `${below + height > innerHeight - 16 ? Math.max(16, box.top - height - 6) : below}px`;
  pop.querySelector("textarea").focus();
}

export const closeNotePopover = () => { if (pop?.matches(":popover-open")) pop.hidePopover(); current = null; };
export const notePopoverOpen = () => Boolean(pop?.matches(":popover-open"));

// Saves a prompt as an Up next note (`/api/notes`); a comment the prompt doesn't already carry goes at its top.
export async function saveUpNextNote({ title, prompt, comment = "", source = "", task = "", step = "" }) {
  const response = await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, prompt, comment, source, task, step }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Couldn't save the note.");
  return body;
}

const hint = (message = "") => {
  const line = pop.querySelector("[data-note-hint]");
  line.classList.toggle("is-error", Boolean(message));
  line.innerHTML = message ? escapeHtml(message) : "<kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel";
};

async function act(kind, button) {
  const options = current, textarea = pop.querySelector("textarea");
  if (!options || textarea.readOnly) return;
  const comment = textarea.value.trim();
  if (kind !== "copy" && options.required && !comment) { textarea.focus(); return hint("Write the note first."); }
  hint();
  if (kind === "copy") {
    try {
      const prompt = options.copy(comment).then((text) => new Blob([text], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": prompt })]);
      button.classList.remove("is-copied"); void button.offsetWidth; button.classList.add("is-copied");
    } catch (error) { hint(error.message); }
    return;
  }
  textarea.readOnly = true;
  try {
    await (kind === "send" ? options.send.run(comment) : options.save(comment));
    closeNotePopover();
  } catch (error) { textarea.readOnly = false; hint(error.message); }
}

function install() {
  const form = Object.assign(document.createElement("form"), { className: "note-pop", popover: "manual" });
  form.addEventListener("submit", (event) => { event.preventDefault(); act("save"); });
  form.addEventListener("click", (event) => {
    const button = event.target.closest("[data-note-copy], [data-note-send]");
    if (button) act("copy" in button.dataset ? "copy" : "send", button);
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
