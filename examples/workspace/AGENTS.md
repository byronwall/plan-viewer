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

- `## Work breakdown`: nested bullets `- W1.2: Title [status] (after: W1.1)`. IDs are unique within the task; `after` lists prerequisites. A trailing `{next}` (alone or beside the kind and size) marks a step Up next: when asked to process what's next, run `plan-viewer next`, work through those steps in order, and remove `next` once a step is done or handed to its own session. The same command lists open notes (`tasks/TASK-NNNN-assets/notes/*.md` or `reference/notes/*.md` with `note: open`): each holds a request saved from the viewer with its context; work it into its source, then set `note: done` and add a dated line saying what changed. A note with `step:` is a decision or direction for that step; its prompt says what to do, including completing the step.
- `## Next actions`: a `###` heading per action, an optional `Work item: W1.2` line, and a fenced `prompt` block an agent can carry out on its own.
- `## Updates`: dated bullets, newest first.
- `## Chats`: links to the conversations that worked on the task.

Take the next free number for a new task's ID, and update `updated:` whenever you change a task.

## Diagrams

Default to drawing. When the work has a shape (a system, a flow or lifecycle, a matrix of cases, where something broke), draw it without being asked. Diagrams are cheap, and readers look at them before the prose. Draw one idea per diagram.

- Write [draftably](https://github.com/byronwall/draftably) source to `tasks/TASK-NNNN-assets/<name>.draft`, with a title, a short takeaway subtitle and a legend row per color, and run `draftably check` until it is clean.
- Embed it where it is discussed, as an image: `![What it shows](TASK-NNNN-assets/<name>.draft)`. The viewer shows it as a thumbnail captioned with the alt text (diagrams on consecutive lines share a row), draws it live from the source, and opens it beside its source on click. Don't export or commit a PNG for the viewer.
- The viewer renders neither Mermaid nor ASCII art; draw a `.draft` instead. Export a PNG (`draftably inspect <file> --png <out.png>`) only for somewhere outside the workspace, such as a PR.

## Checks

Run these after editing and fix what they report:

```bash
npm run lint    # task front matter, work breakdowns, action references
npm run links   # broken links and unknown task IDs
```

When `npm run links` names a Slack channel or DM that `reference/slack-channels.md` does not, look it up in Slack (one message of a channel shows its name; a DM shows who it is with) and add `- C…: #channel-name` or `- D…: @Person` there. Leave an entry blank rather than guessing.

Use `npm run move -- <from> <to>` to rename or move a file; it repairs every link to it. `npm run task -- TASK-0101` prints a task's context in compact form.
