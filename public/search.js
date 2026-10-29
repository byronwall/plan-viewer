// The pieces of `term` found in order in `text` (both lowercase), taking the longest piece at each step, and how many
// characters of the term were not found at all: "sweepf" in "sweep-findings" is ["sweep", "f"] with none skipped.
export function fuzzyChunks(term, text) {
  const chunks = [];
  let cursor = 0, skipped = 0;
  for (let i = 0; i < term.length;) {
    let length = term.length - i, at = -1;
    for (; length > 0; length--) if ((at = text.indexOf(term.slice(i, i + length), cursor)) >= 0) break;
    if (!length) { skipped++; i++; continue; }
    chunks.push(term.slice(i, i + length));
    cursor = at + length;
    i += length;
  }
  return { chunks, skipped };
}

// How well one lowercase term matches lowercase text: 1 when it appears as typed; otherwise, for terms of four or more
// characters, its characters in order in runs averaging 2.5 characters or more, allowing one typo'd character in five,
// scored below 1 by each break and skip; 0 when it does not match.
export function termMatch(term, text) {
  if (text.includes(term)) return 1;
  if (term.length < 4) return 0;
  const { chunks, skipped } = fuzzyChunks(term, text);
  if (skipped > Math.floor(term.length / 5) || 2 * (term.length - skipped) < 5 * chunks.length) return 0;
  return (term.length - skipped - chunks.length + 1) / term.length;
}

// Search the document index without changing the rail or the Tasks view.
export function searchDocuments(documents, query) {
  const normalized = query.trim().toLowerCase();
  const terms = normalized.split(/\s+/).filter(Boolean);
  if (!terms.length) return [...documents];
  return documents.map((doc, index) => {
    const title = doc.title.toLowerCase();
    const path = doc.path.toLowerCase();
    const task = doc.task;
    const text = `${title} ${path} ${doc.kind || ""} ${task?.id || ""} ${task?.title || ""} ${task?.summary || ""} ${task?.project || ""} ${task?.status || ""} ${(task?.tags || []).join(" ")}`.toLowerCase();
    if (!terms.every(term => termMatch(term, text))) return null;
    const score = (title === normalized ? 100 : title.startsWith(normalized) ? 50 : title.includes(normalized) ? 25 : 0)
      + terms.reduce((sum, term) => sum + (title.includes(term) ? 10 : path.includes(term) ? 5 : 1 + 4 * termMatch(term, title)), 0);
    return { doc, index, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index).map(result => result.doc);
}

// "1938", "#1938" or "<repo>#27" finds pull requests by number: exact first, then open, then newest; digits match as a
// prefix. Any other query of three or more characters matches every term against title, branch, author and repository.
export function searchPrs(prs, query) {
  const text = query.trim();
  const match = text.match(/^(?:([a-z][\w.-]*)\s*)?#?(\d+)$/i);
  if (match) {
    const [, repo, digits] = match;
    const exact = (pr) => String(pr.number) === digits;
    return prs
      .filter((pr) => String(pr.number).startsWith(digits) && (!repo || pr.slug.split("/")[1].toLowerCase() === repo.toLowerCase()))
      .sort((a, b) => exact(b) - exact(a) || (b.state === "OPEN") - (a.state === "OPEN") || b.number - a.number)
      .slice(0, 8);
  }
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (text.length < 3) return [];
  return prs
    .filter((pr) => { const haystack = `${pr.title} ${pr.branch} ${pr.author} ${pr.slug.split("/")[1]}`.toLowerCase(); return terms.every((term) => termMatch(term, haystack)); })
    .sort((a, b) => (b.state === "OPEN") - (a.state === "OPEN") || b.number - a.number)
    .slice(0, 6);
}

// ⌘K ranking. How well the terms match: an exact ID wins, then the whole query in the title, then each term at the
// start of a title word, inside the title, fuzzily in the title (scaled by how much of it ran together), or only in the
// other text. 0 means some term did not match at all, even fuzzily.
export function textScore(terms, title, rest = "", id = "") {
  const heading = title.toLowerCase();
  const all = `${id} ${heading} ${rest}`.toLowerCase();
  if (!terms.length || !terms.every((term) => termMatch(term, all))) return 0;
  const query = terms.join(" ");
  const whole = id.toLowerCase() === query ? 60 : heading === query ? 40 : heading.startsWith(query) ? 20 : heading.includes(query) ? 10 : 0;
  return whole + terms.reduce((sum, term) => sum + (new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(heading) ? 10 : heading.includes(term) ? 6
    : Math.max(5 * termMatch(term, heading), 2 * termMatch(term, all))), 0);
}

// Then context: live work rises, finished work sinks, recent edits rise (half-life about ten days), and yours rises.
export function contextScore({ live = false, done = false, updated, mine = false }, now = Date.now()) {
  const at = typeof updated === "number" ? updated : Date.parse(updated || "");
  const recency = Number.isNaN(at) ? 0 : 12 * Math.exp(-Math.max(0, now - at) / 864e5 / 14);
  return (live ? 8 : 0) - (done ? 10 : 0) + recency + (mine ? 6 : 0);
}
