// The Setup page (`?view=setup`): what the viewer can use, whether it works, and a prompt that has an agent set up
// what is missing. The viewer only checks and drafts; sign-ins and tokens stay with the tools and the agent.
//
// Integrations are probed live with cheap commands (`gh auth status`, `acli jira auth status`, one Linear query).
// Settings are every key in DEFAULT_CONFIG, with the meaning from docs/configuration.md; scalar keys can be written
// back to config/viewer.json one at a time.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configValue } from "./link-metadata.ts";
import { linearClient } from "./linear.ts";
import { DEFAULT_CONFIG } from "./public/config.js";
import { CONFIG_DIR, CONFIG_FILE, configPath } from "./public/layout.js";

const VIEWER = fileURLToPath(new URL(".", import.meta.url));
export const CONFIG_DOC = join(VIEWER, "docs", "configuration.md");

export type Run = (command: string, args: string[]) => Promise<{ code: number; out: string }>;
export type Deps = { run: Run; env: Record<string, string | undefined>; linear: (root: string) => Promise<string>; exists: (path: string) => boolean };

// Runs a probe with a short timeout; a missing command is code 127, like a shell.
const run: Run = (command, args) => new Promise((done) => {
  execFile(command, args, { timeout: 6000 }, (error: any, stdout, stderr) => {
    done({ code: error ? (error.code === "ENOENT" ? 127 : typeof error.code === "number" ? error.code : 1) : 0, out: `${stdout}${stderr}`.trim() });
  });
});

const DEPS: Deps = {
  run,
  env: process.env,
  linear: async (root) => (await linearClient(root)("query { viewer { name } }", {})).viewer.name,
  exists: existsSync,
};

// ok: works. missing: something uses it and it does not work. unused: nothing configured needs it.
export type State = "ok" | "missing" | "unused";
export type Integration = { id: string; label: string; state: State; detail: string; enables: string; docs: string; how: string; check: string };

const firstLine = (text: string) => text.split("\n").map((line) => line.trim()).find(Boolean) || "";

export async function probeIntegrations(root: string, cfg: any, deps: Deps = DEPS): Promise<Integration[]> {
  const trackers = (service: string) => cfg.trackers.some((tracker: any) => tracker.service === service);
  const secret = async (env: string, section: string, key: string) => deps.env[env] ? `${env}` : (await configValue(root, section, key)) ? `config.toml [${section}] ${key}` : "";
  const probes: Record<string, () => Promise<Omit<Integration, "id" | "label" | "enables" | "docs" | "how" | "check">>> = {
    github: async () => {
      const result = await deps.run("gh", ["auth", "status"]);
      const account = result.out.match(/account (\S+)/)?.[1] || result.out.match(/Logged in to \S+ as (\S+)/)?.[1] || "";
      if (result.code === 0) return { state: "ok", detail: account ? `Signed in as ${account}` : "Signed in" };
      return { state: "missing", detail: result.code === 127 ? "gh is not installed" : "gh is not signed in" };
    },
    jira: async () => {
      const used = Boolean(cfg.issues.jql) || trackers("jira");
      const [command, ...args] = cfg.issues.command;
      const result = await deps.run(command, [...args, "jira", "auth", "status"]);
      if (result.code === 0) return { state: "ok", detail: firstLine(result.out) || "Signed in" };
      // Named by the tool, not its runner: `["node", "fake-acli.js"]` is still acli.
      const name = (args.at(-1) || command).split("/").pop().replace(/^fake-|\.js$/g, "");
      const why = result.code === 127 ? `${name} is not installed` : `${name} is not signed in to Jira`;
      return used ? { state: "missing", detail: why } : { state: "unused", detail: `No Jira tracker or issues.jql · ${why}` };
    },
    linear: async () => {
      const used = trackers("linear") || cfg.issues.linear.teams.length > 0;
      const where = await secret("LINEAR_API_KEY", "linear", "API_KEY");
      if (!where) return used ? { state: "missing", detail: "No Linear API key" } : { state: "unused", detail: "No Linear tracker or team" };
      try { return { state: "ok", detail: `Key in ${where} · signed in as ${await deps.linear(root)}` }; }
      catch (error) { return { state: "missing", detail: `Key in ${where} failed: ${(error as Error).message}` }; }
    },
    slack: async () => {
      const where = await secret("SLACK_TOKEN", "slack", "TOKEN");
      return where ? { state: "ok", detail: `Token in ${where}` } : { state: "unused", detail: "No Slack token" };
    },
    codex: async () => {
      if (!cfg.slack.codex.length) return { state: "unused", detail: "slack.codex is empty, so Slack links open in Slack" };
      const result = await deps.run(cfg.slack.codex[0], ["--version"]);
      return result.code === 127 ? { state: "missing", detail: `${cfg.slack.codex[0]} is not installed` } : { state: "ok", detail: firstLine(result.out) || cfg.slack.codex.join(" ") };
    },
    draftably: async () => {
      const [command, ...args] = cfg.diagrams.command;
      const result = await deps.run(command, [...args, "--version"]);
      return result.code === 127 ? { state: "unused", detail: `${command} is not installed, so .draft diagrams show as links` } : { state: "ok", detail: firstLine(result.out) || command };
    },
    agents: async () => {
      const apps = ["Codex", "Claude"].filter((app) => deps.exists(`/Applications/${app}.app`));
      return apps.length ? { state: "ok", detail: `${apps.join(" and ")} installed` } : { state: "missing", detail: "Neither Codex nor Claude is installed in /Applications" };
    },
  };
  return Promise.all(INTEGRATIONS.map(async (info) => ({ ...info, ...(await probes[info.id]()) })));
}

