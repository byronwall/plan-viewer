// The change map: a treemap of a diff's files laid out by folder, each tile sized by the file's line count (the larger
// of before and after) and filled from the bottom by how much of it changed, green for additions and red for
// deletions. A renamed file also leaves a hatched ghost at its old path, and a ribbon per old-folder → new-folder pair
// shows where files moved. Pure layout and markup; code.js owns state, data and events.
import { escapeHtml } from "./markdown.js";

const HEADER = 15; // folder label strip
const PAD = 2;

const dirOf = (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

// Squarified treemap (Bruls, Huizing, van Wijk): rows of items laid along the short side, keeping tiles near square.
export function squarify(items, x, y, w, h) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const queue = [...items].sort((a, b) => b.value - a.value).map((item) => ({ item, area: item.value * scale }));
  const out = [];
  const worst = (row, side) => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    return Math.max(...row.map((r) => Math.max((side * side * r.area) / (sum * sum), (sum * sum) / (side * side * r.area))));
  };
  const place = (row) => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    if (w >= h) { // column on the left
      const cw = sum / h;
      let cy = y;
      for (const r of row) { const rh = r.area / cw; out.push({ item: r.item, x, y: cy, w: cw, h: rh }); cy += rh; }
      x += cw; w -= cw;
    } else { // row on top
      const rh = sum / w;
      let cx = x;
      for (const r of row) { const rw = r.area / rh; out.push({ item: r.item, x: cx, y, w: rw, h: rh }); cx += rw; }
      y += rh; h -= rh;
    }
  };
  let row = [];
  for (const next of queue) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, next], side) <= worst(row, side)) row.push(next);
    else { place(row); row = [next]; }
  }
  if (row.length) place(row);
  return out;
}

// One entry per tile: every file at its current path, plus a ghost at the old path of each rename.
function entries(files, counts) {
  const before = counts?.before || {};
  const after = counts?.after || {};
  const out = [];
  files.forEach((file, index) => {
    const churn = file.additions + file.deletions;
    const oldLines = file.status === "A" ? 0 : before[file.old] ?? 0;
    const newLines = file.status === "D" ? 0 : after[file.path] ?? 0;
    const lines = Math.max(oldLines, newLines, churn, 1);
    const tile = { file, index, path: file.status === "D" ? file.old || file.path : file.path, oldLines, newLines, value: lines };
    out.push(tile);
    if (file.status === "R" && file.old && file.old !== file.path) out.push({ ...tile, ghost: true, path: file.old, value: Math.max(oldLines, 1) });
  });
  return out;
}

function buildTree(tiles) {
  const root = { name: "", path: "", dirs: new Map(), tiles: [], value: 0 };
  for (const tile of tiles) {
    const parts = tile.path.split("/");
    parts.pop();
    let node = root;
    for (const part of parts) {
      const path = node.path ? `${node.path}/${part}` : part;
      node = node.dirs.get(part) || node.dirs.set(part, { name: part, path, dirs: new Map(), tiles: [], value: 0, additions: 0, deletions: 0 }).get(part);
    }
    node.tiles.push(tile);
  }
  const total = (node) => {
    node.value = node.tiles.reduce((sum, tile) => sum + tile.value, 0);
    node.additions = node.tiles.reduce((sum, tile) => sum + (tile.ghost ? 0 : tile.file.additions), 0);
    node.deletions = node.tiles.reduce((sum, tile) => sum + (tile.ghost ? 0 : tile.file.deletions), 0);
    for (const child of node.dirs.values()) { total(child); node.value += child.value; node.additions += child.additions; node.deletions += child.deletions; }
  };
  total(root);
  return root;
}

// Folders with one subfolder and no files of their own merge into one "a/b/c" label, as in the file list.
const squash = (node) => {
  let name = node.name;
  while (node.dirs.size === 1 && !node.tiles.length) { [node] = node.dirs.values(); name += `/${node.name}`; }
  return { node, name };
};

export function findNode(root, path) {
  if (!path) return root;
  let node = root;
  for (const part of path.split("/")) { node = node.dirs.get(part); if (!node) return null; }
  return node;
}

