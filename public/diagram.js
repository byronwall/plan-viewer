// The image viewer's diagram mode: a `.draft` drawn inline beside its source, each statement linked to what it draws.
import { escapeHtml } from "./markdown.js";

// The server draws the SVG with draftably; it is placed inline (so hover can link it to the source), minus anything
// that could run. Returns the markup and its intrinsic size.
export function inlineSvg(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.nodeName !== "svg") return null;
  for (const node of svg.querySelectorAll("script, foreignObject, iframe, metadata")) node.remove();
  for (const node of [svg, ...svg.querySelectorAll("*")]) {
    for (const { name, value } of [...node.attributes]) {
      if (/^on/i.test(name) || (/href$/i.test(name) && /^\s*javascript:/i.test(value))) node.removeAttribute(name);
    }
  }
  const box = svg.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  const width = Number(svg.getAttribute("width")) || box?.[2] || 800;
  const height = Number(svg.getAttribute("height")) || box?.[3] || 600;
  return { html: new XMLSerializer().serializeToString(svg), width, height };
}

const DECLARES = /^\s*[+\-~.]?(node|group|edge|legend|note|layout|order|align|near|nudge|pin|stay|size|state|phase|diagram|subtitle|theme|theme-color|routing|config|compare)\b/;
// The id a statement declares (`node api …`, `edge send api -> db`), or the scope it refines (`layout services …`).
export function statementId(line) {
  const match = line.match(/^\s*[+\-~.]?(node|group|edge|layout|near|nudge|pin|stay|size|order|align)\s+([A-Za-z_][\w.-]*)/);
  if (!match) return "";
  if (match[1] === "align") return "";
  return match[2] === "root" ? "" : match[2];
}

// One span per source line, numbered by CSS, with the keyword, ids, strings, attributes and comments tinted.
export function sourceHtml(text) {
  return text.replace(/\n$/, "").split("\n").map((line, index) => {
    const id = statementId(line);
    const ends = line.match(/^\s*[+\-~.]?edge\s+\S+\s+([\w.-]+)\s*->\s*([\w.-]+)/);
    const parent = /^\s*[+\-~.]?(node|group)\s/.test(line) && line.match(/\sin=([\w.-]+)/)?.[1];
    return `<span class="draft-line" data-line="${index + 1}"${id ? ` data-id="${escapeHtml(id)}"` : ""}${ends ? ` data-ends="${escapeHtml(`${ends[1]} ${ends[2]}`)}"` : ""}${parent ? ` data-in="${escapeHtml(parent)}"` : ""}>${highlight(line) || " "}</span>`;
  }).join("");
}

function highlight(line) {
  const comment = line.match(/^\s*(#|\/\/)/);
  if (comment) return `<span class="draft-comment">${escapeHtml(line)}</span>`;
  const parts = line.split(/("(?:[^"\\]|\\.)*")/);
  return parts.map((part, index) => {
    if (index % 2) return `<span class="draft-string">${escapeHtml(part)}</span>`;
    let html = escapeHtml(part).replace(/([\w-]+)=/g, '<span class="draft-attr">$1</span>=');
    if (index === 0) html = html.replace(/^(\s*)([+\-~.]?)([a-z-]+)(\s+[A-Za-z_][\w.-]*)?/, (whole, space, mark, keyword, id = "") => DECLARES.test(`${mark}${keyword}`)
      ? `${space}${mark ? `<span class="draft-mark">${mark}</span>` : ""}<span class="draft-keyword">${keyword}</span>${id ? `<span class="draft-id">${id}</span>` : ""}`
      : whole);
    return html;
  }).join("");
}
