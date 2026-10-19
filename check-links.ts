// Link hygiene for planning documents: `npm run links -- [--fix] [--warm] [--refresh-slack]`.
//   default  report broken repository links, unknown TASK IDs (minus reference/retired-tasks.md) and Slack channels without a name
//   --fix    add newly linked Slack channel IDs to reference/slack-channels.md as blank entries to fill in
//   --warm   prefetch GitHub/Linear/Jira/Slack titles into the viewer cache and list references that resolve to nothing
//   --refresh-slack  refresh listed and linked Slack channel names using SLACK_TOKEN or config.toml
// Exits 1 when a broken link or unknown task remains, so agents can run it as a final check.
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLinkMetadataStore, refreshSlackChannels } from "./link-metadata.ts";
import { listDocuments, repositoryLinkPath, ROOT } from "./server.ts";
import { metadataKey } from "./public/dock.js";
import { slashListItems } from "./public/markdown.js";
import { githubSlug, referenceConfig } from "./public/config.js";

const args = new Set(process.argv.slice(2));
const CHANNELS = join(ROOT, "reference", "slack-channels.md");
const exists = (path: string) => access(join(ROOT, path)).then(() => true, () => false);
const stripCode = (text: string) => text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");

// IDs removed on purpose (reference/retired-tasks.md) may still be mentioned historically.
const retired = new Set([...(await readFile(join(ROOT, "reference", "retired-tasks.md"), "utf8").catch(() => "")).matchAll(/^[-*]\s+TASK-(\d{4})\b/gm)].map(([, id]) => id));
const docs = await listDocuments();
const files = await Promise.all(docs.map(async (doc) => ({ path: doc.path, text: await readFile(join(ROOT, doc.path), "utf8") })));
const errors: string[] = [];
const notes: string[] = [];