// What each integration turns on, the docs that cover it, and the setup an agent should do.
const INTEGRATIONS = [
  { id: "github", label: "GitHub CLI", enables: "PR and commit titles, the Code and Plans pages, CI, GitHub issues", docs: "github.owner, code.reposFile",
    how: "Install the GitHub CLI (`brew install gh`) if it is missing, then have the user run `gh auth login` themselves. Set `github.owner` and `github.defaultRepo` in config/viewer.json if they are empty.", check: "gh auth status" },
  { id: "jira", label: "Jira (acli)", enables: "Jira titles and states, the Issues page's Jira source", docs: "issues.jql, issues.command, trackers",
    how: "Install the Atlassian CLI (`acli`) if it is missing, then have the user run `acli jira auth login` themselves. Add a `jira` tracker with its URL to `trackers` and, for the Issues page, an `issues.jql` scope.", check: "acli jira auth status" },
  { id: "linear", label: "Linear", enables: "Linear titles and states, the Issues page's Linear source, Linear avatars", docs: "trackers, issues.linear.teams",
    how: "Ask the user to create a personal API key in Linear (Settings → Security & access) and to paste it into the workspace's ignored config.toml as `[linear]` `API_KEY = \"…\"` themselves. Never write or echo the key. Add a `linear` tracker and, for the Issues page, `issues.linear.teams`.", check: "the Linear row on the Setup page (Recheck)" },
  { id: "slack", label: "Slack token", enables: "Slack message and channel titles, Slack avatars", docs: "people",
    how: "Ask the user to create a Slack user token with `channels:history`, `groups:history`, `im:history`, `mpim:history`, `users:read` and `users:read.email`, and to paste it into the workspace's ignored config.toml as `[slack]` `TOKEN = \"…\"` themselves. Never write or echo the token.", check: "the Slack row on the Setup page (Recheck)" },
  { id: "codex", label: "Codex app server", enables: "Slack threads read inside the viewer, the Slack page", docs: "slack.codex, slack.people",
    how: "Install the Codex CLI if it is missing and confirm its Slack connector is signed in. Then set `slack.codex` to `[\"codex\", \"app-server\"]` in config/viewer.json.", check: "codex --version" },
  { id: "draftably", label: "draftably", enables: "Embedded .draft diagrams and the Diagrams page's pictures", docs: "diagrams.command",
    how: "Install the draftably CLI so it is on the PATH of the viewer's server, or set `diagrams.command` in config/viewer.json to its absolute path.", check: "draftably --version" },
  { id: "agents", label: "Agent apps", enables: "Every launch button that opens a Codex or Claude chat", docs: "",
    how: "Install Codex or Claude Desktop in /Applications and sign in.", check: "ls /Applications" },
];

