# Workspace layout on disk — what we are adding

**Outcome:** a workspace with four folders, one rule each, that the viewer reads and one command migrates to.
**Primary flow:** agent runs `plan-viewer migrate`, fixes the "Fix first" list, re-runs, runs `--write`, fixes leftover text, commits.

## Feature scope

```text
Workspace layout
├── PLANNED ADDITIONS
│   ├── New layout, the only one the tools read
│   │   ├── tasks/TASK-0101/TASK-0101.md with assets and notes/ beside it
│   │   ├── daily/2026-11-18.md, one file per day
│   │   ├── reference/: prose, former topics as reference/<topic>/, notes/, pr-notes/
│   │   ├── config/: viewer.json, data JSON, slack-channels.md, retired-tasks.md, prompts/
│   │   └── tmp/ unchanged
│   ├── Shared path module public/layout.js (server, checks, browser)
│   ├── Viewer
│   │   ├── library groups Today, Daily, Tasks, Task documents, Reference; Topics page removed
│   │   └── breadcrumbs, Documents panel, world view, diagrams, steps, notes, outbound use task folders
│   ├── Checks and tools: lint, links, move, task, init on the new paths
│   ├── plan-viewer migrate [--write]
│   │   ├── dry run: every move, link rewrites, "Fix first" list with a hint each; exit 1 while any remain
│   │   └── --write: git mv, rewrite links and config path values, verify links resolve, list leftover old-layout text
│   └── Docs, demo and fixtures in the new layout
└── LATER POSSIBILITIES
    └── moving tmp/ caches; redirects for old links
```

## Behavior

| Situation | Result |
| --- | --- |
| `tasks/TASK-0007-assets/` with no `TASK-0007.md` | Fix first: create the task or move the folder |
| A day folder holds files other than `plan.md` | Fix first: move them into a task or reference |
| `reference/foo.json` | moves to `config/foo.json` |
| `plans/<x>/…` | moves to `reference/<x>/…`; `plans/README.md` becomes `reference/topics.md` |
| Git tree dirty, or `config/` or `tasks/TASK-0101/` already exists | Fix first |
| Old link `../../../../tasks/TASK-0101.md` in a daily plan | becomes `../tasks/TASK-0101/TASK-0101.md` |
| Viewer started on an old-layout workspace | shows nothing old; lint names `plan-viewer migrate` |

## Examples

```text
$ plan-viewer migrate
Moves (58): tasks/TASK-0002.md → tasks/TASK-0002/TASK-0002.md …
Links: 212 rewrites in 73 files
Fix first (1):
  daily/2026/11/03/notes.md: only plan.md belongs in a day folder; move it into a task folder or reference/.
Dry run. Fix the list above and run again; then run with --write.
```

## Decisions and boundaries

- **Appetite:** a few days of agent work; one stack of four PRs.
- **No dual support:** readers switch in one PR together with the demo and fixtures, which the migrate command itself converts.
- **Pushback:** a shared `public/layout.js` comes first. Without it, the 40 hard-coded patterns drift and migrate disagrees with the readers.
- **Agent-first migrate:** every blocker message says what to do, so an agent can fix and re-run without reading code.
- **First proof:** run migrate on a copy of the current demo workspace.
- **Try:** `node cli.ts migrate --write` in a temp copy of `examples/workspace`.
- **Observe:** the moves match the table above and every relative link resolves.
- **Decide:** if links do not all resolve, fix the rewrite before switching any reader.
