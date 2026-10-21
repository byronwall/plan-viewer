# Issues view: plan

A Jira issues view for Modeler work, built by the same rules as the Code view ([code-view.md](code-view.md)). It is a dense, keyboard-first, read-only workspace that makes sense of everything going on, with agents doing any writing.

Status: planning. Nothing in this document is built yet.

## Decisions already made (Byron, Oct 21, 2026)

- **Jobs:** all four. A triage queue, an epic and initiative map, the join between issues and code, and a my-work and activity feed.
- **Scope:** `component = Modeler OR project = MOD`, with security-bot tickets hidden by default behind a toggle. The JQL lives in `viewer.config.json`. "Rel app" is the product; Jira has no product field for it.
- **Writes:** read-only. Every change goes through an editable Codex or Claude draft that Byron sends himself.
- **Docs:** live in `docs/`.

## What the data looks like (survey of Oct 21, 2026)

These facts constrain the design. The raw survey outputs are in the session scratchpad and are not kept here.

- **Volume:** 397 RAI issues carry component `Modeler`, and the Jira `MOD` project holds 58 more. Of the 397, 249 are security-bot tickets (labels `security`, `SecSLA`, `grype-cli`, `dependabot`), and 10 of those are open. That leaves about 77 open real issues, 52 of them unassigned. 74 were created in the last 30 days.
- **Statuses:** Needs Triage → Backlog → (Ready for Development) → In Development → In Review → Merged / Closed, each with a `statusCategory` of new, indeterminate, or done.
- **Hierarchy:** Initiative → Epic → Task/Bug → Sub-task, all through `parent`. Parents and children often lack the Modeler component, so the hierarchy has to be fetched by `parent`, not by component. Example: RAI-53201 "Gate the Rel App merge path" has 33 children, 19 open, and its parent is the initiative RAI-52729.
- **No sprints and no story points.** Every board is kanban. Fields in real use are priority, labels, due date, Start date (`customfield_10015`), Confidence (`customfield_10281`, 🟢/🟡/🔴), Greenlight Status (`customfield_10285`), Product Area (`customfield_10279`), the epic status-update text (`customfield_10283`), issue links (Relates, Duplicate, Blocks), and comments.
- **The Linear migration** (Oct 20) left 23 issues labeled `linear-migration-2026-10-20`, each also labeled with its old Linear key in lowercase (`mod-2836`). Their descriptions contain "Source: MOD-NNNN" and a list of PR links. The issues were placed in Backlog for migration review. Jira's own `MOD-1`…`MOD-58` collide with the old Linear `MOD-NNNN` keys.
- **acli limits:**
  - `workitem search --fields` accepts only `key, summary, status, issuetype, assignee, priority, labels, creator, reporter, description`. It returns no dates, parent, links, or custom fields.
  - `workitem view KEY --fields '*all' --json` returns everything, including inline comments with ADF bodies. It takes about 0.75 s per issue, so all 397 take about 43 s at 8 in parallel, about 13 MB.
  - There is no changelog and there are no remote links.
  - Development info (`customfield_10000`) gives only PR counts and state, with no URLs.

## Round 1: overall shape

**Decision:** how the four jobs become screens.

| Approach | Triage throughput (issues decided per minute) | "What's going on" answered at a glance | Reuse of Code view patterns | Navigation between jobs |
| --- | ---: | ---: | ---: | --- |
| A. One Issues page with tabs (Triage, Epics, Mine, Activity) over one cached corpus, list + inspector + overview | 8 | 7 | 10 | Tabs plus the shared URL state; ⌘K jumps to any tab |
| B. A separate page per job | 7 | 5 | 6 | Four routes, four sets of filters to relearn |
| C. Issues as rows inside the Code page, mixed with PRs | 4 | 6 | 7 | Join is free, but triage drowns in PR rows |
| D. Epic tree as the home, with everything else as filters on the tree | 5 | 9 | 5 | Flat queues like triage fight the tree |

- **Choice:** A. It copies the Code page's shape: summary tiles that act as filters, tabs, a dense list, an inspector, and a full-screen overview. The issue overview reuses the PR overview's sidebar grid and icon rows.
- **Why:** reuse and triage throughput. The Code view's list, inspector, and overview pattern is already learned and already liked.
- **Watch:** four tabs can sprawl. Each tab must be a list filter plus at most one extra visual, not a new layout.

## Round 2: data pipeline

**Decision:** how issue data gets from Jira to the browser, given what acli can and can't return.

