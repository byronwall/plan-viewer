// The expanded table's size. It stays centered in the window: dragging any corner or edge grows or shrinks it on both
// sides at once, so the grip stays under the pointer. Sizes are a mode: `fit` (the table's own width and height,
// within the window) or `WxH`, percentages of the window, so a size you dial in on one monitor scales to another.
// While dragging, the edges snap to ½, ⅔, the table's fit and the full window, and a readout names the size.
// Fill width spreads the columns across the overlay (prose wraps instead of scrolling sideways) and keeps them
// following it through every resize, until a column is sized by hand.
const KEY = "plan-viewer:table-size";
const FILL_KEY = "plan-viewer:table-fill";
const MARGIN = 16; // the gap kept to each window edge
const MIN = { w: 420, h: 220 };
const SNAP = 10;
// Each preset's key is its place in the row: 1 ½, 2 ⅔, 3 Fit, 4 Full. F toggles Fill width.
export const PRESETS = [["50x50", "½", "Half the window"], ["67x67", "⅔", "Two thirds of the window"], ["fit", "Fit", "Size to the table"], ["100x100", "Full", "Fill the window"]];
const GRIPS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export const validTableSize = (mode) => mode === "fit" || /^(?:[1-9]\d?|100)x(?:[1-9]\d?|100)$/.test(mode || "");
export function savedTableSize() {
  try { const mode = localStorage.getItem(KEY); return validTableSize(mode) ? mode : "fit"; } catch { return "fit"; }
}

export function savedTableFill() {
  try { return localStorage.getItem(FILL_KEY) !== "0"; } catch { return true; } // on until turned off
}

const bounds = () => ({ w: innerWidth - 2 * MARGIN, h: innerHeight - 2 * MARGIN });
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const apply = (dialog, { w, h }) => {
  dialog.style.width = `${Math.round(w)}px`;
  dialog.style.height = `${Math.round(h)}px`;
};

const padding = (body) => {
  const style = getComputedStyle(body);
  return { x: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight), y: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) };
};

// The table's natural size: its columns plus the dialog's borders, padding and scrollbars, then its rows under the
// header as it wraps at that width. With Fill width on, the columns are laid out for that width before measuring.
function fitSize(dialog, columns, fill) {
  const body = dialog.querySelector(".table-viewer-body");
  const table = body.querySelector("table");
  const pad = padding(body);
  const frame = dialog.offsetWidth - dialog.clientWidth + pad.x;
  const tableWidth = () => fill ? columns.naturalWidth() : table.offsetWidth;
  const max = bounds();
  const previous = [dialog.style.width, body.style.overflow];
  body.style.overflow = "scroll";
  const bar = body.offsetWidth - body.clientWidth; // 0 with overlay scrollbars
  body.style.overflow = previous[1];
  const header = () => dialog.querySelector(".viewer-dialog-heading").offsetHeight;
  // Rows taller than the window bring a vertical scrollbar, which needs its own width. The header wraps as the
  // dialog narrows, so its height is read at the fitted width.
  dialog.style.width = `${Math.round(clamp(tableWidth() + frame, MIN.w, max.w))}px`;
  const tall = header() + table.offsetHeight + frame - pad.x + pad.y > max.h;
  const w = clamp(tableWidth() + frame + (tall ? bar : 0), MIN.w, max.w);
  dialog.style.width = `${Math.round(w)}px`;
  if (fill) columns.fill(w - frame - (tall ? bar : 0));
  const wide = table.offsetWidth + frame + (tall ? bar : 0) > max.w;
  const h = header() + table.offsetHeight + frame - pad.x + pad.y + (wide ? bar : 0);
  dialog.style.width = previous[0];
  return { w, h: clamp(h, MIN.h, max.h) };
}

