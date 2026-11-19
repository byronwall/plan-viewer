---
title: "First-run onboarding — implementation plan"
slug: "first-run-onboarding"
phase: plan
status: current
last_updated: "2026-11-18"
---

# First-run onboarding — implementation plan

## Plan at a glance

0. Plan docs — this folder, as the first PR of the stack.
1. **M1 Demo for contributors** — `npm run demo` becomes `npm run dev:demo`.
2. **M2 init without a package manager** — no `package.json`; hooks path and `AGENTS.md` commands point at the clone.
3. **M3 Agent setup and README lead** — `docs/setup.md` and the new README top.
4. **M4 Getting started on Setup** — after TASK-0040's Setup page merges.

M2 comes before M3 because `setup.md` describes what `init` does. M4 waits for the page it lives on.

## Implementation strategy

- The fast loop is `npm test` (`init-workspace.test.ts`) plus a by-hand run: `git clone` the checkout into a temp folder, run `../plan-viewer/cli.ts init` beside it, serve, lint, commit.
- No new dependency. The agent is the only outside actor, and `setup.md` is its interface. A scripted agent run is below the line.
- Overlap: open PR 16 (`claude/workspace-layout-migrate`) adds a `migrate` script to `init-workspace.ts`'s `SCRIPTS`, which M2 deletes. Whichever merges second drops that line. PR 16 also rewrites `examples/workspace/AGENTS.md` paths; M2 changes only its command block. M4 builds on PR 15's Setup page.

## Milestone 1: Demo for contributors only

Changes: rename the `demo` script to `dev:demo` in `package.json`; update `.claude/launch.json`'s `demo` command, `AGENTS.md`, `docs/guide.md`, and the README contributing section.

Verify: `npm run dev:demo` serves `examples/workspace`; `grep "run demo"` finds nothing.

### Desired end state

- No user-facing text sends a new user to the demo.

## Milestone 2: init without a package manager

Changes in `init-workspace.ts`:
- Drop `SCRIPTS`, the `package.json` read, write and the `plan-viewer` checkout guard by `pkg.name` (guard on the viewer folder itself instead).
- Set `core.hooksPath` to the relative path of the viewer's `hooks/` when the workspace has its own git repository and no hooks path yet.
- Copy `AGENTS.md` with `../plan-viewer/cli.ts` replaced by the real relative path.
- Print the command that starts the viewer.

Also: `examples/workspace/AGENTS.md` commands use `../plan-viewer/cli.ts`; `hooks/pre-commit` comment; README's "Use it with your own plans" section; `docs/guide.md` start line; update `init-workspace.test.ts`.

Verify: tests; the by-hand run in a temp folder, including a commit that runs the hook.

### Desired end state

- A new workspace needs no install step.

## Milestone 3: Agent setup and README lead

Changes: new `docs/setup.md` written to an agent; README top rewritten (pitch, screenshot, "Set it up with your agent", then features, then manual setup); the repo `AGENTS.md` setup line points at `docs/setup.md`.

Verify: follow `docs/setup.md` literally in a temp folder; every step works without other knowledge.

### Desired end state

- The README's first commands lead to the user's own workspace.

## Milestone 4: Getting started on Setup (after TASK-0040)

Changes: a Getting started section at the top of `?view=setup` while no daily plan or no task exists; each item uses the note popover; the empty workspace opens Setup.

Verify: `node scripts/check-page.mjs` on an empty temp workspace shows the section; on `examples/workspace` it is a chip. Screenshots in the PR.

### Desired end state

- A new workspace's first screen says what to do next.

## Below the cut line

- A global `plan-viewer` command on PATH.
- A scripted agent run that checks `setup.md` in CI.
- Migrating existing workspaces off `package.json`.