// Repository links and task IDs must point at files that exist.
for (const { path, text } of files) {
  const prose = stripCode(text);
  for (const [, target] of prose.matchAll(/\]\(([^)\s#]+)/g)) {
    if (target.startsWith("/")) continue;
    const resolved = repositoryLinkPath(path, target);
    if (!/^(daily|tasks|plans|reference)\//.test(resolved) || await exists(resolved)) continue;
    // Missing planning documents and assets are broken; other files are usually code in another repository.
    if (/\.(md|txt|png|jpe?g|gif|webp|svg|dot)$/i.test(resolved)) errors.push(`${path}: link to missing ${resolved}`);
    else notes.push(`${path}: ${target} is not in this repository; link it with an absolute path or a GitHub URL`);
  }
  const taskIds = [...prose.matchAll(/(?<![\w/-])TASK-(\d{4})((?:\/#?\d+)*)(?![\w-]|\.\w)/gi)].flatMap(([, id, rest]) => [id, ...slashListItems(rest).map((n) => n.padStart(4, "0"))]);
  for (const id of new Set(taskIds)) {
    if (!retired.has(id) && !await exists(`tasks/TASK-${id}.md`)) errors.push(`${path}: TASK-${id} has no tasks/TASK-${id}.md`);
  }
}

// Task assets need an existing parent task, and each top-level entry must be linked from that task
// or from a document in the same assets folder (so the parent stays the entry point).
for (const folder of (await readdir(join(ROOT, "tasks"))).filter((name) => /^TASK-\d{4}-assets$/.test(name))) {
  const id = folder.slice(0, 9);
  const parent = files.find((file) => file.path === `tasks/${id}.md`);
  if (!parent) { errors.push(`tasks/${folder}: no parent tasks/${id}.md; move the assets or restore the task`); continue; }
  const siblings = files.filter((file) => file.path.startsWith(`tasks/${folder}/`));
  for (const entry of await readdir(join(ROOT, "tasks", folder))) {
    if (entry.startsWith(".")) continue;
    const names = [entry, encodeURI(entry)];
    const linked = names.some((name) => parent.text.includes(`${folder}/${name}`) || siblings.some((file) => file.path !== `tasks/${folder}/${entry}` && file.text.includes(name)));
    if (!linked) errors.push(`tasks/${folder}/${entry}: not linked from tasks/${id}.md or a document beside it`);
  }
}

// Every linked Slack channel needs a name in reference/slack-channels.md (DMs are labelled automatically).
let channelText = await readFile(CHANNELS, "utf8").catch(() => "");
const linked = new Map<string, number>();
for (const { text } of files) for (const [, id] of text.matchAll(/slack\.com\/archives\/([CG][A-Z0-9]{8,})/g)) linked.set(id, (linked.get(id) || 0) + 1);
if (args.has("--refresh-slack")) {
  try {
    const refreshed = await refreshSlackChannels(ROOT, channelText, [...linked.keys()]);
    await writeFile(CHANNELS, refreshed);
    channelText = refreshed;
    notes.push("Refreshed Slack channel names in reference/slack-channels.md.");
  } catch (error) {
    errors.push(`Slack channel refresh failed; existing names preserved: ${error instanceof Error ? error.message : "lookup failed"}`);
  }
}
const listed = new Map([...channelText.matchAll(/^[-*][ \t]*`?([CG][A-Z0-9]{8,})`?[ \t]*:[ \t]*(#[\w.-]+)?/gm)].map(([, id, name]) => [id, name || ""]));
const unlisted = [...linked.keys()].filter((id) => !listed.has(id));
if (unlisted.length && args.has("--fix")) {
  await writeFile(CHANNELS, `${channelText.trimEnd()}\n${unlisted.map((id) => `- ${id}:`).join("\n")}\n`);
  notes.push(`Added ${unlisted.length} Slack channel ID(s) to reference/slack-channels.md; fill in their #names.`);
} else if (unlisted.length) {
  notes.push(`Slack channels missing from reference/slack-channels.md (run with --fix): ${unlisted.join(", ")}`);
}
const unnamed = [...linked.keys()].filter((id) => listed.has(id) && !listed.get(id));
if (unnamed.length) notes.push(`Slack channels without a #name (${unnamed.length}): ${unnamed.sort((a, b) => linked.get(b)! - linked.get(a)!).map((id) => `${id} (${linked.get(id)} links)`).join(", ")}`);

// Warm the same cache the viewer reads, and surface references the source systems don't recognise.
if (args.has("--warm")) {
  // Same conventions the viewer auto-links, from viewer.config.json: bare #1234 is the default repo, <repo>#1234 a named one, <PREFIX>-1 a tracker.
  const refs = referenceConfig();
  const bare = (text: string) => [
    ...(refs.defaultSlug ? [...text.matchAll(/(?:^|[^\w&/#])#(\d{3,})\b/g)].map(([, n]) => `github:${refs.defaultSlug}#${n}`) : []),
    ...[...text.matchAll(new RegExp(`(?:^|[^\\w/-])${refs.ownerPattern}(${refs.repoNames})#(\\d+)\\b`, "gi"))].map(([, repo, n]) => `github:${githubSlug(refs.repos[repo.toLowerCase()])}#${n}`),
    ...refs.trackers.flatMap((tracker) => [...text.matchAll(new RegExp(`(?<![\\w/-])${tracker.prefix}-(\\d+)(?![\\w-]|\\.\\w)`, "g"))].map(([, n]) => `${tracker.service}:${tracker.prefix}-${n}`)),
  ];
  const keys = [...new Set(files.flatMap(({ text }) => [...[...text.matchAll(/https:\/\/[^\s)>\]"'`]+/g)].map(([href]) => metadataKey(href)), ...bare(stripCode(text).replace(/\[[^\]]*\]\([^)]*\)/g, "").replace(/`[^`\n]*`/g, ""))]).filter(Boolean))];
  const found = await createLinkMetadataStore(ROOT)(keys);
  const missing = keys.filter((key) => !found[key] && !key.startsWith("slack:"));
  notes.push(`Link metadata cached for ${Object.keys(found).length} of ${keys.length} external references.`);
  const strayPulls = refs.defaultSlug ? missing.filter((key) => key.startsWith(`github:${refs.defaultSlug}#`)) : [];
  if (strayPulls.length) notes.push(`Bare #numbers with no ${refs.defaultRepo} PR (write other repositories as <repo>#1234): ${strayPulls.map((key) => key.split("#")[1]).join(", ")}`);
  const others = missing.filter((key) => !strayPulls.includes(key));
  if (others.length) notes.push(`Unresolved (typo, no access, or deleted): ${others.join(", ")}`);
}

for (const line of errors) console.log(`error  ${line}`);
for (const line of notes) console.log(`note   ${line}`);
if (!errors.length) console.log(`ok     ${files.length} documents, no broken repository links or unknown tasks`);
process.exit(errors.length ? 1 : 0);
