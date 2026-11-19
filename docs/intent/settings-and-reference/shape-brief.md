---
title: "Settings, reference files and prompts in the viewer — shape brief"
slug: "settings-and-reference"
phase: shape
status: draft
last_updated: "2026-11-18"
---

# Settings, reference files and prompts — what we are adding

**Outcome:** A new user opens one Setup page and sees every integration, setting, reference file and prompt the viewer uses, what works, what is missing, and a helper that hands each missing piece to an agent.

**Primary flow:** Open Setup → see a red row (for example "Jira: `acli` not signed in") → press its helper → Enter saves an Up next note (or the quiet button opens an agent chat now) → the agent sets it up → Recheck turns the row green.

## Feature scope

```text
Setup page (?view=setup, one entry in VIEWS, linked from the rail and ⌘K)
├── PLANNED ADDITIONS
│   ├── Integrations
│   │   ├── One row each: GitHub CLI, Jira (acli), Linear key, Slack token,
│   │   │   Codex app server, draftably, agent apps (Codex / Claude Desktop)
│   │   ├── Live probe on page open, with Recheck (gh auth status, acli auth, one Linear call, token present)
│   │   ├── What the row turns on: the pages and buttons that stay off without it
│   │   └── Helper: note popover with a setup prompt (state, docs section, keys to set); never shows a token
│   ├── Settings
│   │   ├── Every viewer.config.json key: value, default, and whether it is set
│   │   ├── Scalars (strings, numbers, booleans) edit in place and write viewer.config.json
│   │   └── Arrays, objects and commands: an Open file button and a helper
│   ├── Reference files
│   │   └── Each file the viewer reads (repo list first): path, purpose, the key that names it, Open
│   └── Prompts
│       ├── Every prompt the viewer sends, from one registry: handoffs, PR notes, Plans Update and Retire,
│       │   Slack Discuss, review move, cleanup, PR and issue skills
│       ├── Shown with its placeholders; badge "Default" or "Customized"
│       ├── Customize writes a workspace copy that then wins; Reset deletes it; diff against the default
│       └── Routines: daily plan, daily review, Up next sweep, each with a launch button (note popover)
└── LATER POSSIBILITIES
    ├── Editing string lists as chips
    └── A first-run banner that sends new users here (TASK-0038 owns it)
```

## Behavior

| Situation | Expected result |
| --- | --- |
| `gh` missing or signed out | GitHub row is red, says PRs, CI and GitHub issues are off, offers the helper. |
| User edits `user` in place | `viewer.config.json` gains or changes only that key; the page reloads its config. |
| Prompt never customized | The viewer sends its built-in default; a viewer upgrade changes it. |
| Prompt customized | The workspace file is sent; the row shows Customized and a diff to the current default. |
| Daily review launched | Prompt asks for a day recap, stale and waiting tasks, agent flags retro, then a draft of tomorrow's plan. |
| Up next sweep launched | Agent runs `plan-viewer next`, works each item in priority order, folds notes into tasks, marks them done, reports what waits on Byron. |

## Decisions and boundaries

**Appetite:** One page with four sections. Medium: a prompt registry refactor plus a page.

**Key decision:** A prompt file holds the instruction text with named placeholders (`{user}`, `{source}`, `{commentary}`). Facts blocks and conditional parts stay in code and fill those slots. This keeps the files readable and avoids a template language.

**Boundary:** The viewer never asks for or shows a token. Helpers write prompts, not config. No setup wizard. Only one prompt source exists: the registry the page reads is the one the buttons send.

**First proof:** **Try:** the Integrations section with GitHub and Jira probes and their helpers, against the fixtures workspace. **Observe:** a signed-out `gh` (via a fake command) shows red with the right cost, and the helper saves an Up next note. **Decide:** if probes take over a second or need sign-in prompts, switch to presence-only states with an explicit Check button.

**Open choices:** Where prompt overrides live on disk (TASK-0039 decides; likely next to `reference/`).

Intent: [intent-brief.md](intent-brief.md). Plan: [implementation-plan.md](implementation-plan.md).
