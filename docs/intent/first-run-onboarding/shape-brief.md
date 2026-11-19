---
title: "First-run onboarding — shape brief"
slug: "first-run-onboarding"
phase: shape
status: current
last_updated: "2026-11-18"
---

# First-run onboarding — what we are adding

**Outcome:** a solo developer clones plan-viewer, pastes one line into Claude or Codex, and ends with their own workspace open in the viewer, today's plan and one real task in it.

**Primary flow:** clone → README prompt "Read docs/setup.md and set me up" → agent runs `init` in `../planning`, starts the viewer, asks a few questions, writes today's plan and one task → viewer shows them → Setup page lists what to connect next.

## Feature scope

```text
First run
├── PLANNED ADDITIONS: build now
│   ├── README lead
│   │   ├── One-paragraph pitch, one screenshot
│   │   ├── "Set it up with your agent": clone, then the one-line prompt
│   │   └── Feature tour, then manual setup as a fallback section
│   ├── docs/setup.md: steps written for an agent
│   │   ├── Create ../planning (ask for another name only if it exists)
│   │   ├── Run init, start the viewer in the background, give the user the URL
│   │   ├── Ask the user 3–4 questions: their name, what they work on, today's focus
│   │   ├── Write today's plan and one real task, following the workspace AGENTS.md
│   │   └── Run lint, commit, point the user at the Setup page for integrations
│   ├── init without a package manager
│   │   ├── No package.json; sets core.hooksPath to the viewer's hooks/
│   │   ├── Copies AGENTS.md with the real path to cli.ts in its commands
│   │   └── Ends with the command that starts the viewer
│   └── Demo for contributors only
│       └── npm run demo becomes npm run dev:demo; the README lead no longer mentions it
├── PLANNED ADDITIONS: after the Setup page (TASK-0040) lands
│   ├── Getting started section at the top of Setup while the workspace is new
│   │   ├── Items: today's plan, a first task, agent app picked
│   │   ├── Each item: done mark, or a note popover with the setup prompt
│   │   └── Shrinks to a chip once a daily plan and a task exist
│   └── Empty workspace opens Setup instead of "No planning documents found"
└── LATER POSSIBILITIES
    ├── A global plan-viewer command on PATH
    └── Checking setup.md with a scripted agent run in CI
```

## Behavior

| Situation | Expected result |
| --- | --- |
| `init` in an empty folder beside the clone | git repo, `.gitignore`, folders, `AGENTS.md` and `CLAUDE.md`, hooks path set; no `package.json`. |
| Workspace not beside the clone | `AGENTS.md` commands use the real relative path, such as `../tools/plan-viewer/cli.ts lint`. |
| Existing workspace with a `package.json` | `init` leaves it alone; its scripts keep working. |
| Workspace has no daily plan and no task (later) | Viewer opens Setup with Getting started expanded. |

## Examples

Workspace commands after `init`, in its `AGENTS.md`:

```sh
../plan-viewer/cli.ts lint     # task front matter, work breakdowns
../plan-viewer/cli.ts links    # broken links and unknown task IDs
../plan-viewer/cli.ts          # start the viewer
```

## Decisions and boundaries

- **Appetite:** a small stack; four PRs now, one after TASK-0040.
- **Agent first, no wizard.** The agent does setup through `docs/setup.md`; the viewer only shows state and hands off.
- **Pushback:** no `package.json` in the workspace. Nothing installs, so npm versus pnpm stops being a setup step. `cli.ts` is already executable with its own Node flags.
- **Survives the layout change.** `setup.md` names no folder paths; it tells the agent to follow the workspace `AGENTS.md`, which TASK-0039 updates.
- **First proof:** does a fresh clone reach a working workspace from `docs/setup.md` alone?
- **Try:** follow `docs/setup.md` by hand in a temp folder from a fresh clone.
- **Observe:** the viewer serves the new workspace, lint passes, and a commit runs the hook.
- **Decide:** if any step needs knowledge not in `setup.md` or the workspace `AGENTS.md`, add it there before the README points at it.
