---
title: "Settings, reference files and prompts in the viewer — implementation plan"
slug: "settings-and-reference"
phase: plan
status: draft
last_updated: "2026-11-18"
---

# Settings, reference files and prompts — implementation plan

## Plan at a glance

Build waits for TASK-0039 (workspace layout) to land, by Byron's choice. That initiative decides where reference files and prompt overrides live, and each milestone below reads those paths.

The order puts the most useful and least coupled part first. Milestone 1 ships the Setup page with Integrations and Settings: it touches no prompt code and gives a new user an answer on day one. Milestone 2 adds Reference files, a small list driven by config keys and the new layout. Milestone 3 is the risky refactor: it moves every prompt into one registry with workspace overrides, while every launch button keeps sending the same text. Milestone 4 adds the three routine prompts and their launch buttons on top of that registry.

Each milestone leaves a working page with one more section. Every milestone ships as one layer of a `gh stack`, with screenshots.

## Implementation strategy

- **First proof:** The Integrations section shows a signed-out `gh` as red with its cost, and its helper saves an Up next note.
- **Primary seam:** One `probe(name)` function per integration in a new `setup.ts`, each running a configured command. Tests point the commands at fakes, as `issues.command` already does with `fixtures/jira/fake-acli.js`.
- **Fast local loop:** `node --test setup.test.ts prompts.test.ts`, then `npm run demo` for the page.
- **Local dependencies:** Fake `gh` and `acli` scripts in `fixtures/`; Linear and Slack probes check token presence in tests.
- **Live confirmation:** Open the page against Byron's planning workspace (`workspace` preview on 4177).
- **Rollback:** The page is one `VIEWS` entry. The prompt registry keeps built-in defaults, so deleting the overrides folder restores current behavior.

## Milestone 1: Setup page with Integrations and Settings

- **Change — `setup.ts` and `/api/setup`**
  - Probes: `gh auth status`, `acli` auth check through `issues.command`, Linear `viewer` query, Slack token presence, `slack.codex` and `diagrams.command` on `PATH`.
  - Each result: state, detail, the features it turns on, the `docs/configuration.md` anchor.
  - Test with fake commands for pass and fail.
- **Change — `public/setup-page.js`, `?view=setup`**
  - Integrations rows with helper buttons through `note-popover.js`; the prompt names the integration, its state and the keys to set.
  - Settings table from the defaults in `public/config.js` merged with the workspace config.
- **Change — `/api/setup/config`**
  - Writes one scalar key into `viewer.config.json`; refuses arrays, objects and unknown keys.

### Desired end state

- The rail and ⌘K open Setup; every integration and key is listed with its state.
- A helper saves an Up next note; editing `user` changes only that key on disk.
- `docs/guide.md` and `docs/configuration.md` describe the page.

## Milestone 2: Reference files

- **Change —** a list of reference files built from config keys (`code.reposFile`, `code.prNotesDir`) and the TASK-0039 layout (`slack-channels.md`, notes folder), each with purpose, key and an Open link to the document page.

### Desired end state

- Every file the viewer reads appears, and a missing one says so with a helper.

## Milestone 3: Prompt registry with workspace overrides

- **Change — `prompts.ts` and `prompts/*.md` defaults in the viewer**
  - Each prompt: id, title, where it is sent from, placeholders, default text.
  - `buildCodexPrompt`, `buildWorkItemPrompt`, `NOTE_PROMPTS`, Plans Update and Retire, Slack Discuss, the review move and cleanup read the registry.
  - A workspace override file wins when present.
  - Test: every existing prompt test still passes unchanged; an override changes the sent text.
- **Change — Prompts section:** text, Default or Customized badge, Customize, Reset, diff against the default.

### Desired end state

- The text on the page is the text the button sends. Deleting overrides restores defaults.

## Milestone 4: Routine prompts

- **Change —** default prompts for the daily plan (draft from Steps priority, check-ins, open PRs, then confirm order), the daily review (day recap, stale and waiting, agent flags retro, draft tomorrow) and the Up next sweep (`plan-viewer next`, work in priority order, fold notes, report what waits on Byron).
- **Change —** a launch button for each on the Prompts section, through the note popover.

### Desired end state

- Byron can start each routine from Setup and read its text first.

## Open decisions and spikes

- **Override location:** TASK-0039's layout decides the folder. Fallback: `reference/prompts/<id>.md`.

## Retire this initiative

- Durable docs: `docs/guide.md` (Setup page), `docs/configuration.md` (prompt overrides), `AGENTS.md` layout table.
- Remove this folder in the last stack layer.

## Below the cut line

- Editing string lists and commands in place.
- A first-run banner (TASK-0038).
- Scheduling routines automatically.
