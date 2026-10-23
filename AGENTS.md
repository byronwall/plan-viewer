# Plan Viewer: agent guide

For agents changing the viewer. Content lives in separate planning workspaces; never add real workspace content here.

## Setup

Node.js 22.6+ and nothing else. `npm install` (no packages; it enables the pre-commit hook), then `npm test` and `npm run demo`. If you are setting up a planning workspace for someone rather than changing the viewer, follow the README's "Use it with your own plans" and copy `examples/workspace/AGENTS.md` and `CLAUDE.md` into the workspace.

## Docs

| File | Holds | Update when |
| --- | --- | --- |
| `README.md` | The product intro: what it does, screenshots, setup, commands. Keep it short; detail goes in `docs/`. | Setup, commands, or a headline feature changes. |
| `docs/guide.md` | Every page, shortcut, and behavior. | Any user-visible behavior changes. |
| `docs/configuration.md` | Every `viewer.config.json` key and environment variable. | A key or variable is added or changed. |
| `docs/code-view.md`, `docs/issues-plan.md`, `docs/plans-plan.md` | Design intent and plans for those surfaces. | Before adding a list/inspector/overview surface, read `code-view.md`. |
| `docs/images/` | README screenshots, made by `scripts/screenshots.mjs` from `examples/workspace/`. | A pictured screen changes visibly. |
| `examples/workspace/` | The demo and the template for new workspaces, including the workspace-side `AGENTS.md`. | The content format changes (it must pass `plan-viewer lint` and `links`). |

## Layout

The server is TypeScript run by `node --experimental-strip-types`. There is no `tsc` and no bundler, so editor type errors about `node:` modules are expected. The browser client is plain ES modules in `public/`, served as-is.

| Feature | Files |
| --- | --- |
| Per-workspace preferences (`viewer.config.json`) and their defaults, shared by server and browser | `public/config.js` |
| `plan-viewer` subcommands | `cli.ts` |
| HTTP routes, document loading, task front matter, Codex handoff prompts | `server.ts` |
| Next actions, work breakdown parser and graph, stalled-task reason (shared by server, lint and browser) | `public/actions.js` |
| Markdown rendering, link and chat detection, heading IDs | `public/markdown.js` |
| App shell, routing (`?view=`), library rail, Tasks page, Weeks page, document page, image viewer, ⌘K palette, toasts, recently-viewed history (from every URL change; Reopen toast when an overview closes) | `public/app.js` |
| Sticky document dock (sections, outgoing links, backlinks), link metadata keys | `public/dock.js` |
| Code view: worktrees, PRs, commits, diff viewer, PR overview overlay, branch picker, Local servers overlay (⌘K) | `public/code.js` (client), `public/diff-map.js` (the overlay's change-map treemap layout), `code-dashboard.ts` (git/gh scanning, `code.run` local servers through `local-runs.ts` (`/api/code/runs` lists them, `restart-run` restarts), PR cache in the workspace's `tmp/code-cache.json`, `/api/code/pr-index` for ⌘K, `/api/code/line-counts` for the map) |
| Plans tab (Code view): initiatives from each tracked repo's origin/main via git, open PRs that touch or propose them, reader overview, Update/Retire drafts, cache in `tmp/plans-cache.json` | `plans.ts` (server), `public/plans.js` (client, mounted by `code.js`), `fixtures/plans/` (acme initiatives the tests commit into a temporary repo) |
| Issues page: Jira sync through `acli`, Linear issues and projects, `tmp/issues-cache.json`, activity diffs, issue ↔ PR joins, Jira ↔ Linear pairs, issue agent drafts | `issues.ts` (server), `linear.ts` (Linear GraphQL reads in the Jira issue shape), `public/issues.js` (client), `fixtures/jira/` (fictional corpus and the `fake-acli.js` the fixtures config runs) |
| GitHub, Linear, Jira and Slack titles cached in `tmp/link-metadata.json` | `link-metadata.ts` |
| Codex Desktop deep links | `codex-desktop.ts` |
| Search and the Weeks calendar | `public/search.js`, `public/weeks.js` |
| Styles | `public/styles.css` |

## Commands

- `npm test` runs every `*.test.*` file against `fixtures/planning/` (set by `PLANNING_ROOT`), never live planning files. It should always be green; a failure is yours. New test files must be added to the `test` script in `package.json`.
- `npm run demo` serves `examples/workspace/` on 4173 (`PLAN_VIEWER_PORT` to change). `fixtures/` is for tests only; keep demo content in `examples/`. Against a real workspace, run `node /path/to/plan-viewer/cli.ts <serve|lint|links|move|task>` from that workspace.
- `PLAN_VIEWER_DRY_RUN=1` makes agent handoffs validate and log without opening Codex or Claude, for testing the draft flow.
- `npm install --no-save playwright-core && node scripts/screenshots.mjs [name,…]` regenerates `docs/images/` with installed Chrome; then `oxipng -o 4 --strip safe docs/images/*.png`.
- `.githooks/pre-commit` (enabled by `npm install`) runs `npm test`. `hooks/pre-commit` is the hook planning workspaces install; it is not this repository's.

## Gotchas

- `plan-viewer serve` and `npm run demo` restart themselves when a `*.ts` file changes (`node --watch`); client changes in `public/` need only a reload.
- Byron's own viewer runs on 4173; leave it alone. Preview with `.claude/launch.json`: `demo` (4176) or `workspace` (4177, the real planning workspace whose path is in the ignored `.claude/workspace`, or `PLAN_VIEWER_WORKSPACE`). Never edit `launch.json`; parallel sessions share it, and `preview_start` reuses a running server.
- `html` has `scroll-behavior: smooth`, so a plain `window.scrollTo(0, y)` animates and may not move at all in a background preview pane. Use `window.scrollTo({ top: y, behavior: "instant" })`. The library rail (`nav.documents`) scrolls on its own.
- `/api/issues` answers from cache; the first live sync takes about two minutes. Wait for `[data-issues-state="ready"]`. `acli jira workitem search --fields key` returns nulls, so searches ask for `status`.
- `/api/code` takes several seconds on its first scan. Wait for `[data-code-state="ready"]` (and `[data-commits-state="ready"]` on the Commits tab) instead of polling the table.
- Load the `byron-ui-taste` skill in full before any UI change in `public/`.

## Rules

- Keep the viewer generic. Anything that names a person, organization, repository, tracker, tool path, or skill belongs in `viewer.config.json` with a neutral default in `public/config.js`, documented in `docs/configuration.md`. Fixtures, examples, and tests use the fictional `acme` organization.
- Document behavior changes in `docs/guide.md` in the same commit, not in the README.
- The workspace layout (`daily/`, `tasks/TASK-NNNN.md`, `plans/`, `reference/`) is the content format, not configuration.
- Commit completed changes as you go on the existing branch, after `npm test` passes. Stage your files by name, never `git add -A` or `git add .`, and never `git checkout`/`git restore` a file you did not change: another session may be editing this checkout.