// How tall the overlay must be to show every row at width `w`, with the columns laid out for that width.
function heightAt(dialog, w, columns, fill) {
  const body = dialog.querySelector(".table-viewer-body");
  const table = body.querySelector("table");
  const pad = padding(body);
  const previous = dialog.style.width;
  dialog.style.width = `${Math.round(w)}px`;
  if (fill) columns.fill(body.clientWidth - pad.x);
  const frame = dialog.offsetHeight - dialog.clientHeight;
  const sideways = table.offsetWidth > body.clientWidth - pad.x ? body.offsetHeight - body.clientHeight : 0;
  const h = dialog.querySelector(".viewer-dialog-heading").offsetHeight + table.offsetHeight + (body.querySelector(".table-viewer-empty:not([hidden])")?.offsetHeight || 0) + frame + pad.y + sideways;
  dialog.style.width = previous;
  return h;
}

const isPreset = (mode) => PRESETS.some(([value]) => value === mode);
// ½, ⅔ and Full never make the overlay taller than its rows need, so a short table doesn't sit over blank space.
// A size dragged by hand is kept as dragged.
function resolve(dialog, mode, columns, fill) {
  if (mode === "fit") return fitSize(dialog, columns, fill);
  const [pw, ph] = mode.split("x").map(Number);
  const max = bounds();
  const w = clamp(innerWidth * pw / 100, MIN.w, max.w);
  const h = clamp(innerHeight * ph / 100, MIN.h, max.h);
  return { w, h: isPreset(mode) ? clamp(Math.min(h, heightAt(dialog, w, columns, fill)), MIN.h, max.h) : h };
}

const percent = (size) => `${Math.round(size.w / innerWidth * 100)}x${Math.round(size.h / innerHeight * 100)}`;

