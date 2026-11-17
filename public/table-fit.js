// Document tables: column widths fitted to their content, and a scroll frame for tall tables.
//
// Widths: each column is measured once (its one-line width and its narrowest unbreakable width), then the frame's
// width goes, a few pixels at a time, to whichever column shortens the table the most. Short columns end up exactly
// as wide as their text; prose columns share the rest. A table that cannot fit keeps readable minimums and scrolls
// sideways with its first column pinned.
//
// Height: a table much taller than the window scrolls inside its frame under a sticky header, with a footer that
// shows which rows are in view and offers Show all and Expand.
import { distribute, measure } from "./column-fit.js";

const LONG_TOKEN = 28;
const fits = new WeakMap();

const capHeight = () => Math.max(360, Math.min(innerHeight * 0.7, 900));

const resize = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    if (!target.isConnected) resize.unobserve(target);
    else if (target.clientWidth) fit(target);
  }
});

new MutationObserver((records) => {
  for (const record of records) for (const node of record.addedNodes) {
    if (node.nodeType !== 1) continue;
    const frames = node.matches(".markdown-table-scroll") ? [node] : node.querySelectorAll(".markdown-table-scroll");
    for (const frame of frames) resize.observe(frame);
  }
}).observe(document.documentElement, { childList: true, subtree: true });

function fit(frame) {
  const table = frame.querySelector("table");
  let fitted = fits.get(frame);
  if (!fitted) {
    for (const link of table.querySelectorAll("td a")) if (link.textContent.length - (link.querySelector(".sr-only")?.textContent.length || 0) > LONG_TOKEN) wrapLink(link);
    for (const code of table.querySelectorAll("td code")) if (code.textContent.length > LONG_TOKEN) code.classList.add("is-wrap");
    fitted = { measure: measure(table), avail: 0 };
    fits.set(frame, fitted);
  }
  const avail = frame.clientWidth;
  if (avail !== fitted.avail) {
    fitted.avail = avail;
    const widths = distribute(fitted.measure, avail);
    let group = table.querySelector(":scope > colgroup");
    if (!group) group = table.insertBefore(document.createElement("colgroup"), table.firstChild);
    group.innerHTML = widths.map((width) => `<col style="width: ${width}px">`).join("");
    const total = widths.reduce((sum, width) => sum + width, 0);
    table.style.width = `${total}px`;
    table.classList.add("is-fitted");
    frame.classList.toggle("is-wide", total > avail + 1);
  }
  cap(frame, table);
}

// Links and code under LONG_TOKEN characters never break. A longer link title may wrap inside its cell, but its last
// word stays with the trailing ↗ mark.
function wrapLink(link) {
  link.classList.add("is-wrap");
  const mark = link.querySelector(":scope > .external-mark");
  const text = mark?.previousSibling;
  if (text?.nodeType !== 3) return;
  const space = text.data.trimEnd().lastIndexOf(" ");
  const tail = space < 0 ? text : text.splitText(space + 1);
  const keep = Object.assign(document.createElement("span"), { className: "link-tail" });
  link.insertBefore(keep, tail);
  keep.append(tail, mark);
}

function cap(frame, table) {
  const wrapper = frame.closest(".markdown-table");
  const rows = table.tBodies[0].rows.length;
  const tall = table.offsetHeight > capHeight() * 1.3;
  wrapper.classList.toggle("is-capped", tall);
  let foot = wrapper.querySelector(":scope > .table-foot");
  wrapper.querySelector(".table-view-tools [data-table-all]").hidden = !tall;
  if (!tall) return foot?.remove();
  if (!foot) {
    wrapper.insertAdjacentHTML("beforeend", `<div class="table-foot"><span class="table-foot-range" aria-live="polite"></span><button type="button" data-table-all></button><button type="button" data-table-expand aria-label="Open table in an overlay">Expand</button></div>`);
    foot = wrapper.lastElementChild;
    frame.addEventListener("scroll", () => requestAnimationFrame(() => showRange(frame, table)), { passive: true });
  }
  for (const toggle of wrapper.querySelectorAll("[data-table-all]")) toggle.textContent = wrapper.classList.contains("is-showing-all") ? "Collapse" : `Show all ${rows} rows`;
  showRange(frame, table);
  stick();
}

// "Rows 13–24 of 158": the first and last body rows that show under the sticky header.
function showRange(frame, table) {
  const label = frame.closest(".markdown-table").querySelector(".table-foot-range");
  if (!label) return;
  const rows = table.tBodies[0].rows;
  if (frame.closest(".markdown-table").classList.contains("is-showing-all")) return void (label.textContent = `${rows.length} rows`);
  const top = frame.scrollTop + table.tHead.offsetHeight;
  const bottom = frame.scrollTop + frame.clientHeight;
  const first = search(rows, (row) => row.offsetTop + row.offsetHeight > top + 2);
  const last = search(rows, (row) => row.offsetTop >= bottom - 2) - 1;
  label.textContent = `Rows ${first + 1}–${Math.max(first + 1, last + 1)} of ${rows.length}`;
}

function search(rows, past) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (past(rows[mid])) high = mid;
    else low = mid + 1;
  }
  return low;
}

document.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-table-all]");
  if (!toggle) return;
  const wrapper = toggle.closest(".markdown-table");
  const frame = wrapper.querySelector(".markdown-table-scroll");
  const all = wrapper.classList.toggle("is-showing-all");
  for (const button of wrapper.querySelectorAll("[data-table-all]")) button.textContent = all ? "Collapse" : `Show all ${frame.querySelector("tbody").rows.length} rows`;
  if (!all && wrapper.getBoundingClientRect().top < 0) wrapper.scrollIntoView({ block: "start", behavior: "instant" });
  showRange(frame, frame.querySelector("table"));
  stick();
});

// A tall table's tab bar is sticky under the page's sticky dock. Once it leaves its resting place on the table's top
// edge it floats over the rows, so it gets a full border and a shadow.
function stick() {
  for (const bar of document.querySelectorAll(".markdown-table.is-capped > .table-bar")) {
    const rest = bar.parentElement.getBoundingClientRect().top - bar.offsetHeight + 1;
    bar.classList.toggle("is-stuck", rest < bar.getBoundingClientRect().top - 0.5);
  }
}
let stickQueued = false;
document.addEventListener("scroll", () => {
  if (stickQueued) return;
  stickQueued = true;
  requestAnimationFrame(() => { stickQueued = false; stick(); });
}, { capture: true, passive: true });
