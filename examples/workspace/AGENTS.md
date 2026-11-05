# Planning workspace: agent guide

This folder is a planning workspace read by [Plan Viewer](https://github.com/byronwall/plan-viewer). Markdown here is the source of truth; the viewer only reads it. Copy this file into your own workspace and adjust it.

## Layout

```text
daily/YYYY/MM/DD/plan.md   # the day's plan
tasks/TASK-NNNN.md         # one task per file
tasks/TASK-NNNN-assets/    # files that belong to one task
plans/<topic>/README.md    # cross-day topics; plans/README.md indexes them
reference/                 # stable reference documents
```

## Daily plans

- Start with `# Daily plan — <Month D, YYYY>`.
- List the day's tasks under `## Scheduled tasks`, one per line, linked relative to the plan: `- [TASK-0101](../../../../tasks/TASK-0101.md) — what to do on it today.`
- Day-specific work can follow as `## Milestone N — <name>` sections; the viewer shows each one as a card that can be handed to an agent.
- Record progress on the task itself: its `status`, and a dated bullet under `## Updates`. There is no separate done log.

## Tasks

Each task begins with this front matter (every field but `check_in` is required; `tags` is an inline list):

```yaml
---
id: TASK-0101
title: Ship workspace invites
summary: One sentence on the outcome.
status: active        # open | active | waiting | deferred | completed
project: Atlas
tags: [atlas, onboarding]
created: 2026-10-12
updated: 2026-10-21
check_in: 2026-10-28  # optional; the viewer's status menu writes it for waiting tasks
---
```

Then, in any order:

- `## Work breakdown`: nested bullets `- W1.2: Title [status] (after: W1.1)`. IDs are unique within the task; `after` lists prerequisites.
- `## Next actions`: a `###` heading per action, an optional `Work item: W1.2` line, and a fenced `prompt` block an agent can carry out on its own.
- `## Updates`: dated bullets, newest first.
- `## Chats`: links to the conversations that worked on the task.

Take the next free number for a new task's ID, and update `updated:` whenever you change a task.

## Diagrams

Draw a diagram whenever a picture explains the work faster than prose: the shape of a system, a flow, the matrix an audit runs, where something broke. They are cheap, so make them often, and keep each one to a single idea (5–30 boxes).

- Write [draftably](https://github.com/byronwall/draftably) source to `tasks/TASK-NNNN-assets/<name>.draft` and run `draftably check` on it until it is clean.
- Embed it where it is discussed, as an image: `![What it shows](TASK-NNNN-assets/<name>.draft)`. The viewer draws it live from the source, so don't export or commit a PNG for the viewer.
- Export a PNG (`draftably inspect <file> --png <out.png> --max-width 2000`) only for somewhere outside the workspace, such as a PR or Slack.

## Checks

Run these after editing and fix what they report:

```bash
npm run lint    # task front matter, work breakdowns, action references
npm run links   # broken links and unknown task IDs
```

When `npm run links` names a Slack channel or DM that `reference/slack-channels.md` does not, look it up in Slack (one message of a channel shows its name; a DM shows who it is with) and add `- C…: #channel-name` or `- D…: @Person` there. Leave an entry blank rather than guessing.

Use `npm run move -- <from> <to>` to rename or move a file; it repairs every link to it. `npm run task -- TASK-0101` prints a task's context in compact form.
