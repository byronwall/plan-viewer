# Code view: intent and principles

The Code view (`?view=code`) covers worktrees, pull requests, commits, cleanup, and the PR and worktree overviews. Its behavior is in the README's "Code dashboard" section. This document records why it exists and the rules it was built by, so new surfaces, starting with Jira issues ([issues-plan.md](issues-plan.md)), can follow them.

Sources: Byron's own words from 34 Claude Code sessions in `daily-planning` and `plan-viewer` (Oct 13–21, 2026), and the `daily-planning` git history from when the viewer lived in `viewer/`. Codex threads held almost nothing about this view. Quotes are verbatim, with their dates.

## The problem it solved

By mid-October Byron was landing stacks of ten or more PRs per issue across many worktrees. Each review, cleanup, or agent launch meant jumping between GitHub, the terminal, VS Code, and the agent apps. In his words: "I'm doing a whole lot of manual wrangling and it's driving me crazy." (Oct 15)

The answer was a single surface: "what I really need is almost like a control center" and "a one-stop shop so that I can see everything that's going on without having to jump into other places" (Oct 15).

## How it was built

Most of it was built in two days, then refined.

| Date | What arrived |
| --- | --- |
| Oct 13–14 | Link icons and cached titles for GitHub, Linear, Jira, and Slack, because a bare "Jira issue" preview "is not that helpful". A fixed-height ⌘K palette. |
| Oct 15 | Code dashboard: worktrees newest first, every open PR on tracked repos, a cleanup tab, and one-click agent review drafts. Then a 10x pass and a de-slop pass, summary tiles, the 30-day activity strip, the detail pane, CI/review/label/size data from one lean GraphQL query, and stacked PRs on a subway rail. The Commits tab across all local branches arrived the same day, with a split/unified diff overlay, folder tree, whole-file syntax highlighting, and SHA hover cards. It also got `data-code-state` ready signals for agents. |
| Oct 16 | PR numbers in ⌘K backed by `tmp/code-cache.json` (stale-while-revalidate). The PR overview overlay, opening in about 25 ms. The worktree overview. Viewed marks and the file filter. Local review notes with "Post as review" and "Work through". Whole-stack diff and `[` / `]`. Recently viewed (`H`) and the Reopen toast. The change-map treemap with PNG export. |
| Oct 18–19 | Split into this repository, with every person- or team-specific value moved into `viewer.config.json`. |
| Oct 20 | `R` rescans, author filter and one author mark, "Requested" review state that ignores bots, prompts that name the skill, a per-repo Claude environment, and the inspector rebuilt from the overview's components. |

## Principles

Each principle below comes from repeated steering, not a one-off remark.

### See everything, newest first, then slice

- "I always want most recent stuff at the top. That way I can see the things that were live." (Oct 15)
- "I want to see all PRs. I want to have good filtering capability. That way I can slice and dice." (Oct 15)

Lists show everything in scope by default, sorted by recency and grouped by day, week, and month. Summary tiles and filters narrow the list. They do not hide data behind navigation. Filters are counts you click, and the filter state lives in the URL.

### Dense, but contained

- "pack in as much functionality as possible, as much data, as much visualization, as much just sort of like at my fingertips as I can handle." (Oct 15)
- "the content we have available here just does not need to be this big … really what I was wanting was narrower." (Oct 15)

Byron uses a very large monitor. Density means more facts per row and per pane, not wider tables. Content keeps a max width, names may wrap to two lines rather than widening a column, and state reads as aligned icons in fixed columns, not words repeated down a table. Approved, draft, and requested are icons with hover text, plus a count where a count adds meaning.

### List, inspector, overview

One shape repeats: a dense list, a detail pane for the selected row, and a full-screen overview opened with Enter or a double-click. The inspector and the overview share components ("as much of the same componentry as possible", Oct 20). The overview sidebar is one label/value grid followed by icon rows of actions. Making a click open the overlay directly was rejected ("just unhelpful", Oct 15). Selecting a row inspects it, and opening the overview is a deliberate second step.

### Keyboard first, everywhere

