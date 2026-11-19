# Workspace layout on disk

## My read

Byron wants a planning workspace whose folders are deliberate and easy to explain. When he onboarded a new user on 2026-11-18, the layout read as haphazard: each piece made sense when it was added, but together they tell no clear story. Now that the tool has taken shape, the document-management decisions need one pass that settles them, before onboarding (TASK-0038) and the settings and reference pages (TASK-0040) build on top.

The test: a new user reads the folder tree and can guess where a thing goes, and the sidebar matches the tree.

## What matters most

- **A task is one folder.** Today a task is `tasks/TASK-0101.md` plus a separate `tasks/TASK-0101-assets/`. Byron: tasks "should maybe just all be in a folder."
- **Settings and prose are apart.** `reference/` mixes prose with data the tooling reads (`code-repos.json`, `slack-channels.md`), and the viewer's own preferences sit at the root.
- **Every folder earns its place.** Topics (`plans/<topic>/`) have their own sidebar page, yet Byron's workspace has none and he cannot say why they are there. "Plans" also means three things.
- **Few root folders.** Byron rejected a new root folder for loose notes.

## The experience or behavior you appear to want

An agent or a new user sees four folders and one rule for each. Links between documents are short. Moving an existing workspace is one command an agent can run, fix what it reports, and run again until it is clean.

## Boundaries

### Must be true

- The viewer, lint, links, move and steps read only the new layout.
- One migrate command moves a workspace in one shot.
- Folder names are the content format, not configuration.

### Must be avoided

- Dual-layout support, fallbacks, or compatibility redirects for old paths.
- A migrate that half-applies: it must refuse to write until its dry run is clean.

## What seems settled

From three question rounds on 2026-11-18:

- Tasks: `tasks/TASK-0101/TASK-0101.md`, assets and `notes/` beside it.
- `config/` holds everything the tooling reads or writes: `viewer.json` (was root `viewer.config.json`), data JSON, `slack-channels.md`, `retired-tasks.md`, `prompts/`.
- `reference/` holds prose only, plus loose `notes/`. It keeps its sidebar page; `config/` is not in the library.
- Topics are dropped. `plans/<topic>/` moves to `reference/<topic>/`; the Topics page goes.
- Daily plans are flat: `daily/2026-11-18.md`.
- Old favorites, recents and pasted links break.
- `plan-viewer migrate` is a dry run with a "Fix first" list; `--write` applies only when clean and then lists leftover old-layout text for an agent.

## Possibilities, not decisions

- A shared path module both server and browser import, so readers and migrate agree.
- Moving `tmp/` caches; left alone for now.

## Current reality that matters

The four root folders are written into the code directly, about 40 times, in `server.ts`, `check-planning.ts`, `check-links.ts`, `move-doc.ts`, `steps.ts`, `outbound.ts`, `task-context.ts`, `init-workspace.ts`, `public/app.js`, plus `examples/workspace/`, `fixtures/planning/` and the workspace `AGENTS.md` that teaches agents the format.

## What still needs your input

Nothing for the shape. Running migrate on `~/Projects/planning` waits for Byron's go-ahead.

## Next step after confirmation

Shape and plan, then build the migrate command and switch the readers.
