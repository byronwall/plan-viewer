// Where a local PR note sits in the diff as it is now. A line note carries the code it quoted, so it stays put while
// that code is still on its lines, follows the code when it moved (the nearest match wins), is edited when at least half
// of the quoted lines survive in one place, and is outdated once the code is gone from the diff. A whole-file note can
// only compare the file diff's hash (`sig`) with the one it was written against. Pure; code.js owns rendering.
const clean = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);

// `lines` are a file's parsed diff lines ({ kind, text, old, new }); `sig` is that diff's hash now.
// Returns { state: "current" | "moved" | "edited" | "outdated" | "changed", line, end } with the line range to show the note at.
export function anchorNote(note, lines, sig) {
  const here = { state: "current", line: note.line, end: note.end };
  if (note.sig && note.sig === sig) return here;
  if (!note.line) return note.sig ? { ...here, state: "changed" } : here;
  const quote = clean(note.quote || "");
  if (!quote.length) return here;
  const side = lines.filter((line) => line[note.side] != null && line.text.trim()).map((line) => ({ at: line[note.side], text: line.text.trim() }));
  const wanted = quote.join("\n");
  const quoted = new Set(quote);
  const nearest = (a, b) => (Math.abs(b.line - note.line) < Math.abs(a.line - note.line) ? b : a);
  const matches = [];
  let partial = null;
  for (let index = 0; index < side.length; index++) {
    const window = side.slice(index, index + quote.length);
    const place = { line: window[0].at, end: window.at(-1).at, kept: window.filter((line) => quoted.has(line.text)).length };
    if (window.length === quote.length && window.map((line) => line.text).join("\n").includes(wanted)) matches.push(place);
    else if (!partial || place.kept > partial.kept || (place.kept === partial.kept && nearest(partial, place) === place)) partial = place;
  }
  if (matches.length) {
    const best = matches.reduce(nearest);
    return best.line === note.line ? here : { state: "moved", line: best.line, end: best.end };
  }
  return partial && partial.kept * 2 >= quote.length ? { state: "edited", line: partial.line, end: partial.end } : { ...here, state: "outdated" };
}
