# Planning workspace: agent guide

This folder is a planning workspace read by [Plan Viewer](https://github.com/byronwall/plan-viewer). Markdown here is the source of truth; the viewer only reads it. Copy this file into your own workspace and adjust it.

## Layout

```text
daily/YYYY/MM/DD/plan.md   # the day's plan
daily/YYYY/MM/DD/done.md   # what got done that day
tasks/TASK-NNNN.md         # one task per file
tasks/TASK-NNNN-assets/    # files that belong to one task
plans/<topic>/README.md    # cross-day topics; plans/README.md indexes them
reference/                 # stable reference documents
```

## Daily plans

- Start with `# Daily plan — <Month D, YYYY>`.
- List the day's tasks under `## Scheduled tasks`, one per line, linked relative to the plan: `- [TASK-0101](../../../../tasks/TASK-0101.md) — what to do on it today.`
- Day-specific work can follow as `## Milestone N — <name>` sections; the viewer shows each one as a card that can be handed to an agent.
- `done.md` lists finished work, naming each task ID it advanced.

## Tasks

Each task begins with this front matter (every field is required; `tags` is an inline list):

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
---
```

Then, in any order:

- `## Work breakdown`: nested bullets `- W1.2: Title [status] (after: W1.1)`. IDs are unique within the task; `after` lists prerequisites.
- `## Next actions`: a `###` heading per action, an optional `Work item: W1.2` line, and a fenced `prompt` block an agent can carry out on its own.
- `## Updates`: dated bullets, newest first.
- `## Chats`: links to the conversations that worked on the task.

Take the next free number for a new task's ID, and update `updated:` whenever you change a task.

## Checks

Run these after editing and fix what they report:

```bash
npm run lint    # task front matter, work breakdowns, action references
npm run links   # broken links and unknown task IDs
```

When `npm run links` names a Slack channel or DM that `reference/slack-channels.md` does not, look it up in Slack (one message of a channel shows its name; a DM shows who it is with) and add `- C…: #channel-name` or `- D…: @Person` there. Leave an entry blank rather than guessing.

Use `npm run move -- <from> <to>` to rename or move a file; it repairs every link to it. `npm run task -- TASK-0101` prints a task's context in compact form.
