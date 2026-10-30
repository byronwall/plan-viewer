import test from "node:test";
import assert from "node:assert/strict";
import { parseSlackThread, slackThreadRef } from "./slack-thread.ts";
import { slackMarkdown } from "./public/slack.js";

test("a reply's permalink reads its whole thread", () => {
  assert.deepEqual(slackThreadRef("https://acme.slack.com/archives/C0123/p1791473238675079?thread_ts=1791473016.225909&cid=C0123"),
    { channel: "C0123", thread: "1791473016.225909", message: "1791473238.675079", key: "C0123/1791473016.225909" });
  assert.equal(slackThreadRef("https://acme.slack.com/archives/D9/p1791473016225909").thread, "1791473016.225909");
  assert.throws(() => slackThreadRef("https://evil.example/archives/C0123/p1791473016225909"));
});

test("the connector's thread text becomes messages", () => {
  const text = `=== THREAD PARENT MESSAGE ===
From: Ada <ada@acme.test> (U01)
Time: 2026-10-08 11:23:36 EDT
Message TS: 1791473016.225909
<@U02|Grace Hopper> can you look?

Second paragraph.

=== THREAD REPLIES (1 total) ===

--- Reply 1 of 1 ---
From: Grace Hopper <grace@acme.test> (U02)
Time: 2026-10-08 11:27:18 EDT
Message TS: 1791473238.675079
On it.
Reactions: +1 (2)
`;
  assert.deepEqual(parseSlackThread(text), [
    { author: "Ada", email: "ada@acme.test", user: "U01", ts: "1791473016.225909", text: "<@U02|Grace Hopper> can you look?\n\nSecond paragraph.", reactions: "" },
    { author: "Grace Hopper", email: "grace@acme.test", user: "U02", ts: "1791473238.675079", text: "On it.", reactions: "+1 (2)" },
  ]);
});

test("Slack mrkdwn reads as the viewer's Markdown", () => {
  assert.equal(slackMarkdown("<@U02|Grace> *bold* _it_ &lt;tag&gt;"), "@Grace **bold** *it* <tag>");
  assert.equal(slackMarkdown("<https://acme.test/x|the doc>, <https://acme.test/y> and <mailto:a@acme.test|a@acme.test>"), "[the doc](https://acme.test/x), [acme.test/y](https://acme.test/y) and a@acme.test");
  assert.equal(slackMarkdown("• one\n    ◦ two"), "- one\n  - two");
  assert.equal(slackMarkdown("line one\nline two"), "line one\n\nline two");
});
