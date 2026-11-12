import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setConfig } from "./public/config.js";
import { approveOutbound, dropOutbound, listOutbound, outboundBody, outboundFields, outboundHash, sendBackOutbound, setOutboundFields, stripFrontMatter } from "./outbound.ts";

const DRAFT = `---
outbound: jira-comment
target: ABC-1
status: ready
step: TASK-0001 W1
send: comment
---

# Comment on ABC-1

Notes for the reader.

<!-- jira:start -->
Hello [there](https://example.com).
<!-- jira:end -->
`;

async function workspace(t: test.TestContext, text = DRAFT) {
  const root = await mkdtemp(join(tmpdir(), "outbound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tasks/TASK-0001-assets"), { recursive: true });
  await writeFile(join(root, "tasks/TASK-0001-assets/comment.md"), text);
  return root;
}

test("outbound fields, body and hash: notes outside the markers don't change the hash", () => {
  assert.deepEqual(outboundFields(DRAFT), { outbound: "jira-comment", target: "ABC-1", status: "ready", step: "TASK-0001 W1", send: "comment" });
  assert.equal(outboundBody(DRAFT), "Hello [there](https://example.com).");
  assert.equal(outboundHash(DRAFT), outboundHash(DRAFT.replace("Notes for the reader.", "Other notes.")));
  assert.notEqual(outboundHash(DRAFT), outboundHash(DRAFT.replace("Hello", "Hi")));
  assert.notEqual(outboundHash(DRAFT), outboundHash(DRAFT.replace("send: comment", "send: other")));
  // Mirrors the sha() of the workspace's outbound.py for the same text.
  assert.equal(outboundHash("---\noutbound: jira-comment\nsend: comment\n---\n\n# T\n\n<!-- jira:start -->\nHello [x](https://example.com).\n<!-- jira:end -->\n"), "caf2e4f10986");
  assert.equal(outboundFields(setOutboundFields(DRAFT, { status: "sent", send: null })).send, undefined);
});

test("a draft's page renders its notes, with the outgoing text left to the panel", () => {
  const notes = stripFrontMatter(DRAFT);
  assert.match(notes, /^## Notes\n/);
  assert.doesNotMatch(notes, /Hello|jira:start|^# /m);
  assert.equal(stripFrontMatter("# Plain\n\nNo front matter."), "# Plain\n\nNo front matter.");
});

test("Approve and send runs the configured sender only on the text that was read", async (t) => {
  const root = await workspace(t);
  const path = "tasks/TASK-0001-assets/comment.md";
  const file = join(root, path);
  const sha = outboundHash(DRAFT);
  setConfig({ outbound: { send: [process.execPath, "-e", `const fs=require("fs");const f=${JSON.stringify(file)};fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace("status: approved","status: sent\\nresult: https://example.com/c/1"));console.log(process.argv[1])`, "{sha}"] } });
  t.after(() => setConfig({}));

  const stale = await approveOutbound(root, path, "000000000000");
  assert.equal(stale.changed, true);
  assert.equal(stale.draft.fields.status, "ready");
  assert.match(stale.draft.fields.error, /Changed since you read it/);

  const sent = await approveOutbound(root, path, sha);
  assert.equal(sent.changed, false);
  assert.equal(sent.output, sha);
  assert.equal(sent.draft.fields.status, "sent");
  assert.match(sent.draft.fields.approved, new RegExp(`sha=${sha} by=viewer$`));
  await assert.rejects(approveOutbound(root, path, sha), /is sent/);
});

test("a failing sender leaves the draft failed with its error, ready for Retry", async (t) => {
  const root = await workspace(t);
  setConfig({ outbound: { send: [process.execPath, "-e", "console.error('jira said no'); process.exit(1)"] } });
  t.after(() => setConfig({}));
  const result = await approveOutbound(root, "tasks/TASK-0001-assets/comment.md", outboundHash(DRAFT));
  assert.equal(result.draft.fields.status, "failed");
  assert.equal(result.draft.fields.error, "jira said no");
});

test("Send back keeps the feedback outside the markers; Drop and manual drafts", async (t) => {
  const root = await workspace(t);
  const path = "tasks/TASK-0001-assets/comment.md";
  setConfig({ user: "Pat" });
  t.after(() => setConfig({}));
  await assert.rejects(sendBackOutbound(root, path, "  "), /Write what should change/);
  const back = await sendBackOutbound(root, path, "Shorter, please.");
  assert.equal(back.started, false);
  assert.equal(back.draft.fields.status, "revise");
  const text = await readFile(join(root, path), "utf8");
  assert.match(text, /\n## Pat's feedback, \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\nShorter, please\.\n$/);
  assert.equal(outboundHash(text), outboundHash(DRAFT.replace("status: ready", "status: revise")));
  assert.equal((await dropOutbound(root, path)).draft.fields.status, "dropped");
  assert.deepEqual((await listOutbound(root)).map((draft) => [draft.path, draft.title]), [[path, "Comment on ABC-1"]]);
  await writeFile(join(root, path), DRAFT.replace("send: comment", "send: manual"));
  setConfig({ outbound: { send: ["true"] } });
  await assert.rejects(approveOutbound(root, path, outboundHash(DRAFT.replace("send: comment", "send: manual"))), /sent by hand/);
  await assert.rejects(approveOutbound(root, "tasks/../secret.md", "x"), /Not an outbound draft path/);
});
