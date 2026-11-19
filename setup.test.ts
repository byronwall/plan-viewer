import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DOC, integrationPrompt, listConfigFiles, probeIntegrations, readConfigFile, settingKeys, settingMeanings, writeSetting, type Deps } from "./setup.ts";
import { DEFAULT_CONFIG, setConfig } from "./public/config.js";

const deps = (codes: Record<string, number>): Deps => ({
  run: async (command) => ({ code: codes[command] ?? 0, out: codes[command] ? "" : "Logged in to github.com account ada-acme" }),
  env: {}, linear: async () => "Ada", exists: () => false,
});

test("a signed-out gh and a missing acli that a Jira tracker needs show as not working", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-"));
  const cfg = setConfig({ trackers: [{ prefix: "OPS", service: "jira", url: "https://acme.test/{id}" }] });
  const rows = await probeIntegrations(root, cfg, deps({ gh: 1, acli: 127 }));
  const by = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.deepEqual([by.github.state, by.github.detail], ["missing", "gh is not signed in"]);
  assert.deepEqual([by.jira.state, by.jira.detail], ["missing", "acli is not installed"]);
  assert.equal(by.linear.state, "unused");
  assert.equal(by.agents.state, "missing");
  // The helper never asks the agent to handle the secret itself.
  assert.match(integrationPrompt(root, by.jira), /ask them to run a sign-in or paste a token themselves/);
  const ok = await probeIntegrations(root, cfg, deps({}));
  assert.equal(ok.find((row) => row.id === "github")?.detail, "Signed in as ada-acme");
  setConfig({});
  await rm(root, { recursive: true });
});

test("a scalar edit changes only its key in config/viewer.json, and Reset removes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-"));
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/viewer.json"), JSON.stringify({ title: "Acme", github: { owner: "acme" } }));
  await writeSetting(root, "github.defaultRepo", "atlas");
  await writeSetting(root, "steps.slots", "6");
  await writeSetting(root, "issues.github", "true");
  const read = async () => JSON.parse(await readFile(join(root, "config/viewer.json"), "utf8"));
  assert.deepEqual(await read(), { title: "Acme", github: { owner: "acme", defaultRepo: "atlas" }, steps: { slots: 6 }, issues: { github: true } });
  await writeSetting(root, "steps.slots", null, true);
  assert.deepEqual(await read(), { title: "Acme", github: { owner: "acme", defaultRepo: "atlas" }, issues: { github: true } });
  await assert.rejects(writeSetting(root, "github.repos", "x"), /is a array/);
  await assert.rejects(writeSetting(root, "nope", "x"), /not a setting/);
  await rm(root, { recursive: true });
});

test("config files list what the tooling reads, and config.toml is never readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-"));
  await mkdir(join(root, "config/prompts"), { recursive: true });
  await writeFile(join(root, "config/viewer.json"), "{}");
  await writeFile(join(root, "config/sites.json"), "{}");
  await writeFile(join(root, "config/prompts/daily-plan.md"), "x");
  await writeFile(join(root, "config.toml"), '[slack]\nTOKEN = "xoxp-secret"\n');
  const cfg = setConfig({});
  const files = await listConfigFiles(root, cfg);
  assert.deepEqual(files.map((file) => [file.path, file.exists]), [["config/viewer.json", true], ["config/code-repos.json", false], ["config/slack-channels.md", false], ["config/retired-tasks.md", false], ["config/sites.json", true], ["config.toml", true]]);
  await assert.rejects(readConfigFile(root, cfg, "config.toml"), /not a config file/);
  await assert.rejects(readConfigFile(root, cfg, "../etc/passwd"), /not a config file/);
  assert.equal((await readConfigFile(root, cfg, "config/sites.json")).text, "{}");
  await rm(root, { recursive: true });
});

test("every setting has a meaning in docs/configuration.md", () => {
  const meanings = settingMeanings(readFileSync(CONFIG_DOC, "utf8"));
  const missing = settingKeys().filter((key) => !meanings[key] && !Object.keys(meanings).some((name) => name.startsWith(`${key}.`)));
  assert.deepEqual(missing, [], "document these keys in docs/configuration.md");
  assert.ok(settingKeys().length >= Object.keys(DEFAULT_CONFIG).length);
});