// Moves bundle at the first folder where a rename's old and new paths part ways, so docs/a/x → STANDARDS/x and
// docs/b/y → STANDARDS/y are one move of two files. Largest first; `id` is stable for one diff.
export function moveGroups(files) {
  const groups = new Map();
  files.forEach((file, index) => {
    if (file.status !== "R" || !file.old || file.old === file.path) return;
    const [from, to] = [dirOf(file.old).split("/"), dirOf(file.path).split("/")];
    let same = 0;
    while (same < from.length && same < to.length && from[same] === to[same]) same++;
    const [a, b] = [from.slice(0, same + 1).join("/"), to.slice(0, same + 1).join("/")];
    const key = `${a}\0${b}`;
    (groups.get(key) || groups.set(key, { from: a, to: b, indexes: [] }).get(key)).indexes.push(index);
  });
  return [...groups.values()].sort((x, y) => y.indexes.length - x.indexes.length || x.from.localeCompare(y.from)).map((group, id) => ({ ...group, id, count: group.indexes.length, within: dirOf(group.from) }));
}

export function layoutMap(files, counts, width, height, zoom = "") {
  const tree = buildTree(entries(files, counts));
  const start = findNode(tree, zoom) || tree;
  const dirs = [];
  const tiles = [];
  const walk = (node, x, y, w, h) => {
    const items = [...[...node.dirs.values()].map((dir) => ({ dir, value: dir.value })), ...node.tiles.map((tile) => ({ tile, value: tile.value }))];
    for (const { item, ...rect } of squarify(items, x, y, w, h)) {
      if (item.tile) { tiles.push({ ...item.tile, ...rect }); continue; }
      const { node: dir, name } = squash(item.dir);
      const header = rect.h > HEADER * 2 && rect.w > 40 ? HEADER : 0;
      dirs.push({ path: dir.path, name, additions: dir.additions, deletions: dir.deletions, header, ...rect });
      // A folder too small for its padding lays its files edge to edge rather than dropping them.
      const pad = rect.w > PAD * 2 + 2 && rect.h > header + PAD * 2 + 2 ? PAD : 0;
      walk(dir, rect.x + pad, rect.y + header + pad, rect.w - pad * 2, rect.h - header - pad * 2);
    }
  };
  walk(start, 0, 0, width, height);
  // Each move's ribbon runs between the centers of its ghosts and of its files, when both ends are in view.
  const moves = moveGroups(files);
  const moveOf = new Map(moves.flatMap((move) => move.indexes.map((index) => [index, move.id])));
  for (const tile of tiles) tile.move = moveOf.get(tile.index);
  const center = (tile) => [tile.x + tile.w / 2, tile.y + tile.h / 2];
  const mean = (points) => points.reduce(([sx, sy], [px, py]) => [sx + px / points.length, sy + py / points.length], [0, 0]);
  const ribbons = moves.flatMap((move) => {
    const mine = tiles.filter((tile) => tile.move === move.id);
    const [a, b] = [mine.filter((tile) => tile.ghost).map(center), mine.filter((tile) => !tile.ghost).map(center)];
    return a.length && b.length ? [{ ...move, start: mean(a), end: mean(b), count: Math.min(a.length, b.length) }] : [];
  });
  // A move's old and new folders get their outline lit: the box at that path, or the outermost one inside it when
  // single-child folders were squashed into one label.
  const box = (path) => dirs.find((dir) => dir.path === path) || dirs.filter((dir) => dir.path.startsWith(`${path}/`)).sort((x, y) => x.path.length - y.path.length)[0];
  for (const move of moves) {
    const [from, to] = [box(move.from), box(move.to)];
    if (from) (from.from ||= []).push(move.id);
    if (to) (to.to ||= []).push(move.id);
  }
  return { dirs, tiles, ribbons, moves, root: start };
}

// The changed share of a tile, filled from its bottom; ghosts and untouched files get none.
const tileFill = (tile) => {
  const churn = tile.file.additions + tile.file.deletions;
  return tile.ghost || !churn ? 0 : Math.max(0.04, Math.min(1, churn / tile.value));
};

const STATUS = { A: "Added", D: "Deleted", R: "Renamed", M: "Modified", C: "Copied" };
const name = (path) => path.split("/").pop();