- "I had to use the mouse to move around for that" (Oct 16, asking for stack keys)
- "I don't want to click the button most of the time." (Oct 16, the stray `C` for a note)
- "`H` and `CMD K` … I want them to always pop on top of everything if summoned." (Oct 16)

Every frequent action has a single letter: `J`/`K` move, `Enter` opens, `E`/`X`/`S` open the editor, terminal, and an agent session, `1`–`N` draft review skills, `[`/`]` step through a stack, `R` rescans. Global keys (⌘K, `H`) work over every overlay. Every icon names its action and key on hover.

### Never lose your place

- "store the actively viewed file in the URL for the code diff so that a refresh is bumpless" (Oct 16)
- "I hit ESC … it disappeared... and I forgot which one it was!" (Oct 16)

The URL holds the open PR, file, and scope. Recently viewed and the Reopen toast recover whatever was just closed. Live refreshes keep scroll position and unsent text.

### Zero layout shift

- "make sure that we don't have any layout shifts or anything else gross going on." (Oct 15)

Reserve space for arriving results, icons, and counts. Fixed-height palettes. Messages that swap in place ("All N files viewed") instead of collapsing a list. Toasts go in a corner, sonner-style, never as banners.

### Instant, but not chatty

- "make that as performant as fast as possible while not just slamming the network constantly with updates." (Oct 16)

The server caches to disk (`tmp/code-cache.json`) and serves stale data while it revalidates in the background. Heavy scans run once and refresh on a 10-minute timer or an explicit `R`. ⌘K prefetches the highlighted PR so the overview opens instantly. Agents wait on `data-*-state="ready"` attributes rather than polling tables.

### Agents do the work, the human sends

- "open the app with the text in there, and then I'm fine with hitting enter to send it, because sometimes I want to make edits." (Oct 15)

The view never acts on GitHub itself. Review skills, "Post as review", "Work through", and cleanup review all open an editable Codex or Claude draft with the PR, branch, and worktree listed as bullets and the skill named explicitly. Only the destructive local action that is safe by construction, `git worktree remove` on clean trees, runs directly, and git refuses dirty trees anyway.

### Signal over noise

- "we should not consider Copilot as a reviewer. That's a bot." (Oct 20)
- "I don't love the solid background color behind the icon. Too much color noise." (Oct 16)

Bots are not people, so they don't count as reviewers or authors. Color carries state, never decoration. There are no left accent borders, no pills except for state, and no nested cards.

### Visual summaries for big changes

- "187 total files that changed … what I'd really like to get is some sort of visual overview." (Oct 16)
- "My goal here is to be able to quickly copy an image that reflects what changed in the PR." (Oct 16)

When a list gets too long to read, add a picture of its shape: the subway rail for stacks, the treemap for changes. The picture should be interactive (hover, click to open, zoom) and exportable. Edges must not cut through content.

### Diff first, render on demand

"I want consistent diffs on first open. I will render when I am interested in that." (Oct 15) The view shows the raw source of truth by default and offers a rendered view as an option.

### Generic by configuration

"I've built a really nice viewing platform (especially the `code` page) and I really want to make it available elsewhere." (Oct 19) Names, repos, skills, editors, and environments live in `viewer.config.json`, with neutral defaults.

## Rejected along the way

- Words where an icon fits ("local worktree"), and status words repeated down a column.
- Variable-width or wrapping branch names, and a separate copy-branch icon. Branch names are one line and click to copy.
- Pills that break a row's line, controls that overflow a table, and giant controls for minor settings.
- A "mine / others" toggle. An author picker replaced it.
- Rendered Markdown as the first view. Unified-only diffs.
- Syntax colors inside comments. Comments are shaded as a unit.
- Treemap arrows that cut through tiles. Bundled ribbons replaced them.
- Banner toasts.
- Agent prompts that say "shakedown" without naming the skill file.

## Deferred or still open

- GitHub comments inside the PR overview ("OK with excluding the GH comments for now", Oct 16).
- A dependency view beside the change map.
- A wide-screen commit layout with the file list and diff side by side.
