# Plan Viewer: agent guide

For agents changing the viewer. Content lives in separate planning workspaces; never add real workspace content here.

## Setup

Node.js 22.6+ and nothing else. `npm install` (no packages; it enables the pre-commit hook), then `npm test` and `npm run dev:demo`. If you are setting up a planning workspace for someone rather than changing the viewer, follow `docs/setup.md`.

## Docs

| File | Holds | Update when |
| --- | --- | --- |
| `README.md` | The product intro: what it does, screenshots, setup, commands. Keep it short; detail goes in `docs/`. | Setup, commands, or a headline feature changes. |
| `docs/setup.md` | First-run setup, written for the user's agent; the README's setup prompt points at it. Names no workspace paths: it defers to the workspace `AGENTS.md`. | `init` or the first-run flow changes. |
| `docs/guide.md` | Every page, shortcut, and behavior. | Any user-visible behavior changes. |
| `docs/configuration.md` | Every `config/viewer.json` key and environment variable. | A key or variable is added or changed. |
| `docs/code-view.md`, `docs/issues-plan.md`, `docs/plans-plan.md` | Design intent and plans for those surfaces. | Before adding a list/inspector/overview surface, read `code-view.md`. |
| `docs/images/` | README screenshots, made by `scripts/screenshots.mjs` from `examples/workspace/`; the Chat Threads shot answers `/api/chat-threads` with the fictional threads in `scripts/chat-threads-sample.mjs`, never real sessions. | A pictured screen changes visibly. |
| `site/` | The GitHub Pages site (byronwall.github.io/planboard): a short intro, then every page section by section. Plain HTML and CSS, deployed as is by `.github/workflows/pages.yml`. Its screenshots in `site/images/` come from `scripts/site-screenshots.mjs` (fictional data only; numbered marks match the lists). | A page or section is added, or a pictured screen changes visibly. |
| `examples/workspace/` | The demo and the template for new workspaces, including the workspace-side `AGENTS.md`. | The content format changes (it must pass `plan-viewer lint` and `links`). |

## Layout

The server is TypeScript run by `node --experimental-strip-types`. There is no `tsc` and no bundler, so editor type errors about `node:` modules are expected. The browser client is plain ES modules in `public/`, served as-is.

