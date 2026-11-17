// Column widths for a frame of a given width, shared by document tables (table-fit.js) and the expanded table
// (table-viewer.js). Each column is measured once (its one-line width and its narrowest unbreakable width), then the
// width goes, a few pixels at a time, to whichever column shortens the table the most.
const STEP = 8;
const FLOOR = 120;
const SAMPLE = 300;

// One pass with every cell on one line gives each cell's natural width; one pass at zero width gives each column's
// narrowest width (long words and short links never break).
export function measure(table) {
  const head = table.tHead.rows[0];
  const rows = [head, ...[...table.tBodies[0].rows].slice(0, SAMPLE)];
  const columns = head.cells.length;
  const style = getComputedStyle(table.tBodies[0].rows[0]?.cells[0] || head.cells[0]); // the overlay's header cells pad their sort buttons instead
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
export function distribute({ natural, max, min, pad }, avail) {
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