// `state` carries what the map shows around the tiles: { zoom, current, viewed(file), matches(file), edges }.
export function mapHtml(files, counts, width, height, state) {
  const { dirs, tiles, ribbons } = layoutMap(files, counts, width, height, state.zoom);
  const moveAttrs = (dir) => `${dir.from ? ` data-move-from="${dir.from.join(" ")}"` : ""}${dir.to ? ` data-move-to="${dir.to.join(" ")}"` : ""}`;
  const dirHtml = dirs.map((dir) => `<div class="code-map-dir"${moveAttrs(dir)} style="left:${dir.x}px;top:${dir.y}px;width:${dir.w}px;height:${dir.h}px">${dir.header ? `<button type="button" class="code-map-dir-label" data-map-zoom="${escapeHtml(dir.path)}" data-map-dir="${escapeHtml(dir.path)}"><span>${escapeHtml(dir.name)}/</span>${dir.w > 110 ? `<b class="code-file-add">+${dir.additions}</b><b class="code-file-del">−${dir.deletions}</b>` : ""}</button>` : ""}</div>`).join("");
  const tileHtml = tiles.map((tile) => {
    const { file } = tile;
    const churn = file.additions + file.deletions;
    const fill = tileFill(tile);
    const pure = file.status === "R" && !churn;
    const classes = ["code-map-tile", `is-${(file.status || "M").toLowerCase()}`, tile.ghost && "is-ghost", pure && "is-pure", file === state.current && !tile.ghost && "is-current", state.viewed?.(file) && "is-viewed", state.matches && !state.matches(file) && "is-dim"].filter(Boolean).join(" ");
    const label = tile.w > 34 && tile.h > 13 ? `<span class="code-map-name">${escapeHtml(name(tile.path))}</span>${tile.h > 27 && !tile.ghost && churn ? `<span class="code-map-delta"><b class="code-file-add">+${file.additions}</b> <b class="code-file-del">−${file.deletions}</b></span>` : ""}` : "";
    return `<div class="${classes}" data-diff-file="${tile.index}" data-map-tile="${tile.index}"${tile.ghost ? " data-map-ghost" : ""}${tile.move === undefined ? "" : ` data-move="${tile.move}"`} style="left:${tile.x}px;top:${tile.y}px;width:${tile.w}px;height:${tile.h}px;--fill:${fill};--adds:${churn ? file.additions / churn : 0}">${label}</div>`;
  }).join("");
  const ribbonHtml = ribbons.map((ribbon) => {
    const [x1, y1] = ribbon.start;
    const [x2, y2] = ribbon.end;
    // Bow each curve to one side by a fraction of its length so ribbons between nearby folders don't overlap a line.
    const [mx, my] = [(x1 + x2) / 2 - (y2 - y1) * 0.2, (y1 + y2) / 2 + (x2 - x1) * 0.2];
    const stroke = 1.5 + Math.sqrt(ribbon.count) * 1.6;
    const label = ribbon.count > 1 ? `<text x="${(x1 + 2 * mx + x2) / 4}" y="${(y1 + 2 * my + y2) / 4}">×${ribbon.count}</text>` : "";
    return `<g class="code-map-ribbon" data-move="${ribbon.id}"><path d="M${x1},${y1} Q${mx},${my} ${x2},${y2}" stroke-width="${stroke}" marker-end="url(#code-map-arrow)"/>${label}<title>${ribbon.count} moved from ${escapeHtml(ribbon.from || "(root)")}/ to ${escapeHtml(ribbon.to || "(root)")}/</title></g>`;
  }).join("");
  const svg = !state.edges ? "" : `<svg class="code-map-ribbons" width="${width}" height="${height}" aria-hidden="true"><defs><marker id="code-map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>${ribbonHtml}</svg>`;
  return `<div class="code-map-canvas" style="width:${width}px;height:${height}px">${dirHtml}${tileHtml}${svg}</div>`;
}

// Hover card text for one tile: what changed, where it came from, and its size on each side.
export function tileCard(file, counts, ghost) {
  const before = counts?.before?.[file.old];
  const after = counts?.after?.[file.path];
  const lines = file.status === "A" ? `${after ?? "?"} lines` : file.status === "D" ? `${before ?? "?"} lines` : `${before ?? "?"} → ${after ?? "?"} lines`;
  const from = file.status === "R" ? `<div class="code-muted">${ghost ? "moved to" : "from"} ${escapeHtml(ghost ? file.path : file.old)}</div>` : "";
  return `<b>${escapeHtml(ghost ? file.old : file.path)}</b>${from}<div><span class="code-map-status is-${(file.status || "M").toLowerCase()}">${STATUS[file.status] || "Modified"}</span> · ${counts ? lines : "line counts unavailable"} · <b class="code-file-add">+${file.additions}</b> <b class="code-file-del">−${file.deletions}</b></div>`;
}