// Builds the size control and grips into a freshly rendered table viewer. `columns` is enhanceTable's column API;
// `onChange({ size, fill })` runs after each change.
export function sizeTableViewer(dialog, { size: mode, fill = false, columns, onChange }) {
  const heading = dialog.querySelector(".viewer-dialog-heading");
  const body = dialog.querySelector(".table-viewer-body");
  heading.querySelector("[data-dialog-close]").insertAdjacentHTML("beforebegin", `<div class="table-size" role="group" aria-label="Layout"><button type="button" class="table-fill" data-table-fill aria-pressed="false" aria-keyshortcuts="F" data-tip="Columns follow the overlay’s width (F)">Fill width</button><span class="table-size-rule" aria-hidden="true"></span>${PRESETS.map(([value, label, name], index) => `<button type="button" data-table-size="${value}" aria-label="${name}" aria-pressed="false" aria-keyshortcuts="${index + 1}" data-tip="${name} (${index + 1})">${label}</button>`).join("")}</div>`);
  dialog.insertAdjacentHTML("beforeend", `${GRIPS.map((grip) => `<span class="table-grip" data-grip="${grip}" aria-hidden="true"></span>`).join("")}<output class="table-size-readout" aria-live="off"></output>`);
  const readout = dialog.querySelector(".table-size-readout");
  let current = validTableSize(mode) ? mode : "fit";

  const mark = () => {
    for (const button of heading.querySelectorAll("[data-table-size]")) button.setAttribute("aria-pressed", String(button.dataset.tableSize === current));
    heading.querySelector("[data-table-fill]").setAttribute("aria-pressed", String(fill));
  };
  const save = () => {
    try { localStorage.setItem(KEY, current); localStorage.setItem(FILL_KEY, fill ? "1" : "0"); } catch {}
    onChange?.({ size: current, fill });
  };
  // The width the columns get inside a dialog `w` wide: less its borders, padding and a vertical scrollbar.
  const inner = (w) => w - (dialog.offsetWidth - body.clientWidth) - padding(body).x;
  let queued = 0;
  const refill = (w) => {
    if (!fill) return;
    cancelAnimationFrame(queued);
    queued = requestAnimationFrame(() => columns.fill(inner(w)));
  };
  const place = (size) => {
    apply(dialog, size);
    refill(size.w);
  };
  const commit = (next, { animate = false } = {}) => {
    current = next;
    if (animate) {
      dialog.classList.add("is-easing");
      setTimeout(() => dialog.classList.remove("is-easing"), 200);
    }
    place(resolve(dialog, current, columns, fill));
    mark();
    save();
  };
  columns.onManual(() => {
    if (!fill) return;
    fill = false;
    mark();
    save();
  });

  const toggleFill = () => {
    fill = !fill;
    if (!fill) columns.restore();
    commit(current);
  };
  heading.addEventListener("click", (event) => {
    const button = event.target.closest("[data-table-size]");
    if (button) commit(button.dataset.tableSize, { animate: true });
    if (event.target.closest("[data-table-fill]")) toggleFill();
  });
  // Keys work anywhere in the overlay except while typing in a filter.
  dialog.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.target.closest("input, textarea, select")) return;
    const preset = PRESETS[Number(event.key) - 1];
    if (preset) commit(preset[0], { animate: true });
    else if (event.key.toLowerCase() === "f") toggleFill();
    else return;
    event.preventDefault();
  });
  dialog.addEventListener("dblclick", (event) => {
    if (event.target.closest("[data-grip]")) commit("fit", { animate: true });
  });
  dialog.addEventListener("pointerdown", (event) => {
    const grip = event.target.closest("[data-grip]");
    if (!grip || event.button !== 0) return;
    event.preventDefault();
    const side = grip.dataset.grip;
    const sx = side.includes("e") ? 1 : side.includes("w") ? -1 : 0;
    const sy = side.includes("s") ? 1 : side.includes("n") ? -1 : 0;
    const start = dialog.getBoundingClientRect();
    const [x0, y0] = [event.clientX, event.clientY];
    const max = bounds();
    const fit = fitSize(dialog, columns, fill);
    const targets = (axis, view) => [[view * .5, "½"], [view * .67, "⅔"], [fit[axis], "Fit"], [max[axis], "Full"]];
    const snap = (value, axis, view) => {
      const hit = targets(axis, view).find(([target]) => Math.abs(value - target) <= SNAP);
      return hit ? [hit[0], hit[1]] : [value, ""];
    };
    let size = { w: start.width, h: start.height };
    let labels = ["", ""];
    grip.setPointerCapture(event.pointerId);
    dialog.classList.add("is-sizing");
    dialog.dataset.sizing = side;
    const move = (moveEvent) => {
      const [w, wLabel] = sx ? snap(clamp(start.width + 2 * sx * (moveEvent.clientX - x0), MIN.w, max.w), "w", innerWidth) : [start.width, ""];
      const [h, hLabel] = sy ? snap(clamp(start.height + 2 * sy * (moveEvent.clientY - y0), MIN.h, max.h), "h", innerHeight) : [start.height, ""];
      size = { w, h };
      labels = [wLabel, hLabel];
      place(size);
      const pct = (value, view) => `${Math.round(value / view * 100)}%`;
      readout.innerHTML = `<b>${Math.round(w)} × ${Math.round(h)}</b><span><i class="${wLabel ? "is-snapped" : ""}">${wLabel || pct(w, innerWidth)}</i> × <i class="${hLabel ? "is-snapped" : ""}">${hLabel || pct(h, innerHeight)}</i></span>`;
    };
    move(event);
    grip.addEventListener("pointermove", move);
    grip.addEventListener("lostpointercapture", () => {
      grip.removeEventListener("pointermove", move);
      dialog.classList.remove("is-sizing");
      delete dialog.dataset.sizing;
      const fitted = (labels[0] === "Fit" || !sx && current === "fit") && (labels[1] === "Fit" || !sy && current === "fit");
      commit(fitted ? "fit" : percent(size));
    }, { once: true });
  });

  // A window resize keeps the same mode, so a percentage size stays that share of the window.
  const refit = () => { if (!dialog.classList.contains("is-sizing")) place(resolve(dialog, current, columns, fill)); };
  addEventListener("resize", refit);
  dialog.addEventListener("close", () => removeEventListener("resize", refit), { once: true });

  place(resolve(dialog, current, columns, fill));
  mark();
}
