import { glyph } from "./icons.js";

// The expanded table: click a header to sort (Shift-click adds a tiebreak), filter one column or every column, and drag a header edge to resize (double-click fits it).
const EMPTY = /^(|—|–|-|n\/a)$/i;
const toNumber = (text) => {
  const value = text.replace(/[,$%\s]/g, "");
  return value && Number.isFinite(Number(value)) ? Number(value) : NaN;
};
const toDate = (text) => /\d/.test(text) && /[a-z]{3}|\d{4}-\d/i.test(text) ? Date.parse(text) : NaN;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function columnKind(cells) {
  const values = cells.filter((cell) => !cell.empty).map((cell) => cell.text);
  if (!values.length) return "text";
  if (values.every((text) => !Number.isNaN(toNumber(text)))) return "number";
  if (values.every((text) => !Number.isNaN(toDate(text)))) return "date";
  return "text";
}

// A column filter matches text by default; `=x` is exact, `!x` excludes, and `> < >= <=` compare numbers, dates or text.
export function cellTest(raw, kind) {
  const [, op = "", operand] = raw.trim().match(/^(>=|<=|>|<|=|!)?\s*(.*)$/s);
  const needle = operand.toLowerCase();
  if (!needle) return null;
  if (op === "=") return (cell) => cell.text.toLowerCase() === needle;
  if (op === "!") return (cell) => !cell.text.toLowerCase().includes(needle);
  if (!op) return (cell) => cell.text.toLowerCase().includes(needle);
  const bound = kind === "number" ? toNumber(operand) : kind === "date" ? toDate(operand) : needle;
  if (Number.isNaN(bound)) return null;
  return (cell) => !cell.empty && (op === ">" ? cell.key > bound : op === "<" ? cell.key < bound : op === ">=" ? cell.key >= bound : cell.key <= bound);
}

function compare(a, b, kind, dir) {
  if (a.empty || b.empty) return a.empty === b.empty ? 0 : a.empty ? 1 : -1; // blanks sort last either way
  return (kind === "text" ? collator.compare(a.text, b.text) : a.key - b.key) * dir;
}

// Matches are painted with the CSS Custom Highlight API, so the cells' markup never changes.
function highlight(rows, terms, needles) {
  if (!globalThis.CSS?.highlights) return;
  const ranges = [];
  for (const row of rows) {
    [...row.tr.cells].forEach((td, index) => {
      const words = needles[index] ? [...terms, needles[index]] : terms;
      if (!words.length) return;
      const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.data.toLowerCase();
        for (const word of words) {
          for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) {
            const range = new Range();
            range.setStart(node, at);
            range.setEnd(node, at + word.length);
            ranges.push(range);
          }
        }
      }
    });
  }
  CSS.highlights.set("table-match", new Highlight(...ranges));
}

