// The expanded table's size. It stays centered in the window: dragging any corner or edge grows or shrinks it on both
// sides at once, so the grip stays under the pointer. Sizes are a mode: `fit` (the table's own width and height,
// within the window) or `WxH`, percentages of the window, so a size you dial in on one monitor scales to another.
// While dragging, the edges snap to ½, ⅔, the table's fit and the full window, and a readout names the size.
const KEY = "plan-viewer:table-size";
const MARGIN = 16; // the gap kept to each window edge
const MIN = { w: 420, h: 220 };
const SNAP = 10;
export const PRESETS = [["50x50", "½", "Half the window"], ["67x67", "⅔", "Two thirds of the window"], ["fit", "Fit", "Fit the table"], ["100x100", "Full", "Fill the window"]];
const GRIPS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export const validTableSize = (mode) => mode === "fit" || /^(?:[1-9]\d?|100)x(?:[1-9]\d?|100)$/.test(mode || "");
export function savedTableSize() {
  try { const mode = localStorage.getItem(KEY); return validTableSize(mode) ? mode : "fit"; } catch { return "fit"; }
}

const bounds = () => ({ w: innerWidth - 2 * MARGIN, h: innerHeight - 2 * MARGIN });
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const apply = (dialog, { w, h }) => {
  dialog.style.width = `${Math.round(w)}px`;
  dialog.style.height = `${Math.round(h)}px`;
};

// The table's natural size: its fitted columns plus the dialog's borders and scrollbars, then its rows under the
// header as it wraps at that width.
function fitSize(dialog) {
  const body = dialog.querySelector(".table-viewer-body");
  const table = body.querySelector("table");
  const frame = dialog.offsetWidth - dialog.clientWidth;
  const max = bounds();
  const previous = [dialog.style.width, body.style.overflow];
  body.style.overflow = "scroll";
  const bar = body.offsetWidth - body.clientWidth; // 0 with overlay scrollbars
  body.style.overflow = previous[1];
  const header = () => dialog.querySelector(".viewer-dialog-heading").offsetHeight;
  // Rows taller than the window bring a vertical scrollbar, which needs its own width. The header wraps as the
  // dialog narrows, so its height is read at the fitted width.
  dialog.style.width = `${Math.round(clamp(table.offsetWidth + frame, MIN.w, max.w))}px`;
  const tall = header() + table.offsetHeight + frame > max.h;
  const w = clamp(table.offsetWidth + frame + (tall ? bar : 0), MIN.w, max.w);
  dialog.style.width = `${Math.round(w)}px`;
  const wide = table.offsetWidth + frame + (tall ? bar : 0) > max.w;
  const h = header() + table.offsetHeight + frame + (wide ? bar : 0);
  dialog.style.width = previous[0];
  return { w, h: clamp(h, MIN.h, max.h) };
}

function resolve(dialog, mode) {
  if (mode === "fit") return fitSize(dialog);
  const [pw, ph] = mode.split("x").map(Number);
  const max = bounds();
  return { w: clamp(innerWidth * pw / 100, MIN.w, max.w), h: clamp(innerHeight * ph / 100, MIN.h, max.h) };
}

const percent = (size) => `${Math.round(size.w / innerWidth * 100)}x${Math.round(size.h / innerHeight * 100)}`;

// Builds the size control and grips into a freshly rendered table viewer. `onChange(mode)` runs after each change.
export function sizeTableViewer(dialog, mode, onChange) {
  const heading = dialog.querySelector(".viewer-dialog-heading");
  heading.querySelector("[data-dialog-close]").insertAdjacentHTML("beforebegin", `<div class="table-size" role="group" aria-label="Overlay size">${PRESETS.map(([value, label, name]) => `<button type="button" data-table-size="${value}" aria-label="${name}" aria-pressed="false">${label}</button>`).join("")}</div>`);
  dialog.insertAdjacentHTML("beforeend", `${GRIPS.map((grip) => `<span class="table-grip" data-grip="${grip}" aria-hidden="true"></span>`).join("")}<output class="table-size-readout" aria-live="off"></output>`);
  const readout = dialog.querySelector(".table-size-readout");
  let current = validTableSize(mode) ? mode : "fit";

  const mark = () => {
    for (const button of heading.querySelectorAll("[data-table-size]")) button.setAttribute("aria-pressed", String(button.dataset.tableSize === current));
  };
  const commit = (next, { animate = false } = {}) => {
    current = next;
    if (animate) {
      dialog.classList.add("is-easing");
      setTimeout(() => dialog.classList.remove("is-easing"), 200);
    }
    apply(dialog, resolve(dialog, current));
    mark();
    try { localStorage.setItem(KEY, current); } catch {}
    onChange?.(current);
  };

  heading.addEventListener("click", (event) => {
    const button = event.target.closest("[data-table-size]");
    if (button) commit(button.dataset.tableSize, { animate: true });
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
    const fit = fitSize(dialog);
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
      apply(dialog, size);
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
  const refit = () => { if (!dialog.classList.contains("is-sizing")) apply(dialog, resolve(dialog, current)); };
  addEventListener("resize", refit);
  dialog.addEventListener("close", () => removeEventListener("resize", refit), { once: true });

  apply(dialog, resolve(dialog, current));
  mark();
}