| Approach | Freshness after an edit in Jira | Cold-start time to a full list | Fields available (parent, dates, links, comments) | Activity history |
| --- | ---: | ---: | ---: | --- |
| A. Full sync: search for keys, then `view '*all'` for each, cached to disk; repeat on a timer | 4 | 3 (≈45 s) | 10 | None unless we diff snapshots |
| B. Search with the minimal fields for the list, and `view` lazily when an issue is selected | 8 | 9 (≈10 s) | 3 in lists | None |
| C. The Jira REST API with a token in `config.toml` | 9 | 8 | 10 | 10 (changelog) |
| D. Hybrid: a disk cache of full `view` payloads. Incremental refresh with `updated >= <last sync>` returns the changed keys, and only those are re-viewed. Each refresh is diffed against the previous snapshot to record field changes. | 8 | 10 warm, 3 the first time | 10 | 6 (only the changes we observe) |

- **Choice:** D. It follows the Code view's "instant but not chatty" rule: a stale-while-revalidate disk cache in `tmp/issues-cache.json`, a 5-minute incremental refresh, `R` to force one, and a `data-issues-state="ready"` attribute for agents to wait on.
  - Parents and children outside the scope are fetched by key and marked as context.
  - Snapshot diffs create the activity feed: status, assignee, priority, and parent changes, plus new comments, each with its timestamp.
- **Why:** both freshness and a full field set, with no new credential. Credentials stay with their tools, the way `gh` and `acli` already handle them.
- **Watch:** the feed starts empty and only knows about changes it saw. Comments carry their own dates, so the feed can backfill them from day one. If observed history turns out too thin, C is the upgrade path; it needs only a token.

## Round 3: joining issues to code

**Decision:** how an issue finds its PRs, branches, worktrees, and commits.

| Approach | Recall on real Modeler PRs | False links | Works for Linear-era issues |
| --- | ---: | ---: | ---: |
| A. Key mentions: `RAI-NNNN` in PR titles, bodies, and branch names, plus commit messages, from the Code cache | 7 | 9 | 3 |
| B. Jira's development field | 4 (counts only, no URLs) | 10 | 2 |
| C. GitHub PR links in the issue description and comments | 5 | 9 | 9 (the migration lists the PRs) |
| D. A + C, with the migration alias map (`mod-2836` label → RAI key), so a PR that says `MOD-2836` joins the RAI copy. B is used only as a "Jira sees N PRs" hint when nothing else matched. | 9 | 8 | 9 |

- **Choice:** D. The join is built on the server from data both caches already hold, and it shows up in both views:
  - The issue overview gets a **Code** block listing the PRs (with state, CI, and stack position), the worktrees whose branch names the key, and the commits that mention it.
  - Each PR row and PR overview gets its issue chip.
  - The same alias map fixes document links: `MOD-2896` in a plan shows its RAI copy's title and state.
- **Why:** recall across both eras of keys.
- **Watch:** a bare `MOD-12` is ambiguous between Jira MOD and Linear MOD. Read it as the Jira key only below the Linear range, and say so in the hover card.

## Round 4: triage

**Decision:** how the triage queue is worked.

| Approach | Issues decided per sitting | Context visible while deciding | Fits read-only + drafts |
| --- | ---: | ---: | ---: |
| A. Kanban board by status | 4 | 4 | 6 |
| B. A table, selecting several rows and sending one bulk agent draft | 6 | 5 | 9 |
| C. A queue walk, like stepping through PR files: the overview shows one issue at a time, `J`/`K` move, `X` marks it seen locally (as Viewed works for PR files), and `1`–`N` draft configured triage skills | 9 | 9 | 10 |

- **Choice:** C, with B's multi-select for the bulk prompt ("triage these 8").
  - The queue is Needs Triage, plus the migration-review backlog (`linear-migration-*` still in Backlog), plus anything unassigned and updated in the last 14 days. It is sorted newest first.
  - Seen marks are per browser and reset when the issue changes, the same way changed PR files come back unviewed.
  - Skills come from `issues.skills` in the config, mirroring `code.prSkills`. Examples: triage, Byronize, start a worktree, and an open Discuss prompt.
- **Why:** the PR file walk is the fastest review loop Byron already has. Triage is the same motion: read, decide, next.
- **Watch:** without writes, "decided" stays local until an agent acts. The seen mark carries that gap, and the next refresh shows the real change.

## Round 5: the epic and initiative map

**Decision:** how the hierarchy and its progress are shown.

