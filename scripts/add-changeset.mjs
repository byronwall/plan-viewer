// Writes a changeset for the planboard package without the interactive prompt.
// Usage: npm run changeset:add <patch|minor|major> "What changed, for package users"
import { existsSync, writeFileSync } from "node:fs";

const [bump, ...words] = process.argv.slice(2);
const summary = words.join(" ").trim();
if (!["patch", "minor", "major"].includes(bump) || !summary) {
  console.error('Usage: npm run changeset:add <patch|minor|major> "What changed, for package users"');
  process.exit(1);
}

const slug = summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/, "") || "change";
let path = `.changeset/${slug}.md`;
for (let n = 2; existsSync(path); n++) path = `.changeset/${slug}-${n}.md`;

writeFileSync(path, `---\n"planboard": ${bump}\n---\n\n${summary}\n`);
console.log(`Wrote ${path}`);
