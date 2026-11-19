// Every viewer button that would start an agent chat saves an Up next note by default (public/note-popover.js); the
// launch itself is only the popover's quiet `send` button. These checks read the client source, the way pages.test.js
// does, so a new button that calls a launch route directly fails here instead of quietly starting a chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`./public/${file}`, import.meta.url), "utf8");

// Each launch call that isn't a copy (`copy: true`, or `true` as requestDraft's copy argument) must sit in a send.run.
const LAUNCHES = [
  ["code.js", /post\("(?:agent|session|cleanup-agent)", \{[^}]*\}\)/g],
  ["issues.js", /requestDraft\((?:[^()]|\([^()]*\))*\)/g],
  ["plans.js", /planRequest\("plan-agent"(?:[^()]|\([^()]*\))*\)/g],
  ["app.js", /"\/api\/steps\/start"/g],
  ["setup-page.js", /setupAgent\(\{[^}]*\}\)/g],
];
const isCopy = (call) => /copy: true|, true\)$|, true, /.test(call) || /\(\s*skill,\s*keys,\s*copy/.test(call);

test("launch routes are called only from a note popover's send button, or to copy a prompt", () => {
  for (const [file, pattern] of LAUNCHES) {
    const source = read(file);
    const calls = [...source.matchAll(pattern)].filter(([call]) => !isCopy(call));
    assert.ok(calls.length > 0, `found ${file}'s launch call`);
    for (const { 0: call, index } of calls) {
      const statement = source.slice(source.lastIndexOf("\n", source.lastIndexOf("run: async", index)), index);
      assert.ok(source.lastIndexOf("run: async", index) > source.lastIndexOf("\n}\n", index) && !statement.includes("\n\n"), `${file}: ${call} runs outside a popover's send.run`);
    }
  }
});

test("the note popover saves on Enter and launches only on ⌘Enter or its quiet button", () => {
  const source = read("note-popover.js");
  assert.match(source, /act\(\(event\.metaKey \|\| event\.ctrlKey\) && current\?\.send \? "send" : "save"\)/);
  assert.match(source, /addEventListener\("submit", \(event\) => \{ event\.preventDefault\(\); act\("save"\); \}\)/);
  assert.match(source, /class="note-pop-save">Save note<\/button>/);
  // The clipboard icon copies; only the quiet send button launches (dataset keys are camelCase: data-note-copy → noteCopy).
  assert.match(source, /data-note-copy /);
  assert.match(source, /act\("noteCopy" in button\.dataset \? "copy" : "send", button\)/);
});

test("the composer, diagram ask box, Slack composer and Stacks moves save a note on Enter", () => {
  const app = read("app.js"), slack = read("slack.js"), code = read("code.js");
  assert.match(app, /askAboutDiagram\(false, event\.metaKey \|\| event\.ctrlKey\)/, "the diagram ask box opens a draft only with ⌘Enter");
  assert.match(app, /note: !copy && !open/, "the diagram ask box saves a note by default");
  assert.match(slack, /dialog\.addEventListener\("submit", \(event\) => \{ event\.preventDefault\(\); discuss\(\); \}\)/);
  assert.match(slack, /if \(open\) await requestDiscuss\(box\.value\);/, "the Slack composer opens a draft only when asked to");
  assert.match(code, /const kind = event\.metaKey \|\| event\.ctrlKey \? "draft" : "note";/, "Stacks moves save a note on Enter");
});
