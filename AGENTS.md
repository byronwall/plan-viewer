# Plan Viewer: agent guide

For agents changing the viewer. User-facing behavior and configuration are described in `README.md`. Content lives in separate planning workspaces (Byron's is `/Users/byronwall/repos/daily-planning`); never add workspace content here.

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
| Code view: worktrees, PRs, commits, diff viewer, PR overview overlay, branch picker | `public/code.js` (client), `public/diff-map.js` (the overlay's change-map treemap layout), `code-dashboard.ts` (git/gh scanning, PR cache in the workspace's `tmp/code-cache.json`, `/api/code/pr-index` for ⌘K, `/api/code/line-counts` for the map) |
| GitHub, Linear, Jira and Slack titles cached in `tmp/link-metadata.json` | `link-metadata.ts` |
| Codex Desktop deep links | `codex-desktop.ts` |
| Search and the Weeks calendar | `public/search.js`, `public/weeks.js` |
| Styles | `public/styles.css` |

## Commands

- `npm test` runs every `*.test.*` file against `fixtures/planning/` (set by `PLANNING_ROOT`), never live planning files. It should always be green; a failure is yours.
- `npm run demo` serves the fixtures. Against a real workspace, run `node /path/to/plan-viewer/cli.ts <serve|lint|links|move|task>` from that workspace.
- `.githooks/pre-commit` (enabled by `npm install`) runs `npm test`. `hooks/pre-commit` is the hook planning workspaces install; it is not this repository's.

## Gotchas

- Server changes (`*.ts`) need a server restart; client changes in `public/` need only a reload.
- Byron's own viewer runs on 4173. For previews, start another port with `PLAN_VIEWER_PORT`.
- `html` has `scroll-behavior: smooth`, so a plain `window.scrollTo(0, y)` animates and may not move at all in a background preview pane. Use `window.scrollTo({ top: y, behavior: "instant" })`. The library rail (`nav.documents`) scrolls on its own.
- `/api/code` takes several seconds on its first scan. Wait for `[data-code-state="ready"]` (and `[data-commits-state="ready"]` on the Commits tab) instead of polling the table.
- Load the `byron-ui-taste` skill in full before any UI change in `public/`.

## Design intent

`docs/code-view.md` records why the Code view works the way it does; read it before adding a new list/inspector/overview surface. `docs/issues-plan.md` is the plan for the Jira issues view.

## Rules

- Keep the viewer generic. Anything that names a person, organization, repository, tracker, tool path, or skill belongs in `viewer.config.json` with a neutral default in `public/config.js`, documented in the README's configuration table. Fixtures and tests use the fictional `acme` organization.
- The workspace layout (`daily/`, `tasks/TASK-NNNN.md`, `plans/`, `reference/`) is the content format, not configuration.
- Commit completed changes as you go on the existing branch, after `npm test` passes.
