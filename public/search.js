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
    if (!terms.every(term => text.includes(term))) return null;
    const score = (title === normalized ? 100 : title.startsWith(normalized) ? 50 : title.includes(normalized) ? 25 : 0)
      + terms.reduce((sum, term) => sum + (title.includes(term) ? 10 : path.includes(term) ? 5 : 1), 0);
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
    .filter((pr) => { const haystack = `${pr.title} ${pr.branch} ${pr.author} ${pr.slug.split("/")[1]}`.toLowerCase(); return terms.every((term) => haystack.includes(term)); })
    .sort((a, b) => (b.state === "OPEN") - (a.state === "OPEN") || b.number - a.number)
    .slice(0, 6);
}

// ⌘K ranking. How well the terms match: an exact ID wins, then the whole query in the title, then each term at the
// start of a title word, inside the title, or only in the other text. 0 means some term did not match at all.
export function textScore(terms, title, rest = "", id = "") {
  const heading = title.toLowerCase();
  if (!terms.length || !terms.every((term) => `${id} ${heading} ${rest}`.toLowerCase().includes(term))) return 0;
  const query = terms.join(" ");
  const whole = id.toLowerCase() === query ? 60 : heading === query ? 40 : heading.startsWith(query) ? 20 : heading.includes(query) ? 10 : 0;
  return whole + terms.reduce((sum, term) => sum + (new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(heading) ? 10 : heading.includes(term) ? 6 : 2), 0);
}

// Then context: live work rises, finished work sinks, recent edits rise (half-life about ten days), and yours rises.
export function contextScore({ live = false, done = false, updated, mine = false }, now = Date.now()) {
  const at = typeof updated === "number" ? updated : Date.parse(updated || "");
  const recency = Number.isNaN(at) ? 0 : 12 * Math.exp(-Math.max(0, now - at) / 864e5 / 14);
  return (live ? 8 : 0) - (done ? 10 : 0) + recency + (mine ? 6 : 0);
}
