// What every overlay (PR and worktree overview, issue overview, initiative reader, Slack thread, document peek) shares:
// a `dialog.code-diff` that closes on a press that starts and ends on the backdrop, keeps what it shows in URL
// parameters, and announces its close so app.js can offer Reopen. app.js's OVERLAYS table maps each parameter back
// to its opener, title and toast for refreshes, Recently viewed, Favorites and that Reopen toast.

// `keepOpen` returns true while the overlay holds typed text, so a stray backdrop click can't lose it.
export function createOverlay(className, { keepOpen = () => false } = {}) {
  const dialog = Object.assign(document.body.appendChild(document.createElement("dialog")), { className: `code-diff ${className}`.trim(), tabIndex: -1 });
  let pressedBackdrop = false;
  dialog.addEventListener("pointerdown", (event) => { pressedBackdrop = event.target === dialog; });
  dialog.addEventListener("click", (event) => { if (event.target === dialog && pressedBackdrop && !keepOpen()) dialog.close(); });
  return dialog;
}

// Sets the given URL parameters (an empty value removes one) without adding a history entry.
export function setOverlayParams(values) {
  const url = new URL(location.href);
  for (const [name, value] of Object.entries(values)) value ? url.searchParams.set(name, value) : url.searchParams.delete(name);
  if (url.href !== location.href) history.replaceState(history.state, "", url);
}

// Call from the dialog's close handler while the URL still names what was open.
export const announceClosed = () => document.dispatchEvent(new CustomEvent("overview-closed", { detail: location.href }));