// One row per key: top-level keys, and the keys one level inside each settings group.
export type Setting = { key: string; kind: string; value: unknown; fallback: unknown; set: boolean; meaning: string; restart: boolean };
const GROUPS = new Set(["github", "code", "issues", "diagrams", "outbound", "steps", "slack"]);
const RESTART = new Set(["port", "code.reposFile", "code.prNotesDir"]);
const kindOf = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
export const SCALAR = new Set(["string", "number", "boolean"]);
const get = (object: any, key: string) => key.split(".").reduce((value, part) => value?.[part], object);
const has = (object: any, key: string) => { const parts = key.split("."); const last = parts.pop()!; const parent = parts.reduce((value, part) => value?.[part], object); return parent !== null && typeof parent === "object" && last in parent; };

export function settingKeys() {
  return Object.entries(DEFAULT_CONFIG).flatMap(([key, value]) => GROUPS.has(key) ? Object.keys(value as object).map((inner) => `${key}.${inner}`) : [key]);
}

// The Meaning column of docs/configuration.md, by key. A row naming several keys gives each the same text.
export function settingMeanings(doc: string) {
  const out: Record<string, string> = {};
  for (const [, keys, meaning] of doc.matchAll(/^\| ((?:`[\w.]+`(?:, )?)+) \| (.+) \|$/gm)) {
    for (const [, key] of keys.matchAll(/`([\w.]+)`/g)) out[key] ||= meaning.trim();
  }
  return out;
}

export function listSettings(raw: any, cfg: any, meanings: Record<string, string>): Setting[] {
  return settingKeys().map((key) => {
    const fallback = get(DEFAULT_CONFIG, key);
    const meaning = meanings[key] || Object.entries(meanings).find(([name]) => name.startsWith(`${key}.`))?.[1] || "";
    return { key, kind: kindOf(fallback), value: get(cfg, key), fallback, set: has(raw, key), meaning, restart: RESTART.has(key) };
  });
}

export const readRawConfig = async (root: string) => JSON.parse(await readFile(join(root, CONFIG_FILE), "utf8").catch(() => "{}") || "{}");

// Writes one scalar key into config/viewer.json, or removes it (`reset`) so the default applies again. Other keys and
// their order are kept; the file is rewritten as two-space JSON.
export async function writeSetting(root: string, key: string, value: unknown, reset = false) {
  if (!settingKeys().includes(key)) throw new Error(`${key} is not a setting.`);
  const kind = kindOf(get(DEFAULT_CONFIG, key));
  if (!SCALAR.has(kind)) throw new Error(`${key} is a ${kind}; edit it in ${CONFIG_FILE} or with its helper.`);
  const raw = await readRawConfig(root);
  const parts = key.split(".");
  const last = parts.pop()!;
  if (reset) {
    const parent = parts.reduce((object, part) => object?.[part], raw);
    if (parent && typeof parent === "object") delete parent[last];
    if (parts.length && parent && !Object.keys(parent).length) delete raw[parts[0]];
  } else {
    const typed = kind === "number" ? Number(value) : kind === "boolean" ? value === true || value === "true" : String(value ?? "");
    if (kind === "number" && !Number.isFinite(typed)) throw new Error(`${key} needs a number.`);
    const parent = parts.reduce((object, part) => (object[part] ??= {}), raw);
    parent[last] = typed;
  }
  await mkdir(dirname(join(root, CONFIG_FILE)), { recursive: true });
  await writeFile(join(root, CONFIG_FILE), `${JSON.stringify(raw, null, 2)}\n`);
  return raw;
}

const docLine = `The viewer's settings are documented in ${CONFIG_DOC}.`;

// The prompt a helper hands to the agent: what is wrong, what it turns on, and how to fix it without handling secrets.
export function integrationPrompt(root: string, integration: Integration) {
  return `Set up ${integration.label} for the Plan Viewer workspace at ${root}.

Current state: ${integration.state === "ok" ? "working" : integration.state === "missing" ? "not working" : "not set up"} (${integration.detail}).
It turns on: ${integration.enables}.
${integration.docs ? `Related settings in ${CONFIG_FILE}: ${integration.docs}.\n` : ""}
What to do: ${integration.how}

${docLine} Sign-ins and tokens belong to the user: ask them to run a sign-in or paste a token themselves, and never write a token into a tracked file or repeat it back. Check the result with ${integration.check}, then tell the user to press Recheck on the viewer's Setup page.`;
}

