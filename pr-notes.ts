import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Local review notes on a PR, one Markdown file per PR under plans/pr-notes/ (viewer.config.json `code.prNotesDir`). The file stays readable and hand-editable
// (an agent flips `status: draft` to `status: posted`); anything that doesn't parse as a note is kept verbatim.
// A note on the whole file has line 0 and a "whole file" heading. `sig` is the viewer's hash of the file's diff when the note was
// written, so the viewer can tell the file changed since (a quote can't, for a whole-file note).
export type Note = { id: string; file: string; side: "old" | "new"; line: number; end: number; commit: string; sig: string; status: string; at: string; quote: string; body: string };
type Entry = Note | { raw: string };

const HEAD = /^### `(.+)` · (?:(old|new) lines? (\d+)(?:–(\d+))?|whole file)$/;
const META = /^- id: (\w+) · status: (\w+) · at: (.+?)(?: · commit: ([0-9a-f]{7,40}))?(?: · sig: ([0-9a-z]{1,16}))?$/;

export function parseNotes(text: string) {
  const [preamble, ...chunks] = text.split(/^(?=### `)/m);
  const entries: Entry[] = chunks.map((chunk) => {
    const lines = chunk.replace(/\s+$/, "").split("\n");
    const head = HEAD.exec(lines[0]);
    const meta = META.exec(lines[1] || "");
    if (!head || !meta) return { raw: chunk };
    let index = 2;
    while (lines[index] === "") index++;
    const quote: string[] = [];
    while (lines[index]?.startsWith(">")) quote.push(lines[index++].replace(/^> ?/, ""));
    const line = Number(head[3] || 0);
    return { id: meta[1], file: head[1], side: (head[2] || "new") as Note["side"], line, end: head[4] ? Number(head[4]) : line, commit: meta[4] || "", sig: meta[5] || "", status: meta[2], at: meta[3], quote: quote.join("\n"), body: lines.slice(index).join("\n").trim() };
  });
  return { preamble, entries };
}

export function formatNote(note: Note) {
  const range = !note.line ? "whole file" : `${note.side} ${note.end > note.line ? `lines ${note.line}–${note.end}` : `line ${note.line}`}`;
  const quote = note.quote ? `${note.quote.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n` : "";
  return `### \`${note.file}\` · ${range}\n- id: ${note.id} · status: ${note.status} · at: ${note.at}${note.commit ? ` · commit: ${note.commit}` : ""}${note.sig ? ` · sig: ${note.sig}` : ""}\n\n${quote}${note.body}\n\n`;
}

const isNote = (entry: Entry): entry is Note => !("raw" in entry);
const format = (preamble: string, entries: Entry[]) => `${preamble.replace(/\s+$/, "")}\n\n${entries.map((entry) => (isNote(entry) ? formatNote(entry) : `${entry.raw.replace(/\s+$/, "")}\n\n`)).join("")}`.replace(/\n+$/, "\n");

const localStamp = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

export function createPrNotes(root: string, dir = "plans/pr-notes") {
  const relative = (slug: string, number: number) => `${dir}/${slug.replace("/", "-")}-${number}.md`;
  const load = async (slug: string, number: number) => parseNotes(await readFile(join(root, relative(slug, number)), "utf8").catch(() => ""));

  async function list(slug: string, number: number) {
    const { entries } = await load(slug, number);
    return { path: relative(slug, number), notes: entries.filter(isNote) };
  }

  // `delete` with `ids` removes several notes at once (Clear stale); ids already gone are skipped.
  type Change = { op: "add" | "update" | "delete"; id?: string; ids?: string[]; title?: string; note?: Partial<Note> };
  async function change(slug: string, number: number, { op, id, ids, title, note = {} }: Change) {
    let { preamble, entries } = await load(slug, number);
    if (op === "add") {
      const file = String(note.file || "");
      const line = Number(note.line);
      if (!file || file.includes("`") || !Number.isInteger(line) || line < 0) throw new Error("A note needs a file and a line (0 for the whole file).");
      if (!String(note.body || "").trim()) throw new Error("A note needs some text.");
      if (!preamble.trim()) preamble = `# Review notes for ${slug}#${number}\n\n[${title || `Pull request ${number}`}](https://github.com/${slug}/pull/${number}). Local notes from the Code view: drafts stay here until an agent posts them as a GitHub review.\n`;
      entries.push({
        id: Math.random().toString(36).slice(2, 8), file, side: note.side === "old" ? "old" : "new", line, end: Math.max(line, Number(note.end) || line),
        commit: /^[0-9a-f]{7,40}$/.test(String(note.commit || "")) ? String(note.commit) : "", sig: /^[0-9a-z]{1,16}$/.test(String(note.sig || "")) ? String(note.sig) : "", status: "draft",
        at: localStamp(), quote: String(note.quote || "").replace(/\r/g, "").slice(0, 600), body: String(note.body).replace(/\r/g, "").trim(),
      });
    } else if (op === "delete" && ids) {
      const gone = new Set(ids);
      entries = entries.filter((entry) => !(isNote(entry) && gone.has(entry.id)));
    } else {
      const target = entries.find((entry) => isNote(entry) && entry.id === id) as Note | undefined;
      if (!target) throw new Error("That note is gone; reload the overlay.");
      if (op === "delete") entries = entries.filter((entry) => entry !== target);
      else if (String(note.body || "").trim()) target.body = String(note.body).replace(/\r/g, "").trim();
    }
    const path = join(root, relative(slug, number));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, format(preamble, entries));
    return list(slug, number);
  }

  // The draft notes as Markdown, for an agent prompt; the absolute path lets the agent mark them posted.
  async function drafts(slug: string, number: number) {
    const { notes } = await list(slug, number);
    return { path: join(root, relative(slug, number)), text: notes.filter((note) => note.status === "draft").map(formatNote).join("").trim() };
  }

  return { list, change, drafts };
}
