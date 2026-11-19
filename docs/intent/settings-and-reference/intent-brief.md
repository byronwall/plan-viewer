---
title: "Settings, reference files and prompts in the viewer"
slug: "settings-and-reference"
phase: intent
status: current
last_updated: "2026-11-18"
---

# Settings, reference files and prompts in the viewer

## My read

Onboarding a new user on 2026-11-18 showed that Plan Viewer hides most of what makes it work. Settings live in `viewer.config.json`, tokens in `config.toml` or environment variables, and sign-ins in outside tools (`gh`, `acli`, Codex). Reference files such as the repo list sit in `reference/`. The prompts the viewer sends to agents are string templates in `server.ts`, `code-dashboard.ts` and `plans.ts`, and the daily routines (the day's plan, the daily review, the Up next sweep) are conventions in a workspace `AGENTS.md` and skills. A new user cannot see what exists, what is missing, or what a button will ask an agent to do.

Byron wants one view of all of it. The viewer should show everything that can be configured and its state, every reference file it reads, and every prompt it has. When something is missing, a helper hands the setup to an agent. The viewer does not become a setup wizard; the agent does the setup.

## What matters most

- See everything: every setting, every reference file, every prompt, in the UI rather than in hidden Markdown or code.
- See state: what is set, what is missing, and what that costs (which page or button stays off).
- Agent-led setup: each missing piece has a helper that drafts the setup for an agent through copy-to-agent or an Up next note.

## The experience you appear to want

A new user opens the viewer and finds a place that lists the integrations: GitHub CLI, Jira (`acli`), Linear key, Slack token, Codex app server, draftably, and the rest. Each row says whether it works. A missing one has a helper button. The button opens the existing note popover with a prompt that tells an agent how to set that integration up for this workspace. The user saves it to Up next or sends it now.

The same place shows the reference files the viewer reads (the repo list first) and the prompts it uses: issue review, PR review skills, the daily plan, the daily review and the Up next sweep. The user can read each prompt before any button sends it.

## Boundaries

### Must be true

- Setup is done by an agent. Helpers produce a prompt; they do not run sign-ins or write tokens.
- Helpers use the existing launch path: the note popover, `/api/notes` and copy-to-agent.
- The viewer stays generic. Names of people, repos and tools stay in `viewer.config.json`.
- Reference files and prompt files live where TASK-0039 puts them on disk.

### Must be avoided

- An in-app setup wizard or forms that collect credentials.
- Showing token values in the UI.
- A second copy of a prompt that can drift from the one the viewer sends.

## What seems settled

- This is separate from the workspace layout initiative (TASK-0039), and it builds on that layout.
- First-run onboarding (TASK-0038) will send new users to these pages.
- Helpers go through copy-to-agent or Up next notes.

## Decided in question rounds (2026-11-18)

- One Setup page with sections: Integrations, Settings, Reference files, Prompts.
- Settings are shown in full; scalar keys edit in place, everything else goes through a helper or the user's editor.
- Every prompt becomes a workspace file with a built-in default. Only customized prompts are written to the workspace.
- Integrations get a live probe when the page opens, with Recheck.
- Helpers use the note popover: Enter saves an Up next note, the quiet button opens a chat.
- Daily plan, daily review and Up next sweep become prompts with launch buttons.
- Build waits for the TASK-0039 layout.

## Current reality that matters

- About 45 `viewer.config.json` keys, all documented in `docs/configuration.md`, with defaults in `public/config.js`. The only in-app writer today is the Code page gear menu, which writes `code.reposFile`.
- Two secrets (`LINEAR_API_KEY`, `SLACK_TOKEN`) come from the environment or `config.toml`. External tools: `gh`, `acli`, `codex app-server`, `draftably`, Codex and Claude Desktop deep links.
- Built-in prompts: document, chunk, global, diagram, next action and work item handoffs (`server.ts`), PR note prompts (`code-dashboard.ts`), Plans Update and Retire (`plans.ts`), Slack Discuss, the review move, and cleanup prompts. Configured prompts: `code.prSkills`, `issues.skills`, `code.planSkill`, `code.postNotesSkill`.
- The daily plan, daily review and Up next sweep have no prompt in the viewer. They exist only as `AGENTS.md` conventions, the `retro` skill and `plan-viewer next`.

## Next step after confirmation

Build after TASK-0039 lands. See [shape-brief.md](shape-brief.md) and [implementation-plan.md](implementation-plan.md).