| Approach | "What's going on" in one look | Shows dates and slippage | Readable at about 40 epics and 400 tasks |
| --- | ---: | ---: | ---: |
| A. An indented tree: initiative → epic → task rows, each epic with a done/active/open bar, confidence, start and due dates, and the newest status update | 8 | 6 | 9 |
| B. A treemap of initiatives → epics → issues, sized by open work and colored by status (reusing `diff-map.js`) | 9 | 2 | 6 |
| C. A timeline of start → due bars | 6 | 10 | 5 (only 24 issues have start dates) |
| D. A graph of Blocks links | 3 | 2 | 4 (only 59 such links) |

- **Choice:** A as the Epics tab.
  - The epic overview adds a small timeline strip only when its children have dates.
  - B is deferred: it is the "visual summary for big changes" move and can be added once the tree proves the data, since `diff-map.js` already does the layout.
- **Why:** the tree reads at real volume, and dates are too sparse for a timeline to carry the page.
- **Watch:** children outside the component. The tree counts children by `parent`, so an epic's bar reflects all of its work, and rows outside the scope are dimmed.

## Round 6: my work and activity

**Decision:** what the Mine and Activity tabs show.

| Approach | Catches changes I didn't make | Morning catch-up time | Noise from bots and mass edits |
| --- | ---: | ---: | ---: |
| A. Sort by `updated` only | 3 | 5 | 4 |
| B. An activity feed of the observed field changes and comments (from Round 2), grouped by day like Worktrees, with Mine as a filter (assignee, reporter, commenter, or me in `issues.people`) | 9 | 9 | 7 (bot labels filtered, mass edits collapsed into one row) |
| C. Mine only, as a personal queue | 4 | 7 | 9 |

- **Choice:** B. Activity is the default tab after Triage, and Mine is the author/assignee picker from the Code page applied to issues.
  - Daily plans can link `?view=issues&tab=activity&since=YYYY-MM-DD` to show what moved since that day.
- **Why:** it catches changes others made, which is what the morning roundup reconstructs by hand today.

## Resulting feature set

- **Route `?view=issues` (`I`), with tabs Triage, Epics, Activity, All.**
  - Summary tiles act as filters: needs triage, migration review, unassigned, mine, in review, and due within 7 days.
  - The author/assignee picker is shared with Code.
  - A bot toggle (off by default) shows the security tickets.
- **List rows:** key, type icon, priority icon, title (wrapping to two lines), status, assignee avatar, parent epic, a code chip (PR count and state), and the last update, grouped by day, week, and month.
- **Inspector:** the overview's label/value grid (status, type, priority, assignee, reporter, parent, epic, dates, labels, Linear source), icon rows for skills, and the Code block.
- **Overview (`Enter`, `?issue=RAI-NNNN`):**
  - The description, with ADF converted to Markdown for the existing renderer, and comments in order.
  - Links grouped by type, children with progress, and the Code block. Clicking a PR opens the PR overview, and `[`/`]` move to the previous and next sibling under the parent.
- **⌘K:** issue keys and titles alongside PRs. A bare number matches both, and Enter opens the issue overview. Recently viewed includes issues.
- **Agent drafts:** `1`–`N` run the configured issue skills, plus an open Discuss prompt. Each prompt lists the issue key, URL, parent, and linked PRs as bullets and names the skill explicitly.
- **Config (`issues` in `viewer.config.json`):** `jql`, `hideLabels`, `skills`, `refreshMinutes`, and `site`. With no `jql`, the route is hidden.

## Milestones (thin slices, each shippable)

1. **Corpus and list.**
   - Server: `issues-cache.ts` runs the search, the parallel `view`, and the disk cache with incremental refresh.
   - `/api/issues` serves the cache.
   - The All tab has rows, the inspector, the bot toggle, and the ready attribute.
   - A fixture corpus under `fixtures/` (fictional `acme`) for tests.
2. **Issue overview.** ADF to Markdown, comments, links, children, URL state, ⌘K and Recently viewed.
3. **Triage tab.** The queue definition, the walk with `J`/`K`/`X`, issue skills, and the multi-select bulk draft.
4. **Code join.** Key mentions, description PR links, the migration alias map, and chips in both views and in document links.
5. **Epics tab.** The tree with progress, confidence, and dates, with out-of-scope rows dimmed.
6. **Activity.** Snapshot diffs, the comment backfill, the day grouping, and the `since=` link.

Deferred: the epic treemap, direct Jira writes, and the REST/changelog upgrade.
