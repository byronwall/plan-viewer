import test from "node:test";
import assert from "node:assert/strict";
import { config, referenceConfig, setConfig } from "./public/config.js";
import { inlineMarkdown } from "./public/markdown.js";

test("references follow viewer.config.json and stay plain text without it", (t) => {
  const saved = config();
  t.after(() => setConfig(saved));
  setConfig({});
  assert.equal(inlineMarkdown("#1234, Orbit#5, ATL-7, 1a2b3c4d", "plans/x.md"), "#1234, Orbit#5, ATL-7, 1a2b3c4d");
  setConfig({ github: { owner: "octo", defaultRepo: "web" }, trackers: [{ prefix: "BUG", service: "jira", url: "https://bugs.example/{id}" }], code: { prNotesDir: "notes" } });
  const html = inlineMarkdown("#1234 and BUG-9", "plans/x.md");
  assert.match(html, /href="https:\/\/github\.com\/octo\/web\/pull\/1234"/);
  assert.match(html, /href="https:\/\/bugs\.example\/BUG-9"/);
  assert.equal(referenceConfig().defaultSlug, "octo/web");
  assert.equal(config().code.reposFile, "reference/code-repos.json", "nested defaults survive a partial override");
});
