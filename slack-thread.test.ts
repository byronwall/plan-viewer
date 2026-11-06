import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlackThreads, parseSlackThread, parseSlackUsers, slackThreadRef } from "./slack-thread.ts";
import { slackMarkdown, slackReactions } from "./public/slack.js";

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
Files: plan.png (ID: F0AB, image/png, 1.3 MB), notes v2.txt (ID: F0CD, text/plain, 2 KB)
`;
  assert.deepEqual(parseSlackThread(text), [
    { author: "Ada", email: "ada@acme.test", user: "U01", ts: "1791473016.225909", text: "<@U02|Grace Hopper> can you look?\n\nSecond paragraph.", reactions: "", files: [] },
    { author: "Grace Hopper", email: "grace@acme.test", user: "U02", ts: "1791473238.675079", text: "On it.", reactions: "+1 (2)", files: ["plan.png", "notes v2.txt"] },
  ]);
});

test("Slack mrkdwn reads as the viewer's Markdown", () => {
  assert.equal(slackMarkdown("<@U02|Grace> *bold* _it_ &lt;tag&gt;"), "@Grace **bold** *it* <tag>");
  assert.equal(slackMarkdown("thanks :pray::skin-tone-2: :awesome: `:eyes:`"), "thanks 🙏🏻 :awesome: `:eyes:`");
  assert.equal(slackMarkdown("<https://acme.test/x|the doc>, <https://acme.test/y> and <mailto:a@acme.test|a@acme.test>"), "[the doc](https://acme.test/x), [acme.test/y](https://acme.test/y) and a@acme.test");
  assert.equal(slackMarkdown("• one\n    ◦ two"), "- one\n  - two");
  assert.equal(slackMarkdown("line one\nline two"), "line one\n\nline two");
});

test("reactions read as emoji and counts, custom ones by name", () => {
  assert.deepEqual(slackReactions("+1::skin-tone-2 (1), eyes (2), thankyou (3)"), [
    { name: "+1", emoji: "👍🏻", count: 1 }, { name: "eyes", emoji: "👀", count: 2 }, { name: "thankyou", emoji: ":thankyou:", count: 3 },
  ]);
});

test("a discussion draft hands the agent the thread as a file and names the documents citing it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "slack-"));
  await mkdir(join(root, "tmp"));
  await writeFile(join(root, "tmp", "slack-threads.json"), JSON.stringify({ "C0123/1791473016.225909": { channelName: "#acme-dev", fetchedAt: "2026-10-30T12:00:00.000Z", messages: [
    { author: "Ada", email: "", user: "U01", ts: "1791473016.225909", text: "Ship it?", reactions: "" },
    { author: "Grace", email: "", user: "U02", ts: "1791473238.675079", text: "Yes.", reactions: "+1 (1)" },
  ] } }));
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => logged.push(line));
  process.env.PLAN_VIEWER_DRY_RUN = "1";
  t.after(() => { delete process.env.PLAN_VIEWER_DRY_RUN; });
  const threads = createSlackThreads(root, () => []);
  await threads.discuss("codex", "https://acme.slack.com/archives/C0123/p1791473238675079?thread_ts=1791473016.225909", "Who owns the follow-up?", ["tasks/TASK-0001.md"]);
  const file = join(root, "tmp", "slack-threads", "C0123-1791473016.225909.md");
  assert.match(logged[0], /Slack thread in #acme-dev/);
  assert.match(logged[0], new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(logged[0], /`tasks\/TASK-0001\.md`/);
  assert.match(logged[0], /Who owns the follow-up\?$/);
  const transcript = await readFile(file, "utf8");
  assert.match(transcript, /## Grace · .*\n\n\[permalink\]\(https:\/\/acme\.slack\.com\/archives\/C0123\/p1791473238675079\?thread_ts=1791473016\.225909\) · reactions: \+1 \(1\)\n\nYes\./);
  await assert.rejects(threads.discuss("vim", "https://acme.slack.com/archives/C0123/p1791473016225909", "", []), /Unknown agent app/);
});

test("the directory search gives each person's email and small Slack photo", () => {
  const text = "## Users (2 results)\n### Result 1 of 2\nName: Ada\nUser ID: U01\nEmail: ada@acme.test\nProfile Pic: [Photo](https://avatars.slack-edge.com/2026-01-01/1_abc_original.jpg)\n\n---\n### Result 2 of 2\nName: Bot\nUser ID: U02\n";
  assert.deepEqual(parseSlackUsers(text), [{ name: "Ada", user: "U01", email: "ada@acme.test", avatar: "https://avatars.slack-edge.com/2026-01-01/1_abc_72.jpg" }]);
});

test("a parent with no replies drops the connector's trailing note", () => {
  const [parent] = parseSlackThread("=== THREAD PARENT MESSAGE ===\nFrom: Ada <ada@acme.test> (U01)\nTime: x\nMessage TS: 1791473016.225909\nShip it?\nReactions: white_check_mark (1)\n\nNo thread messsages");
  assert.equal(parent.text, "Ship it?");
  assert.equal(parent.reactions, "white_check_mark (1)");
});

test("forwarded messages split out of the text, with their own files line left on the message", () => {
  const [parent] = parseSlackThread("=== THREAD PARENT MESSAGE ===\nFrom: Ada <ada@acme.test> (U01)\nTime: x\nMessage TS: 1791473016.225909\nSee this\nFiles: notes.png (ID: F01, image/png, 1 KB)\nForwarded message from Bo Lin (https://acme.slack.com/archives/C01/p1791473000000001): First line\n\nSecond — use slack_read_thread or slack_read_channel to read it in context\nForwarded message from Cy (https://acme.slack.com/archives/C02/p1791473000000002): Whole\n\nNo thread messsages");
  assert.equal(parent.text, "See this");
  assert.deepEqual(parent.files, ["notes.png"]);
  assert.deepEqual(parent.forwards, [
    { author: "Bo Lin", url: "https://acme.slack.com/archives/C01/p1791473000000001", text: "First line\n\nSecond", truncated: true },
    { author: "Cy", url: "https://acme.slack.com/archives/C02/p1791473000000002", text: "Whole", truncated: false },
  ]);
});
