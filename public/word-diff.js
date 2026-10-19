// Word-level changes inside a diff, shared by the code diff view and Markdown ```diff fences.

// Each run of deletions and the additions after it are compared word by word as one block, so a reflowed paragraph
// still lines up; the changed words get `line.marks` as [start, end) offsets into that line's text.
// A line break is its own token and compares equal to a space, so a reflowed paragraph isn't a change, while
// indentation (the whitespace after a break) still compares exactly.
const TOKEN = /[\p{L}\p{N}_]+|\n|[^\S\n]+|[^\p{L}\p{N}_\s]/gu;
const tokens = (lines) => {
  const text = lines.map((line) => line.text).join("\n");
  return [...text.matchAll(TOKEN)].map((match) => ({ text: match[0] === "\n" ? " " : match[0], start: match.index, end: match.index + match[0].length }));
};

export function markWords(lines) {
  for (let index = 0; index < lines.length;) {
    if (lines[index].kind !== "del") { index++; continue; }
    const dels = [];
    const adds = [];
    while (lines[index]?.kind === "del") dels.push(lines[index++]);
    while (lines[index]?.kind === "add") adds.push(lines[index++]);
    if (adds.length) markBlock(dels, adds);
  }
}

function markBlock(dels, adds) {
  const a = tokens(dels);
  const b = tokens(adds);
  if (!a.length || !b.length || a.length * b.length > 4e6) return; // ponytail: O(n·m) LCS; huge rewrites stay line-level
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i * width + j] = a[i].text === b[j].text ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const keptA = new Uint8Array(a.length);
  const keptB = new Uint8Array(b.length);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i].text === b[j].text) { keptA[i++] = keptB[j++] = 1; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  // A mostly rewritten block reads better as plain added and removed lines than as a wall of marks.
  const kept = (list, keep) => list.reduce((sum, token, i) => sum + (keep[i] && /\S/.test(token.text) ? token.text.length : 0), 0);
  const total = (list) => list.reduce((sum, token) => sum + (/\S/.test(token.text) ? token.text.length : 0), 0);
  if (kept(a, keptA) < 0.3 * total(a) || kept(b, keptB) < 0.3 * total(b)) return;
  assignMarks(dels, a, keptA);
  assignMarks(adds, b, keptB);
}

// Marks are [start, end, kind]: "word" for changed text, "space" for changed whitespace alone (re-indentation).
function assignMarks(lines, list, keep) {
  // Whitespace between two changed words joins them, so a changed phrase reads as one mark.
  const kind = list.map((token, i) => /\S/.test(token.text) ? (keep[i] ? "" : "word")
    : i > 0 && !keep[i - 1] && /\S/.test(list[i - 1].text) && i + 1 < list.length && !keep[i + 1] && /\S/.test(list[i + 1].text) ? "word"
    : keep[i] ? "" : "space");
  let offset = 0;
  for (const line of lines) {
    const end = offset + line.text.length;
    const marks = [];
    list.forEach((token, i) => {
      if (!kind[i] || token.end <= offset || token.start >= end) return;
      const range = [Math.max(token.start, offset) - offset, Math.min(token.end, end) - offset, kind[i]];
      const last = marks[marks.length - 1];
      if (last && last[1] === range[0] && last[2] === range[2]) last[1] = range[1]; else if (range[1] > range[0]) marks.push(range);
    });
    line.marks = marks.length ? marks : null;
    offset = end + 1;
  }
}

// Wraps runs of (highlighted) line HTML in <mark class>, by text offset, closing and reopening around tags so
// nesting stays valid. classAt(offset) names the classes for each character; "" leaves it bare.
export function decorate(html, classAt) {
  let out = "";
  let at = 0;
  let open = "";
  for (let index = 0; index < html.length;) {
    if (html[index] === "<") {
      const close = html.indexOf(">", index) + 1;
      out += open ? `</mark>${html.slice(index, close)}<mark class="${open}">` : html.slice(index, close);
      index = close;
      continue;
    }
    const entity = html[index] === "&" ? html.slice(index).match(/^&#?\w+;/)?.[0] : null;
    const char = entity || html[index];
    const want = classAt(at);
    if (want !== open) { out += (open ? "</mark>" : "") + (want ? `<mark class="${want}">` : ""); open = want; }
    out += char;
    index += char.length;
    at++;
  }
  return (out + (open ? "</mark>" : "")).replace(/<mark class="[^"]*"><\/mark>/g, "");
}

// Changed lines show their indentation and trailing whitespace faintly (dots for spaces, a rule for tabs).
export function lineClasses(line, spaces = true) {
  const { text, marks } = line;
  const lead = text.length - text.trimStart().length;
  const trail = text.trimEnd().length;
  const visible = spaces && (line.kind === "add" || line.kind === "del");
  return (at) => {
    const mark = marks?.find(([start, end]) => at >= start && at < end);
    const space = visible && (at < lead || at >= trail) ? { " ": "code-sp", "\t": "code-tab" }[text[at]] : "";
    return [mark ? `code-${mark[2]}` : "", space || ""].filter(Boolean).join(" ");
  };
}