// The same map as a standalone SVG, for pasting into a PR: a title band, the legend, then the tiles at the current
// zoom. Labels on hatched tiles sit on a white backing so they stay readable.
const EXPORT_COLORS = { a: "#d4f1df", m: "#e9ecf2", r: "#dfe6ff", c: "#dfe6ff" };
export function mapSvg(files, counts, width, height, state) {
  const top = 46;
  const { dirs, tiles, ribbons } = layoutMap(files, counts, width, height, state.zoom);
  const fit = (text, room, px) => { const max = Math.floor(room / px); return max < 2 ? "" : text.length <= max ? text : `${text.slice(0, max - 1)}…`; };
  const label = (x, y, text, { size = 11, weight = 400, color = "#18212f", backing = false } = {}) => {
    if (!text) return "";
    const back = backing ? `<rect x="${x - 2}" y="${y - size + 1}" width="${text.length * size * 0.56 + 4}" height="${size + 3}" rx="2" fill="#fff" fill-opacity=".9"/>` : "";
    return `${back}<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeHtml(text)}</text>`;
  };
  const focus = state.move ?? null; // a pinned move exports as shown: its folders outlined, everything else faded
  const role = (dir) => focus === null ? "" : dir.from?.includes(focus) ? "from" : dir.to?.includes(focus) ? "to" : "";
  const outline = (dir) => role(dir) ? `<rect x="${dir.x}" y="${dir.y}" width="${dir.w}" height="${dir.h}" rx="3" fill="none" stroke="#3157d5" stroke-width="2"${role(dir) === "from" ? ' stroke-dasharray="5 3"' : ""}/><rect x="${dir.x + dir.w - 66}" y="${dir.y + dir.h - 15}" width="66" height="15" rx="3" fill="#3157d5"/><text x="${dir.x + dir.w - 33}" y="${dir.y + dir.h - 4}" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">moved ${role(dir)}</text>` : "";
  const dirSvg = dirs.map((dir) => `<rect x="${dir.x}" y="${dir.y}" width="${dir.w}" height="${dir.h}" rx="3" fill="#fff" fill-opacity=".5" stroke="#c3cad6"/>${dir.header ? label(dir.x + 4, dir.y + 11.5, fit(`${dir.name}/`, dir.w - 70, 6), { size: 10, weight: 650, color: "#5d6779" }) + (dir.w > 110 ? `<text x="${dir.x + dir.w - 4}" y="${dir.y + 11.5}" font-size="10" font-weight="600" text-anchor="end"><tspan fill="#17725b">+${dir.additions}</tspan> <tspan fill="#a23b35">−${dir.deletions}</tspan></text>` : "") : ""}`).join("");
  const tileSvg = tiles.map((tile) => {
    const { file } = tile;
    const status = (file.status || "M").toLowerCase();
    const hatched = tile.ghost || status === "d";
    const fill = hatched ? `url(#${tile.ghost ? "hatch-ghost" : "hatch-del"})` : EXPORT_COLORS[status] || EXPORT_COLORS.m;
    const churn = file.additions + file.deletions;
    const share = tileFill(tile);
    const bar = share ? (() => { const h = tile.h * share; const addW = tile.w * (file.additions / churn); return `<rect x="${tile.x}" y="${tile.y + tile.h - h}" width="${addW}" height="${h}" fill="#17725b" fill-opacity=".45"/><rect x="${tile.x + addW}" y="${tile.y + tile.h - h}" width="${tile.w - addW}" height="${h}" fill="#a23b35" fill-opacity=".45"/>`; })() : "";
    const color = tile.ghost ? "#1d3eae" : status === "d" ? "#8f2f2a" : "#18212f";
    const name = tile.w > 34 && tile.h > 13 ? label(tile.x + 4, tile.y + 12, fit(tile.path.split("/").pop(), tile.w - 8, 6.2), { color, backing: hatched }) : "";
    const delta = tile.h > 27 && !tile.ghost && churn && tile.w > 40 ? `${hatched ? `<rect x="${tile.x + 2}" y="${tile.y + 16}" width="${String(`+${file.additions} −${file.deletions}`).length * 5.6 + 4}" height="13" rx="2" fill="#fff" fill-opacity=".9"/>` : ""}<text x="${tile.x + 4}" y="${tile.y + 26}" font-size="10" font-weight="600"><tspan fill="#17725b">+${file.additions}</tspan> <tspan fill="#a23b35">−${file.deletions}</tspan></text>` : "";
    const lit = focus !== null && tile.move === focus;
    return `<g${focus !== null && !lit ? ' opacity=".22"' : ""}><rect x="${tile.x}" y="${tile.y}" width="${tile.w}" height="${tile.h}" fill="${fill}" stroke="#fff"/>${bar}${name}${delta}${lit ? `<rect x="${tile.x + 1}" y="${tile.y + 1}" width="${Math.max(0, tile.w - 2)}" height="${Math.max(0, tile.h - 2)}" fill="none" stroke="#3157d5" stroke-width="2"/>` : ""}</g>`;
  }).join("");
  const ribbonSvg = state.edges ? ribbons.filter((ribbon) => focus === null || ribbon.id === focus).map((ribbon) => {
    const [[x1, y1], [x2, y2]] = [ribbon.start, ribbon.end];
    const [mx, my] = [(x1 + x2) / 2 - (y2 - y1) * 0.2, (y1 + y2) / 2 + (x2 - x1) * 0.2];
    return `<path d="M${x1},${y1} Q${mx},${my} ${x2},${y2}" fill="none" stroke="#3157d5" stroke-opacity=".45" stroke-linecap="round" stroke-width="${1.5 + Math.sqrt(ribbon.count) * 1.6}" marker-end="url(#arrow)"/>${ribbon.count > 1 ? `<text x="${(x1 + 2 * mx + x2) / 4}" y="${(y1 + 2 * my + y2) / 4}" font-size="11" font-weight="700" fill="#1d3eae" stroke="#fff" stroke-width="3" paint-order="stroke">×${ribbon.count}</text>` : ""}`;
  }).join("") : "";
  const keys = [["#d4f1df", "Added"], ["#e9ecf2", "Modified"], ["#dfe6ff", "Renamed"], ["url(#hatch-ghost)", "Old path"], ["url(#hatch-del)", "Deleted"]];
  let lx = 0;
  const legend = keys.map(([color, text]) => { const out = `<rect x="${lx}" y="31" width="10" height="10" rx="2" fill="${color}" stroke="#c3cad6" stroke-width=".5"/><text x="${lx + 14}" y="40" font-size="11" fill="#657084">${text}</text>`; lx += 24 + text.length * 6.2; return out; }).join("") + `<text x="${lx + 4}" y="40" font-size="11" fill="#8792a4">Size: ${counts ? "lines" : "lines changed"} · fill: changed share</text>`;
  const hatch = (id, a, b) => `<pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="${b}"/><rect width="4" height="8" fill="${a}"/></pattern>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 24}" height="${height + top + 24}" viewBox="-12 -12 ${width + 24} ${height + top + 24}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"><defs>${hatch("hatch-del", "#f9d8d6", "#fdeceb")}${hatch("hatch-ghost", "#e7ecff", "#f6f8ff")}<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="#3157d5" fill-opacity=".6"/></marker></defs><rect x="-12" y="-12" width="${width + 24}" height="${height + top + 24}" fill="#fff"/><text x="0" y="6" font-size="15" font-weight="700" fill="#18212f">${escapeHtml(state.title || "")}</text><text x="0" y="23" font-size="11.5" fill="#657084">${escapeHtml(state.subtitle || "")}</text>${legend}<g transform="translate(0 ${top})">${dirSvg}${tileSvg}${dirs.map(outline).join("")}${ribbonSvg}</g></svg>`;
}

// Rasterizes an SVG string to a PNG blob at 2x, for the clipboard or a download.
export function svgToPng(svg) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    image.onload = () => {
      const canvas = Object.assign(document.createElement("canvas"), { width: image.width * 2, height: image.height * 2 });
      const context = canvas.getContext("2d");
      context.scale(2, 2);
      context.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not render the map.")), "image/png");
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not render the map.")); };
    image.src = url;
  });
}