| Feature | Files |
| --- | --- |
| Per-workspace preferences (`config/viewer.json`) and their defaults, shared by server and browser | `public/config.js` |
| `plan-viewer` subcommands | `cli.ts`; `init` is `init-workspace.ts`; `migrate` (older layout → current, dry run unless `--write`) is `migrate.ts` |
| Workspace folder layout: task folder and file for an ID, the task of a path, daily file for a date, config paths (shared by server, checks and browser) | `public/layout.js` |
| HTTP routes, document loading, task front matter, Codex handoff prompts | `server.ts` |
| Next actions, work breakdown parser and graph, stalled-task reason (shared by server, lint and browser) | `public/actions.js` |
| Markdown rendering, link and chat detection, heading IDs | `public/markdown.js` |
| App shell, routing (`?view=`; every page other than a document is one entry in `VIEWS`, which boot, Back/Forward and live refreshes all use, and `pages.test.js` fails for a page that sets `state.view` without one), library rail, Tasks page, document page, image viewer, ⌘K palette, toasts, recently-viewed history (from every URL change; Reopen toast when an overview closes), document-change toasts and Recently changed (from `/api/changes` and the `/api/events` stream, summarized by `describeChange` in `server.ts`) | `public/app.js` |
| Sticky document dock (sections, outgoing links, backlinks), link metadata keys | `public/dock.js` |
| Code view: worktrees, PRs, commits, diff viewer, PR overview overlay, branch picker, Local servers overlay (⌘K) | `public/code.js` (client), `public/diff-map.js` (the overlay's change-map treemap layout), `public/note-anchor.js` (where a local PR note sits after new commits: moved, edited, outdated), `code-dashboard.ts` (git/gh scanning, `code.run` local servers through `local-runs.ts` (`/api/code/runs` lists them, `restart-run` restarts), PR cache in the workspace's `tmp/code-cache.json`, `/api/code/pr-index` for ⌘K, `/api/code/line-counts` for the map) |
| Plans page (`?view=plans`, `renderPlans` in `app.js`): initiatives from each tracked repo's origin/main via git, open PRs that touch or propose them, a Code-view toolbar (status scope, group, sort), the table and inspector, the reader overlay (also opened by `planForLink` for GitHub links into an initiative), Update/Retire drafts, cache in `tmp/plans-cache.json` | `plans.ts` (server), `public/plans.js` (client), `fixtures/plans/` (acme initiatives the tests commit into a temporary repo) |
| Issues page: Jira sync through `acli`, Linear issues and projects, `tmp/issues-cache.json`, activity diffs, issue ↔ PR joins, Jira ↔ Linear pairs, issue agent drafts | `issues.ts` (server), `linear.ts` (Linear GraphQL reads in the Jira issue shape), `public/issues.js` (client), `fixtures/jira/` (fictional corpus and the `fake-acli.js` the fixtures config runs) |
| GitHub, Linear, Jira and Slack titles cached in `tmp/link-metadata.json` | `link-metadata.ts` |
| Slack thread overlay: threads and channel names read through `codex app-server`'s direct connector tool calls (no model), cached in `tmp/slack-threads.json`; Discuss drafts with the thread as a Markdown file; documents' `slackLinks` for Linked from | `slack-thread.ts` (server), `public/slack.js` (overlay, mrkdwn to Markdown, reactions), `public/emoji.js` (curated Slack shortcodes) |
| Slack page (`?view=slack`): linked threads by channel or activity, sync of unread threads (`/api/slack`, `/api/slack/sync`), stars into Favorites | `public/slack-page.js` (client), `slackIndex` in `server.ts`, `sync`/`summaries` in `slack-thread.ts` |
| Overlays (PR, worktree, issue, initiative, Slack thread, document peek): the shared dialog shell, backdrop close, URL parameter and close announcement; `OVERLAYS` in `app.js` maps each parameter to its opener, Recently viewed row and Reopen toast, so a new overlay is one entry there | `public/overlay.js`, `OVERLAYS` and `peekDocument` in `public/app.js` |
| Diagrams: `.draft` files drawn on request by the draftably CLI (`renderDiagram`, `/api/diagram`, `/api/diagram/open` in `server.ts`, live redraw through the `diagram` event), and the image viewer's diagram mode (inline SVG beside the hover-linked source, `?diagram=`) | `public/diagram.js`, image viewer in `public/app.js` |
| World views (`?world=TASK-NNNN`, `?world=all`): a task's assets, plan mentions and updates as day columns and kind lanes, and every task as a row on the same axis (`listTaskWorld`, `/api/task-world` in `server.ts`) | `public/world.js` |
| Diagrams page (`?view=diagrams`): every `.draft` as thumbnails grouped by task, with a filter (`listDiagrams`, `/api/diagrams` in `server.ts`) | `public/diagrams-page.js` |
| Launch buttons' note popover: every button that would start an agent chat saves its prompt as an Up next note instead (Enter), with the launch as its quiet button; `withNote` puts the typed comment on top for save, copy and launch alike | `public/note-popover.js` (client), `/api/notes` and `saveLaunchNote` in `steps.ts`, `withNote` in `public/config.js`, `launch-notes.test.js` (no launch route is called outside a popover's `send`) |
| Outbound drafts (task assets with `outbound:` front matter): fields, the hash of the outgoing text, Approve and send through `outbound.send`, Send back, Drop, Mark sent (`/api/outbound/*`); the approval panel on a draft's page | `outbound.ts` (server), `public/outbound.js` (panel and its delegated handlers) |
| Steps page (`?view=steps`; lint rules in `stepErrors` and `draftErrors` in `check-planning.ts`; the Today plan's lead in `todayLeadHtml`, Outbox at `&kind=outbound`): open steps from every task's work breakdown with their next move (`deriveSteps`) and priority score (`scoreStep`, `downstreamCount`, `byPriority`; task `priority:` front matter written by `/api/steps/priority`), machinery files by `step:`, Pick on choices, Start with agent slots, Approve and run, Apply, Mark done (`/api/steps`, `/api/steps/{pick,start,run,apply,done}`); the `{kind, size}` suffix is parsed in `parseWorkBreakdown` | `steps.ts` (server; task folders are walked by `task-files.ts`, which skips symlinks and `node_modules`), `public/steps-page.js` (table, toolbar, inspector), `stepsIndex` and routes in `server.ts`, page wiring in `public/app.js` |
| Chat Threads page (`?view=chat-threads`): local Codex and Claude Code threads from session metadata, `lsof` and the Codex state database; spawned threads (`parent`) nest under their parent and do not count toward the history limit; model names and family colors in `modelInfo` | `chat-threads.ts` (server, `/api/chat-threads`), `public/chat-threads.js` (client) |
| Setup page (`?view=setup`): live integration checks (`gh`, `acli`, Linear, Slack, Codex app server, draftably, agent apps), every `config/viewer.json` key with its meaning read from `docs/configuration.md` (a key missing there fails `setup.test.ts`), scalar edits and Reset (`/api/setup/config`), the Config files list and read-only view (`/api/setup/file`, never `config.toml`), helper prompts through the note popover (`/api/setup/agent`), and Getting started at the top while the workspace has no daily plan or no task (`gettingStarted`, `firstTaskPrompt`; boot opens Setup then) | `setup.ts` (server), `public/setup-page.js` (client) |
| Prompt templates: every agent prompt the server builds (handoffs, work items, PR notes, worktree cleanup, Plans Update and Retire, Slack Discuss, and the `routine: true` daily plan, daily review and Up next sweep that the Setup page Starts through `routinePrompt` in `setup.ts`) is `prompts/<id>.md` with `{slots}`, overridden by the workspace's `config/prompts/<id>.md`; builders call `fillPrompt`. Change the words in the `.md`, not in code | `prompts.ts`, `prompts/` |
| Codex Desktop deep links | `codex-desktop.ts` |
| Tab brief (`?brief=`): why an agent opened this tab, pinned at the top and above overlays, hidden to a chip, kept in sessionStorage | `public/brief.js` |
| Expanded table: sort, column filters, column resize; overlay size (corner and edge grips, ½ ⅔ Fit Full, Fill width, keys 1–4 and F, `?table=N&table-size=&table-fill=0`) | `public/table-viewer.js`, `public/table-size.js`, `public/column-fit.js` (column widths for a frame width, shared with `table-fit.js`) (opened by `showTableViewer` in `app.js`; `table` entry in `OVERLAYS`) |
| Document tables: fitted column widths, tall-table scroll frame, its footer (row range, Show all, Expand) and sticky top tab bar (`TABLE_TOOLS` in `markdown.js`) | `public/table-fit.js` (finds every `.markdown-table-scroll` itself through a MutationObserver) |
| Activity page: documents, issues, open PRs and Slack threads (row helpers and `threadDetail` from `slack-page.js`) in one list with a day strip and an inspector (reuses the Issues sidebar through `issueInspector`) | `public/activity.js` |
| One avatar per person: GitHub/Linear/Slack/config identities joined into `/api/people`, read by `avatar()` in `code.js` | `people.ts` |
| Syntax colors for Markdown code fences (`.markdown-code`, found by a MutationObserver; highlight.js loaded on the first block) | `public/code-highlight.js` |
| Search and date helpers | `public/search.js`, `public/dates.js` |
| Icons: Lucide glyphs and Simple Icons brand marks, vendored as path strings | `public/icons.js` |
| Styles | `public/styles.css` |

## Commands

- `npm test` runs every `*.test.*` file against `fixtures/planning/` (set by `PLANNING_ROOT`), never live planning files. It should always be green; a failure is yours.
- `npm run dev:demo` serves `examples/workspace/` on 4173 (`PLAN_VIEWER_PORT` to change). `fixtures/` is for tests only; keep demo content in `examples/`. Against a real workspace, run `node /path/to/plan-viewer/cli.ts <serve|init|lint|links|move|task>` from that workspace.
- `PLAN_VIEWER_DRY_RUN=1` makes agent handoffs validate and log without opening Codex or Claude (the response carries the `prompt`), for testing the draft flow.
- `npm install --no-save playwright-core && node scripts/screenshots.mjs [name,…]` regenerates `docs/images/` with installed Chrome; then `oxipng -o 4 --strip safe docs/images/*.png`.
- `.githooks/pre-commit` (enabled by `npm install`) runs `npm test` on the staged files, bounded so a hang can never hold `.git/index.lock` for long: 30 s per test, `--test-force-exit` past leaked timers, stdin closed, and a watchdog that kills the run after `PLAN_VIEWER_HOOK_TIMEOUT` seconds (default 180) and prints the last 40 lines. A test that leaves a child or timer running must stop it in `t.after`. `hooks/pre-commit` is the hook planning workspaces install; it is not this repository's.

## Gotchas

- `plan-viewer serve` and `npm run dev:demo` restart themselves when a `*.ts` file changes (`node --watch`); client changes in `public/` need only a reload.
- `serve` caches the document index and the Steps index (`memo.ts`) until a file under `daily/`, `tasks/`, `reference/` or `config/` changes or a write request (any POST not in `READ_ONLY_POSTS` in `server.ts`) runs. A new endpoint that writes workspace files through a GET, or a read-only POST every page sends, must account for that. Format dates with `formatDateTime` from `public/dates.js`, not `toLocaleDateString`, in anything that renders a list.
- The server imports some `public/` modules (`dock.js`, `markdown.js`, `actions.js`, `config.js` and others), so top-level code there must not touch `document` or `window` (`globalThis.document?.…`); one that does crashes `serve`, Byron's included.
- Byron's own viewer runs on 4173; leave it alone. Preview with `.claude/launch.json`: `demo` (4176) or `workspace` (4177, the real planning workspace whose path is in the ignored `.claude/workspace`, or `PLAN_VIEWER_WORKSPACE`). Never edit `launch.json`; parallel sessions share it, and `preview_start` reuses a running server. If the pane refuses the port it lands on, or a shared server is down, don't poll it: read `preview_logs`, then check the page with `node scripts/check-page.mjs "/?path=…" [--shot f.png] [--eval js] [--wait sel]`, which serves `examples/workspace` from this checkout on a free port.
- `html` has `scroll-behavior: smooth`, so a plain `window.scrollTo(0, y)` animates and may not move at all in a background preview pane. Use `window.scrollTo({ top: y, behavior: "instant" })`. The library rail (`nav.documents`) scrolls on its own.
- `/api/issues` answers from cache; the first live sync takes about two minutes. Wait for `[data-issues-state="ready"]`. `acli jira workitem search --fields key` returns nulls, so searches ask for `status`.
- `/api/code` takes several seconds on its first scan. Wait for `[data-code-state="ready"]` (and `[data-commits-state="ready"]` on the Commits tab) instead of polling the table.
- Load the `byron-ui-taste` skill in full before any UI change in `public/`.
- A `:hover` that changes an element's look (background, color, underline, border) is only for something a click acts on. Tooltip-only marks (`data-tip`, `title`) and plain rows keep their look; a row may still reveal its own buttons on hover.

## Rules

- Keep the viewer generic. Anything that names a person, organization, repository, tracker, tool path, or skill belongs in `config/viewer.json` with a neutral default in `public/config.js`, documented in `docs/configuration.md`. Fixtures, examples, and tests use the fictional `acme` organization.
- Document behavior changes in `docs/guide.md` in the same commit, not in the README.
- The workspace layout (`daily/YYYY-MM-DD.md`, `tasks/TASK-NNNN/TASK-NNNN.md` with its files beside it, `reference/`, `config/`) is the content format, not configuration. Its path shapes live in `public/layout.js`; use those helpers instead of writing a path pattern. `migrate.ts` is the only code that knows the older layout.
- Commit completed changes as you go on the existing branch, after `npm test` passes, and push each commit to `origin` right away (`git pull --no-rebase` first if the push is rejected). Don't leave commits sitting unpushed. Stage your files by name, never `git add -A` or `git add .`, and never `git checkout`/`git restore` a file you did not change: another session may be editing this checkout.
