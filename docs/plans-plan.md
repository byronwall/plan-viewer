# Plans tab: plan

A read-only view of the initiatives (`initiative-map.json` plus the briefs beside it) in every tracked repository, shown as a fourth tab of the Code view next to Worktrees, PRs and Commits. It brings over the reading half of `tk view`'s Initiatives tab (`~/Projects/ticket/plugins/ticket-view`) and follows the Code view's rules ([code-view.md](code-view.md)).

Status: planned (Oct 22, 2026). Nothing built yet.

## Decisions already made (Byron, Oct 22, 2026)

- **Purpose:** see the static plans, not track work in progress. Ongoing work is tracked through PRs.
- **Source:** each repository's `origin/main` (its remote default branch), read with git and never from a checkout. When an open PR changes an initiative's folder, show a badge that links to the PR.
- **Scope:** initiatives only. `.tickets/` is ignored, including linked-ticket status and the dependency graph.
- **Writes:** none. Changes go through editable agent drafts ("Copy prompt to update", "Copy retire prompt"), the same way reviews do.

## What the data looks like (survey of Oct 22, 2026)

- 11 tracked repositories. 74 initiative maps on `origin/main` across 8 of them: explorEDA 34, resume-studio 15, srcly 11, visual-notes 5, context-recorder 4, diagram-studio 2, and one each in product-grid-mgmt, bible-daily and comic-books.
- The worktrees hold about 2,300 copies of those maps, which is why the view reads `origin/main` instead of scanning the filesystem.
- Maps live in `docs/intent/<slug>/initiative-map.json` next to `intent-brief.md`, `shape-brief.md`, `plan.md` and others. Top-level keys: `initiative` (title, slug, scale, current_phase, status, summary, next_action, last_updated, depends_on), `intent`, `brainstorm`, `shape`, `implementation`, `closure`, `history`, `related_initiatives`, `sources`, `artifacts`.
- Status is one of planned, active, paused, completed or cancelled. Some maps have none, and `tk` infers one from work evidence.

## Server (`plans.ts`, used by `code-dashboard.ts`)

- Per repository: `git rev-parse origin/main` (falling back to `origin/HEAD`, then `main`). The SHA is the cache key, so an unchanged repository costs one git call.
- `git ls-tree -r --name-only <sha>` finds every `initiative-map.json` and the Markdown files in the same folders, skipping folders the way `tk` does (hidden folders, `node_modules`, `dist`, `build`, `vendor`, and nested initiative folders).
- `git cat-file --batch` reads all the maps in one process. Briefs are read only when opened (`/api/code/plans/doc?repo=&sha=&path=`), because the list doesn't need them.
- Edited time comes from one `git log --format=%ct --name-only <sha> -- <folders>` pass per repository: the newest commit that touched any file in the folder.
- Inferred status, when the map has none, uses milestone and implementation states only. Without tickets there's less evidence, so it's shown in italics as an inference.
- Invalid JSON produces an error row for that map and doesn't hide the others.
- Results are cached in `tmp/plans-cache.json` by repository and SHA. They refresh on the Code view's existing 10-minute timer and on `R`. A fetch isn't forced, so the view shows whatever `origin/main` was at the last fetch, and the toolbar says when that was.
- `GET /api/code/plans` returns `{ repos: [{ repo, sha, fetchedAt }], initiatives: [...] }`, and `data-plans-state="ready"` marks the tab as loaded.

## PR badges

- The PR extras pass already runs one GraphQL query per repository. It adds `files(first: 100) { path }` for open PRs, which is cheaper than a git diff per branch and works for branches that were never fetched.
- An initiative gets a badge for every open PR whose files fall under its folder: the PR number plus a draft or ready marker, linking to the PR overview.
- A PR that adds an `initiative-map.json` not on main shows a ghost row ("Proposed in #123") with the map read from the PR head. That's one `gh api` call per new map. Open question: keep the ghost rows, or only badge initiatives that already exist?

## Client (`public/plans.js`, mounted by `code.js` as `?view=code&tab=plans`)

The same shape as the rest of the Code view: list, inspector, overview.

- **List:** one row per initiative with a status dot, title, repository, phase, next action (truncated), edited time (blue within the last day), and PR badges. Sorted by recently edited and grouped by day, week and month like the other tabs. Status counts act as filters (Open hides completed and cancelled), and the repo legend, text filter (`F`) and author filter (none here) work as on the other tabs. Sort options: Edited, Title, Status, Phase.
- **Inspector:** summary, status, phase, scale, next action, Depends on, Needed by, Related (slugs resolved within the same repository and linked), the three latest history entries, open PRs, and the folder path, which copies when clicked.
- **Overview (Enter or double-click):** a reader with one tab per brief (intent, brainstorm, shape, plan) plus **Map**. It has a file tree of the folder and an outline of the open document, rendered with `markdown.js`. Links to other Markdown files in the same commit open in the reader, and Back returns. The Map tab lays out the map's sections the way `tk` does, and unknown fields still appear.
- **Keys:** `J`/`K` move, `Enter` opens, `[`/`]` step through briefs, `U` drafts an update prompt, `E` opens the folder in the editor (the root checkout), and `Esc` closes. The URL holds the open initiative and document, and Recently viewed (`H`) records them.
- **Prompts:** **Update** opens an agent draft in the repository that names the configured skill and lists the repository, folder, map and open document as bullets, ending with `---`. Completed and cancelled initiatives also offer **Retire**. The skill name lives in config as `code.planSkill`, default `""`, which leaves the skill line out.
- **⌘K:** initiative titles are searchable and open the overview.

## Configuration

- `code.plans.mapFile` (default `initiative-map.json`) and `code.plans.skip` (default list above), in `public/config.js` and documented in the README table.
- `code.planSkill` as above. Byron's workspace sets `software-design-sleuth-full`.

## Milestones

1. `plans.ts`: scan, cache, `/api/code/plans` and `/api/code/plans/doc`, and tests against a temporary git repository with an `origin/main` built from `fixtures/` (acme initiatives, including one invalid map and one without a status).
2. Plans tab: list, filters, sort, inspector, URL state and the ready signal.
3. Overview reader: brief tabs, Map layout, file tree, outline, links between documents, and Recently viewed.
4. PR badges, plus ghost rows if kept.
5. ⌘K, prompts, README section, and the AGENTS.md layout table.

## Left out on purpose

- `.tickets/`, linked-ticket evidence, the dependency graph, and "Check status".
- The board view and all editing (status, phase, next action, depends_on).
- Initiatives that exist only in a worktree, with no PR yet.
