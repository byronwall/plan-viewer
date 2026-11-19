---
title: "First-run onboarding"
slug: "first-run-onboarding"
phase: intent
status: current
last_updated: "2026-11-18"
---

# First-run onboarding

## My read

On 2026-11-18 Byron sat with a new person who cloned plan-viewer from GitHub. The clone worked, but the README's path did not. The first step, `npm run demo`, showed a fictional team's week. It did not move the person toward their own plans. Byron then set up a real workspace with him by hand. Byron does not see why the demo is an option, and does not think it helps people.

The durable outcome: a solo developer who uses Claude or Codex clones the repository and, without Byron in the room, ends up with a working workspace of their own. Their own plans open in the viewer, and their agent knows how to write to the workspace. The demo-first path is reconsidered, and probably removed from the front of the README.

This is about the first-run path, not about new viewer features. It builds on two sibling initiatives: the new on-disk layout (TASK-0039, `workspace-layout`) and the settings and reference pages with agent setup helpers (TASK-0040, `settings-and-reference`).

## What matters most

- The first run ends in the user's own workspace, not in sample data.
- No hand-holding: the README, `init` and the user's agent carry the setup.
- The agent is part of setup, because the audience already works with Claude or Codex.

## The experience you appear to want

A developer finds the repository, reads a short README lead, and runs a small number of commands (or asks their agent to). They get a workspace folder, the viewer opens on it, and the first screen tells them what to do next, such as "write today's plan" or "ask your agent to set up X". Optional integrations (GitHub, Jira, Linear, Slack) come later through the settings page's helpers, not as setup blockers.

## Boundaries

### Must be true

- Works for one person, one machine, a fresh clone from GitHub.
- Follows the TASK-0039 layout. No support for the old layout in new workspaces.
- The viewer still never edits the user's Markdown on its own; setup writes files only through `init` or an agent.

### Must be avoided

- A first run that ends with the user looking at someone else's fictional data and no clear next step.
- A setup that needs Byron to explain it in person.
- Building an in-app setup wizard (TASK-0040 chose agent handoffs over wizards).

## What seems settled

- Audience: solo developers who use Claude or Codex and clone from GitHub.
- `npm run demo` becomes `dev:demo`, for contributors only.
- The workspace lives in a sibling folder beside the clone.
- Setup is agent-first: the README gives a one-line prompt that points the agent at `docs/setup.md`. The agent runs `init`, starts the viewer, and writes today's plan and one real task with the user.
- The workspace has no `package.json`; commands run the clone's `cli.ts` directly.
- An empty workspace opens on a Getting started section at the top of TASK-0040's Setup page. It shrinks once a daily plan and a task exist.
- Parts that do not need TASK-0040 are built now.

## Possibilities, not decisions

- A global `plan-viewer` command on PATH.
- A scripted agent run that checks `docs/setup.md`.

## Current reality that matters

- README leads with clone, `npm install`, `npm run demo`; the own-workspace path is a second section with `mkdir`, `node ../plan-viewer/cli.ts init`, `npm install` (not pnpm), `npm run viewer`.
- `init` creates git, `.gitignore`, folders, copies `AGENTS.md`/`CLAUDE.md`, and writes `package.json` with a `file:` dependency.
- An empty workspace shows "No planning documents found." and "There is no plan for today yet."
- `examples/workspace/` also feeds the README screenshots, the `demo` preview and the template `AGENTS.md`.

## Next step after confirmation

Build the stack in `implementation-plan.md`.
