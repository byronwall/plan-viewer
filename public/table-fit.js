// Document tables: column widths fitted to their content, and a scroll frame for tall tables.
//
// Widths: each column is measured once (its one-line width and its narrowest unbreakable width), then the frame's
// width goes, a few pixels at a time, to whichever column shortens the table the most. Short columns end up exactly
// as wide as their text; prose columns share the rest. A table that cannot fit keeps readable minimums and scrolls
// sideways with its first column pinned.
//
// Height: a table much taller than the window scrolls inside its frame under a sticky header, with a footer that
// shows which rows are in view and offers Show all and Expand.

const STEP = 8;
const FLOOR = 120;
const SAMPLE = 300;
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

// One pass with every cell on one line gives each cell's natural width; one pass at zero width gives each column's
// narrowest width (long words and short links never break).
function measure(table) {
  const head = table.tHead.rows[0];
  const rows = [head, ...[...table.tBodies[0].rows].slice(0, SAMPLE)];
  const columns = head.cells.length;
  const style = getComputedStyle(head.cells[0]);
  const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth) + 2;
  const range = document.createRange();
  table.classList.add("is-measuring-max");
  const natural = rows.map((row) => Array.from({ length: columns }, (_, column) => {
    const cell = row.cells[column];
    if (!cell) return 0;
    range.selectNodeContents(cell);
    return Math.ceil(range.getBoundingClientRect().width);
  }));
  table.classList.replace("is-measuring-max", "is-measuring-min");
  const narrow = [...head.cells].map((cell) => cell.getBoundingClientRect().width);
  table.classList.remove("is-measuring-min");
  const max = Array.from({ length: columns }, (_, column) => Math.max(...natural.map((row) => row[column])) + pad);
  const min = narrow.map((width, column) => Math.min(Math.ceil(width), max[column]));
  return { natural, max, min, pad };
}

// Greedy: start every column at a readable floor, then hand out the remaining width in small steps to the column
// whose growth removes the most estimated lines across the table. Leftover width goes to the column with the most text.
function distribute({ natural, max, min, pad }, avail) {
  const columns = max.length;
  const sum = (list) => list.reduce((total, width) => total + width, 0);
  let widths = max.map((width, column) => Math.max(min[column], Math.min(width, FLOOR)));
  if (sum(widths) > avail && sum(min) <= avail) widths = [...min];
  const lines = (row, column, width) => Math.max(1, natural[row][column] / Math.max(1, width - pad));
  const height = (column, width) => {
    let sum = 0;
    for (let row = 0; row < natural.length; row++) {
      let tallest = 1;
      for (let other = 0; other < columns; other++) tallest = Math.max(tallest, lines(row, other, other === column ? width : widths[other]));
      sum += tallest;
    }
    return sum;
  };
  let spare = Math.max(0, avail - sum(widths));
  while (spare > 0) {
    const now = height(-1, 0);
    let best = -1;
    let gain = 0;
    for (let column = 0; column < columns; column++) {
      if (widths[column] >= max[column]) continue;
      const step = Math.min(STEP, spare, max[column] - widths[column]);
      const saved = (now - height(column, widths[column] + step)) / step;
      if (best < 0 || saved > gain) [best, gain] = [column, saved];
    }
    if (best < 0) break;
    const step = Math.min(STEP, spare, max[best] - widths[best]);
    widths[best] += step;
    spare -= step;
  }
  if (spare > 0) {
    const widest = max.indexOf(Math.max(...max));
    widths[widest] += spare;
  }
  return widths.map(Math.floor);
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