export function enhanceTable(dialog, cellText) {
  const table = dialog.querySelector(".table-viewer-body table");
  const body = table.tBodies[0];
  const head = table.tHead.rows[0];
  const count = dialog.querySelector("h2 span");
  const rows = [...body.rows].map((tr, index) => {
    const cells = [...tr.cells].map((td) => ({ text: cellText(td) }));
    return { tr, index, cells, text: cells.map((cell) => cell.text.toLowerCase()).join("\n") };
  });
  const columns = head.cells.length;
  const kinds = [...head.cells].map((_, column) => {
    const cells = rows.map((row) => row.cells[column] || (row.cells[column] = { text: "" }));
    for (const cell of cells) cell.empty = EMPTY.test(cell.text);
    const kind = columnKind(cells);
    for (const cell of cells) cell.key = kind === "number" ? toNumber(cell.text) : kind === "date" ? toDate(cell.text) : cell.text.toLowerCase();
    return kind;
  });
  let sorts = [];
  const filters = Array(columns).fill("");
  let query = "";

  // Header: each label becomes a sort button with a resize grip, over a row of column filters.
  [...head.cells].forEach((th, column) => {
    if (kinds[column] === "number" && !th.classList.contains("align-center")) {
      th.classList.add("align-right");
      for (const row of rows) row.tr.cells[column]?.classList.add("align-right");
    }
    th.innerHTML = `<button type="button" class="table-sort" data-sort-column="${column}" title="Sort (Shift-click to add a tiebreak)"><span class="table-sort-label">${th.innerHTML}</span><span class="table-sort-mark" aria-hidden="true">${glyph("arrow-up")}<b></b></span></button><span class="table-resize" data-resize-column="${column}" aria-hidden="true"></span>`;
  });
  const values = (column) => [...new Set(rows.map((row) => row.cells[column].text).filter(Boolean))];
  const placeholder = (column) => kinds[column] === "number" ? "e.g. > 10" : kinds[column] === "date" ? `> ${rows.find((row) => !row.cells[column].empty)?.cells[column].text || "date"}` : "Filter";
  table.tHead.insertAdjacentHTML("beforeend", `<tr class="table-filter-row" data-table-ui>${[...head.cells].map((th, column) => {
    const list = values(column);
    const datalist = kinds[column] === "text" && list.length < rows.length && list.length <= 40 ? `<datalist id="table-values-${column}">${list.sort(collator.compare).map((value) => `<option value="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></option>`).join("")}</datalist>` : "";
    return `<th><input type="search" size="1" spellcheck="false" autocomplete="off" data-filter-column="${column}" placeholder="${placeholder(column)}" aria-label="Filter ${cellText(th)}"${datalist ? ` list="table-values-${column}"` : ""}>${datalist}</th>`;
  }).join("")}</tr>`);
  dialog.querySelector(".viewer-dialog-heading h2").insertAdjacentHTML("afterend", `<label class="table-viewer-filter">${glyph("search")}<input type="search" spellcheck="false" autocomplete="off" placeholder="Filter all columns" aria-label="Filter all columns" aria-keyshortcuts="/" data-filter-all><kbd>/</kbd></label><button type="button" class="table-viewer-clear" data-table-clear hidden>Clear</button>`);
  const all = dialog.querySelector("[data-filter-all]");
  const clear = dialog.querySelector("[data-table-clear]");

  function update() {
    const tests = filters.map((raw, column) => cellTest(raw, kinds[column]));
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const order = [...rows].sort((a, b) => {
      for (const { column, dir } of sorts) {
        const result = compare(a.cells[column], b.cells[column], kinds[column], dir);
        if (result) return result;
      }
      return a.index - b.index;
    });
    body.append(...order.map((row) => row.tr));
    const visible = order.filter((row) => {
      const show = terms.every((term) => row.text.includes(term)) && tests.every((test, column) => !test || test(row.cells[column]));
      row.tr.hidden = !show;
      return show;
    });
    [...head.cells].forEach((th, column) => {
      const at = sorts.findIndex((sort) => sort.column === column);
      th.setAttribute("aria-sort", at < 0 ? "none" : sorts[at].dir > 0 ? "ascending" : "descending");
      th.querySelector(".table-sort-mark b").textContent = sorts.length > 1 && at >= 0 ? at + 1 : "";
    });
    const filtered = visible.length < rows.length;
    count.textContent = `${filtered ? `${visible.length} of ` : ""}${rows.length} rows × ${columns} columns`;
    clear.hidden = !query && !filters.some(Boolean) && !sorts.length;
    highlight(visible, terms, filters.map((raw) => /^[^=!<>]/.test(raw.trim()) ? raw.trim().toLowerCase() : ""));
  }

  // Columns open fitted to their content (long text wraps past 480px) and keep fixed pixel widths, so dragging one edge moves only that column.
  const widths = Array(columns).fill(0);
  table.insertAdjacentHTML("afterbegin", `<colgroup data-table-ui>${widths.map(() => "<col>").join("")}</colgroup>`);
  const cols = [...table.querySelectorAll("col")];
  const setWidth = (column, width) => {
    widths[column] = Math.round(Math.max(44, width));
    cols[column].style.width = `${widths[column]}px`;
    table.style.width = `${widths.reduce((total, value) => total + value, 0)}px`;
  };
  function fitColumn(column) {
    table.classList.add("is-measuring");
    const button = head.cells[column].querySelector(".table-sort");
    const label = button.querySelector(".table-sort-label");
    const style = getComputedStyle(button);
    const range = new Range();
    const cells = [...rows.filter((row) => !row.tr.hidden).map((row) => row.tr.cells[column])].filter(Boolean);
    const padding = cells.length ? parseFloat(getComputedStyle(cells[0]).paddingLeft) + parseFloat(getComputedStyle(cells[0]).paddingRight) : 0;
    const natural = Math.max(label.scrollWidth + button.querySelector(".table-sort-mark").offsetWidth + parseFloat(style.columnGap) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight), ...cells.map((cell) => {
      range.selectNodeContents(cell);
      return range.getBoundingClientRect().width + padding;
    }));
    table.classList.remove("is-measuring");
    setWidth(column, Math.min(480, Math.ceil(natural) + 2));
  }

  table.tHead.addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort-column]");
    if (!button) return;
    const column = Number(button.dataset.sortColumn);
    const current = sorts.find((sort) => sort.column === column)?.dir || 0;
    const dir = current === 0 ? 1 : current === 1 ? -1 : 0;
    if (!event.shiftKey) sorts = dir ? [{ column, dir }] : [];
    else if (!dir) sorts = sorts.filter((sort) => sort.column !== column);
    else sorts = current ? sorts.map((sort) => sort.column === column ? { column, dir } : sort) : [...sorts, { column, dir }];
    update();
  });
  table.tHead.addEventListener("input", (event) => {
    if (!event.target.dataset.filterColumn) return;
    filters[event.target.dataset.filterColumn] = event.target.value;
    update();
  });
  all.addEventListener("input", () => {
    query = all.value;
    update();
  });
  clear.addEventListener("click", () => {
    for (const input of dialog.querySelectorAll("input[type='search']")) input.value = "";
    filters.fill("");
    query = "";
    sorts = [];
    update();
    all.focus();
  });
  table.tHead.addEventListener("dblclick", (event) => {
    const grip = event.target.closest("[data-resize-column]");
    if (grip) fitColumn(Number(grip.dataset.resizeColumn));
  });
  table.tHead.addEventListener("pointerdown", (event) => {
    const grip = event.target.closest("[data-resize-column]");
    if (!grip || event.button !== 0) return;
    event.preventDefault();
    const column = Number(grip.dataset.resizeColumn);
    const start = event.clientX - widths[column];
    grip.setPointerCapture(event.pointerId);
    dialog.classList.add("is-resizing");
    const move = (moveEvent) => setWidth(column, moveEvent.clientX - start);
    grip.addEventListener("pointermove", move);
    grip.addEventListener("lostpointercapture", () => {
      grip.removeEventListener("pointermove", move);
      dialog.classList.remove("is-resizing");
    }, { once: true });
  });
  // `/` jumps to the all-columns filter; Escape in a filter clears it before it closes the table.
  for (const region of [dialog.querySelector(".viewer-dialog-heading"), dialog.querySelector(".table-viewer-body")]) {
    region.addEventListener("keydown", (event) => {
      const input = event.target.closest("input[type='search']");
      if (event.key === "Escape" && input?.value) {
        event.preventDefault();
        event.stopPropagation();
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (event.key === "/" && !input && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        all.focus();
      }
    });
  }
  dialog.addEventListener("close", () => globalThis.CSS?.highlights?.delete("table-match"), { once: true });
  update();
  table.classList.add("is-sized");
  widths.forEach((_, column) => fitColumn(column));
}