export function settingPrompt(root: string, setting: Setting) {
  return `Configure \`${setting.key}\` in ${join(root, CONFIG_FILE)} for the Plan Viewer workspace at ${root}.

Meaning: ${setting.meaning || "see the docs"}
Current value: ${JSON.stringify(setting.value)}${setting.set ? "" : " (the default; the key is not in the file)"}

${docLine} Ask the user what they want this setting to do before you change it. Keep the file valid JSON and leave the other keys as they are.${setting.restart ? " This key is read at startup, so the viewer needs a restart afterwards." : " The viewer reloads the file by itself."}`;
}

// The files the tooling reads: config/ (not a library folder, so this page is the only place they show), the file
// `code.reposFile` and `steps.settingsFile` name, and the ignored config.toml, whose contents are never read here.
export type ConfigFile = { path: string; purpose: string; key: string; exists: boolean; modified: string; size: number; secret: boolean };

const KNOWN: Record<string, { purpose: string; key?: string }> = {
  [CONFIG_FILE]: { purpose: "Settings: everything in the Settings section above." },
  [configPath("slack-channels.md")]: { purpose: "Names for Slack channel and DM IDs in links. `plan-viewer links` reports IDs missing here." },
  [configPath("retired-tasks.md")]: { purpose: "Task IDs removed on purpose, so `plan-viewer links` stops reporting them as unknown." },
  "config.toml": { purpose: "Linear and Slack tokens (`[linear] API_KEY`, `[slack] TOKEN`). Ignored by git; the viewer never shows it." },
};

export async function listConfigFiles(root: string, cfg: any): Promise<ConfigFile[]> {
  const { [CONFIG_FILE]: settings, ...rest } = KNOWN;
  const known: Record<string, { purpose: string; key?: string }> = {
    [CONFIG_FILE]: settings,
    [cfg.code.reposFile]: { purpose: "Repositories the Code, Plans and Issues pages track. The Code page's gear menu writes it.", key: "code.reposFile" },
    ...(cfg.steps.settingsFile ? { [cfg.steps.settingsFile]: { purpose: "Claude settings that the Steps page's Apply adds allow rules to.", key: "steps.settingsFile" } } : {}),
    ...rest,
  };
  const found: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) { if (entry.name !== "prompts") await walk(`${dir}/${entry.name}`); }
      else found.push(`${dir}/${entry.name}`);
    }
  };
  await walk(CONFIG_DIR);
  const paths = [...new Set([...Object.keys(known), ...found.sort()])].sort((a, b) => Number(a === "config.toml") - Number(b === "config.toml"));
  return Promise.all(paths.map(async (path) => {
    const info = await stat(join(root, path)).catch(() => null);
    const { purpose = "Read by this workspace's own scripts, not by the viewer.", key = "" } = known[path] || {};
    return { path, purpose, key, exists: Boolean(info), modified: info ? info.mtime.toISOString() : "", size: info?.size || 0, secret: path === "config.toml" };
  }));
}

// A config file's text for the page's read-only view; only listed files, and never config.toml.
export async function readConfigFile(root: string, cfg: any, path: string) {
  const file = (await listConfigFiles(root, cfg)).find((row) => row.path === path);
  if (!file || file.secret) throw new Error(`${path} is not a config file the page shows.`);
  const absolute = resolve(root, path);
  if (relative(root, absolute).startsWith("..")) throw new Error(`${path} is outside the workspace.`);
  return { path, text: await readFile(absolute, "utf8") };
}

export function filePrompt(root: string, file: ConfigFile) {
  return `${file.exists ? "Update" : "Create"} ${file.path} in the Plan Viewer workspace at ${root}.

What it is for: ${file.purpose}${file.key ? `\nThe \`${file.key}\` setting names this file.` : ""}

${docLine} Ask the user what should change before you edit it, and keep the format the viewer reads.`;
}

export async function setupData(root: string, cfg: any, deps: Deps = DEPS) {
  const [integrations, raw, doc, files] = await Promise.all([probeIntegrations(root, cfg, deps), readRawConfig(root).catch(() => ({})), readFile(CONFIG_DOC, "utf8").catch(() => ""), listConfigFiles(root, cfg)]);
  return { file: CONFIG_FILE, integrations, settings: listSettings(raw, cfg, settingMeanings(doc)), files };
}
