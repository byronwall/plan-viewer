# Plan Viewer

A local reading desk for a Markdown planning workspace: daily plans, file-backed tasks with work breakdowns and agent-ready next actions, topic documents, and a Code page for the worktrees, pull requests, and diffs those plans touch. Markdown stays the source of truth; the viewer reads it, links it, and hands work to Codex or Claude Desktop as editable drafts.

It runs on Node.js 22.6+ (type stripping is enabled by the CLI; a `pnpm install` copies `file:` dependencies into `node_modules`, where Node refuses to strip types, so install with `npm`) with no dependencies. The agent handoffs, Finder, editor, and terminal actions assume macOS.

## Quick start

Try it on the bundled fixtures:

```bash
npm run demo
```

Use it with a planning workspace (any folder or Git repository laid out as below). In the workspace's `package.json`:

```json
{
  "private": true,
  "type": "module",
  "devDependencies": { "plan-viewer": "file:../plan-viewer" },
  "scripts": {
    "viewer": "plan-viewer serve",
    "lint": "plan-viewer lint",
    "links": "plan-viewer links",
    "move": "plan-viewer move",
    "task": "plan-viewer task",
    "prepare": "git config core.hooksPath node_modules/plan-viewer/hooks"
  }
}
```

Then `npm install` and `npm run viewer`. Every command treats the current directory as the workspace; set `PLANNING_ROOT` to point elsewhere. The shipped pre-commit hook lints staged planning Markdown and checks links.

| Command | Does |
| --- | --- |
| `plan-viewer serve` | Starts the viewer at `http://127.0.0.1:<port>` (`PLAN_VIEWER_PORT` overrides the config). |
| `plan-viewer lint [paths…\|--staged]` | Checks task front matter, work breakdowns, and action references. |
| `plan-viewer links [--fix\|--warm\|--refresh-slack]` | Reports broken document links, unknown tasks, unlinked task assets, and unnamed Slack channels. |
| `plan-viewer move <from> <to\|TASK-NNNN>` | Moves a file and repairs every link to it. |
| `plan-viewer task TASK-NNNN` | Prints compact task context for an agent. |

## Workspace layout

The folder conventions are the viewer's content format:

```text
daily/YYYY/MM/DD/plan.md     # the day's schedule; "## Scheduled tasks" links tasks
daily/YYYY/MM/DD/done.md     # what got done
daily/YYYY/MM/DD/*.md|.txt   # optional day notes
tasks/TASK-0001.md           # one task: front matter, outcome, ## Work breakdown, ## Next actions, ## Updates
tasks/TASK-0001-assets/      # documents and images owned by that task
plans/<topic>/               # cross-day topics (plans/README.md indexes them)
reference/                   # stable reference documents
reference/retired-tasks.md   # optional: "- TASK-0007" lines for IDs removed on purpose
reference/slack-channels.md  # optional: "- C0123: #channel" names for Slack links
viewer.config.json           # optional preferences, below
config.toml                  # optional, git-ignored secrets: [linear] API_KEY, [slack] TOKEN
```

`fixtures/planning/` is a small working example, including task front matter.

## Configuration

`viewer.config.json` at the workspace root holds everything that differs between people and teams. Every key is optional; missing keys fall back to the defaults in `public/config.js`. Restart the viewer after editing it.

```json
{
  "title": "Daily Plan Viewer",
  "user": "Alex",
  "port": 4173,
  "exclude": ["reference/linear"],
  "github": { "owner": "acme", "defaultRepo": "atlas", "repos": ["Orbit", "orbit-templates"] },
  "trackers": [
    { "prefix": "ATL", "service": "linear", "url": "https://linear.app/acme/issue/{id}" },
    { "prefix": "OPS", "service": "jira", "url": "https://acme.atlassian.net/browse/{id}" }
  ],
  "code": {
    "reposFile": "reference/code-repos.json",
    "checkoutsDir": "~/repos",
    "prNotesDir": "plans/pr-notes",
    "editor": ["/usr/bin/open", "-n", "-b", "com.microsoft.VSCode", "--args", "{path}"],
    "terminal": { "label": "Terminal", "command": ["/usr/bin/open", "-a", "Terminal", "{path}"] },
    "prSkills": [{ "id": "code-review", "label": "Review", "icon": "review" }],
    "postNotesSkill": "~/.agents/skills/post-github-review-notes/SKILL.md",
    "prPreview": { "requires": ["all.ts"], "command": ["bun", "all", "pr", "{number}"] }
  }
}
```

| Key | Meaning |
| --- | --- |
| `title` | Browser tab title, startup banner, and the name agent handoffs give the viewer. |
| `user` | Name used in agent prompts ("Alex's commentary"). |
| `port` | Default port. |
| `exclude` | Folders under the four content roots that the library, watcher, and lint skip, such as a generated issue export. |
| `github.owner` | GitHub owner for every PR and commit reference. Empty disables PR and commit links. |
| `github.defaultRepo` | Repository a bare `#1234` or bare commit SHA means. Empty leaves them as text. |
| `github.repos` | Other repositories written as `Orbit#1234` or `Orbit@abc1234` (case-insensitive). |
| `trackers` | Issue keys: `prefix` (uppercase), `service`, and a `url` with `{id}`. Keys for `linear` and `jira` also get titles and states, through the Linear API key and `acli`. |
| `code.reposFile` | Tracked repositories for the Code page; the gear menu writes it. |
| `code.checkoutsDir` | Where a repository named in a document is found when it isn't tracked. |
| `code.prNotesDir` | Local PR review notes, one Markdown file per PR. |
| `code.editor`, `code.terminal.command` | Commands for the worktree buttons (`E`, `X`); `{path}` is the worktree. |
| `code.prSkills` | Review skills drafted against a PR (`1`…`N`). Each `id` is a skill under the repository's `.claude/skills/`; `icon` names a built-in icon. An open "Discuss" prompt always follows. |
| `code.postNotesSkill` | Skill the "Post as review" notes prompt tells the agent to follow. |
| `code.prPreview` | Preview button for repositories containing every `requires` file; runs `command` with `{number}`. `null` hides it. |

Credentials stay with their tools: `gh` for GitHub, `acli` for Jira, `LINEAR_API_KEY` or `[linear] API_KEY` in `config.toml`, and `SLACK_TOKEN` or `[slack] TOKEN`. Link titles are cached in the workspace's ignored `tmp/` folder.

## Using the viewer


Run `npm run viewer` in the workspace, then open `http://127.0.0.1:4173` (or the configured `port`). The viewer opens today's plan, presents milestones and Markdown sections as work cards, and can load a complete card plus commentary into a new Codex draft for review. The Tasks route lists unfinished repository tasks separately and opens each through the normal document reader and Codex draft flow. Task links in plans render current summary metadata from the authoritative task file. The Weeks route shows a five-week calendar where each day lists the tasks its plan scheduled (✓ when that day's done log mentions them), falls back to milestone headings for older plans, counts done outcomes and extra notes, and collapses empty weeks. Topics and Reference have their own list pages.

Press `T` to return to today’s plan. Press `C` while hovering over a work card or action to open its Codex prompt; outside those targets, `C` opens a global draft. `D` opens a draft for the current file, `A` opens Tasks, `W` opens Weeks, and `J` / `K` move to the next / previous document section. `⌘K` (or `Ctrl+K`) and `/` open document search in an overlay (`⌘K` works over the PR overview too, and opening a document from there closes the overview), with arrow keys to select a result and Enter to open it. Search matches titles, paths, and task metadata without filtering the sidebar. With no query, the palette leads with open PRs that need your review and your own open PRs. A PR number (`1938`, `#1938`, or `Orbit#27`) or words from a PR title, branch, or author list matching pull requests from tracked repositories, open or closed, above documents. Enter opens the PR overview and `⌘Enter` opens the PR on GitHub. The highlighted PR is fetched in the background, so the overview usually opens instantly. `H` (or the clock button in the bottom-right corner) opens **Recently viewed** from anywhere, including over the PR overview,, every page and PR or worktree overview this browser has shown: `↑`/`↓` and Enter, or `1`–`9`, go back to one and reopen its overview. Closing an overview also shows a toast with **Reopen**. Press `?` (`Shift+/`) or click **Keyboard shortcuts** for the full guide. Letter shortcuts pause in typing fields and open dialogs. Escape closes overlays; a Codex draft containing text stays protected until opened or explicitly canceled.

The viewer is local-only and dependency-free beyond Node.js and Codex Desktop on macOS. It watches authored Markdown under `daily/`, `tasks/`, `plans/`, and `reference/` and refreshes the active document and library in place when those files change. It omits folders listed under `exclude` in `viewer.config.json` (such as a generated issue corpus) from the document rail and live watcher. Opening a draft uses the native `codex://threads/new?prompt=…` handoff in the workspace's Codex project, but never submits it. Review or edit the prepared message in Codex Desktop and click Send there when it is ready. The server prints structured `codex-dispatch` logs for validation, draft opening, and failures. Press Enter in the viewer feedback field to open the draft; use Shift+Enter for a new line.

## Code dashboard

The Code route (`G`, `?view=code`) is a control center for the repositories listed in `reference/code-repos.json` (`code.reposFile`); add or drop one from the gear menu beside the agent toggle. Summary tiles across the top (live today, uncommitted, review requested, my PRs with failing CI, open PRs, safe to remove) jump to the matching filter, and a 30-day activity strip filters worktrees to a day when clicked. Selecting a row opens a detail pane with commits, changed files, ignored hand-made files, reviewers, and every action. `J`/`K` or the arrow keys move, `Enter` or a double-click opens the overview for a worktree or PR (or a commit's diff), `E` opens the worktree in the configured editor (`code.editor`, VS Code by default), `X` opens the configured terminal (`code.terminal`), `S` starts a new agent session, `Y` copies the path or link, `1`–`N` draft a configured review skill, and the key after them drafts an open **Discuss** prompt about the PR for you to finish, and `F` focuses the filter.

- **Worktrees** lists every worktree newest first, by the latest of its creation, last commit, and uncommitted edits, grouped by day, week, and month, with a recency dot, ahead/behind counts against main, PR and CI state, click-to-copy paths, and icons for the editor, terminal, Finder, a new agent session, and the branch on GitHub.
- **Pull requests** lists every open PR with CI, review decision, comments, labels, conflicts, size, and author. Filter by All / Review requested / Mine / Others, drafts, or failing CI, and sort by updated, oldest, or largest. The icons draft the review skills configured under `code.prSkills` in Codex or Claude Desktop (toggle at top right), in the PR's worktree when one exists and the main checkout otherwise. Drafts wait for you to press Enter; Claude asks once to trust a folder opened this way.
- **Cleanup** sorts worktrees into safe to remove (clean, with a merged or closed PR, a branch merged into main, or never used), review first (clean, no PR, idle two weeks), too new, and keep. "Skip if touched within" keeps worktrees created or touched in the last day or week out of the removable groups. Remove runs `git worktree remove` in small batches with a progress bar; it keeps branches and git refuses dirty trees. Agent review drafts a prompt that checks the selected worktrees first.

The **PR overview** (from ⌘K, `Enter` on a PR, or **Open PR overview**) is a full-screen overlay: the PR's state, CI, author, branch, review actions, stack (click any row), and reviewers on the left; **Description**, **All changes**, and each commit to walk (`N`/`P`); then the changed files and the diff. **One file** steps through files with `J`/`K`; **All files** (`V` toggles) stacks every file in one scroll, rendering each as it nears view and holding files over 1,500 changed lines behind a click. **Viewed** checkboxes work like GitHub's: `X` marks the current file viewed and moves to the next unviewed one, the header counts progress, viewed files collapse in **All files**, and a file that changes afterwards comes back unviewed (stored per browser). Lockfiles, snapshots, and vendored or minified files start collapsed; the chevron toggles any file. `/` filters the file list, and viewed files drop out of the list and `J`/`K` by default; `U` (or the count beside the filter) shows them again. Once every file is viewed the whole list returns, with "All N files viewed." under it. `S` switches split/unified. **Map** (beside the filter, or `T`) swaps the file list for a treemap of the change: folders as nested boxes, each file sized by its line count (from a local clone; lines changed otherwise) and filled from the bottom by its changed share in green and red, added files green, deletions hatched red, and each rename left as a hatched ghost at its old path. The **Moved** row lists renames bundled by folder (`docs/ → client/ 13`); hovering one, or a renamed tile, outlines its old and new folders and fades the rest, and clicking pins it. **Edges** (`E`) adds a ribbon per move. Hover a tile for its old path, status and line counts; click it to open its diff; click a folder label or breadcrumb to zoom (`Backspace` zooms out). The copy and download buttons export the map at the current zoom as a titled PNG, ready to paste into a PR. Expand (`F`) lifts the map over the whole overview in a frame you can resize from its bottom-right corner, so **Copy image** captures the shape you choose; `F` or `Esc` shrinks it back. Where the browser blocks image copying, the PNG downloads instead. In a stacked PR, `[` and `]` move to the PR below and above in the stack. **Whole stack** (beside All changes) shows one diff for the entire stack, from the bottom PR's base branch to the top PR's branch; notes stay per PR, so they can't be added there. `D` cycles the views above the commits (Description and All changes, or Local files, All changes and Uncommitted for a worktree), and `⇧D` jumps to a PR's description. Changed words inside a changed line or paragraph get a darker mark, and syntax colors come from both whole files (PR diffs included), so a docstring or comment that opens above a hunk stays shaded as one. Changed lines show their indentation and trailing whitespace as faint dots (spaces) and rules (tabs), and a change that only re-indents gets a lighter mark. On a PR, select code and press `C` (or click **Comment**), or click or drag down the line numbers, to keep a local note in `plans/pr-notes/` (`code.prNotesDir`); notes appear under the code they cover and in the PR column, where **Post as review** and **Work through** draft agent prompts over the draft notes . The open PR is kept in the URL (`?pr=owner/repo#n`), with the current file (`&file=`) and commit or other scope (`&scope=`), so a refresh reopens the same view.

The **worktree overview** (`Enter` on a worktree, **Open worktree overview**, or **Worktree overview** from a PR that has a local worktree) browses a worktree like a PR in the same overlay. The left column shows the path, ahead/behind, the branch's PR (click to open its overview) with review skills, and the worktree actions. **All changes** is everything since the fork point, committed or not, plus new files, measured against the PR's base branch when the worktree has an open PR (so a stacked branch matches its PR) and against main otherwise. **Uncommitted** and each commit follow. **Local files** lists what no commit carries: untracked files and folders, and hand-made ignored files (dependency and build caches are left out), with size and age. Folders expand to their files; an untracked file opens in its diff, and an ignored one opens read-only in place (Markdown rendered, up to 2 MB). The URL keeps `?wt=<path>`.

Dirty checks, CI, and PR history take about 15 seconds and load in the background; the refresh icon forces a rescan. Each PR's details and diff are cached on the server until the PR's updatedAt changes. Open PRs, PR history, and CI are cached in `tmp/code-cache.json`, so the Code page and ⌘K answer immediately after a restart. The server refreshes them every 10 minutes, and a request that finds the open-PR list more than a minute old returns the cached list and refreshes it in the background.

## Executable next actions

Each task's `## Next actions` contains short action headings and fenced `prompt` blocks. Write each prompt so an agent can advance one bounded step with the supplied repository context and a clear result to verify. An optional `Work item: W1.1` links it to the task's work breakdown. The viewer also gives existing bullet actions individual buttons.

Click **Prepare action**, review the prompt, add optional context, and click **Open in ChatGPT**. The viewer uses the existing desktop handoff with a prepared, editable draft; review it and click Send there. The action prompt and absolute source file path are included. Additional context is optional; when given, it appears above the stored prompt and takes precedence where they differ. The server rechecks the source action and its readiness before opening the draft, rejecting changed or blocked actions. This local handoff expects an agent with access to the planning workspace.

Daily plans show **Next steps** from tasks linked under **Scheduled tasks**, with one available action per task and its remaining actions under a disclosure. Completed, waiting, and deferred tasks are omitted. A plan can also contain its own `## Next steps` action prompts for day-specific work. Task actions stay in their task files.

Use `## Work breakdown` to record the full known scope as nested bullets:

```markdown
- W1: Deliver the outcome [open]
  - W1.1: Reproduce the behavior [completed]
  - W1.2: Implement the fix [open] (after: W1.1)
  - W1.3: Verify the result [open] (after: W1.2)
```

IDs are unique within the task. Statuses are `open`, `active`, `waiting`, `deferred`, and `completed`. Nesting describes the scope; `after` describes prerequisites. The viewer shows the hierarchy and a scrollable graph with arrows from prerequisite to dependent. Ready graph nodes with a linked action open the same context dialog. Missing dependencies, duplicate IDs, and cycles produce warnings; actions linked to unresolved dependencies cannot start.

Run `npm run lint -- tasks/TASK-0001.md` after authoring or updating a planning document, or `npm run lint` to check the full authored corpus. It rejects invalid task front matter, work-breakdown warnings and action references to missing work items using the viewer's parsers. Point the workspace at the shipped pre-commit hook (see Quick start). The hook validates the staged contents of changed planning Markdown files, so a corrected working copy cannot hide an invalid staged version. Valid work that is waiting on prerequisites passes lint.

Tasks and daily plans can record related conversations under `## Chats` using ordinary labeled Markdown links. The viewer shows recorded chats above the document, in the selected task's detail pane, and alongside task references in daily plans. ChatGPT conversation links open in the browser; `codex://threads/<thread-id>` links open the existing chat in Codex Desktop. Keep links in the authoritative task so daily plans pick them up without copying them. The viewer recognizes conversation links elsewhere in the prose too, while ignoring fenced prompts and inline code examples.

Viewer handoffs ask the receiving agent to record its verified conversation URL or thread ID when available, and the workspace's AGENTS.md can give agents the same convention. The new-draft handoff does not return a thread ID, so the viewer cannot automatically know the resulting conversation. An agent with trusted session identity can save it; otherwise paste the conversation's actual URL into `## Chats`. Shared snapshot URLs do not provide a place to send follow-up commentary and are not shown as related chats.

Documents get a clickable breadcrumb (task list, day switcher, parent document, or copy target) and a sticky bar with a Codex draft button and panels for next actions, the work breakdown, updates, outgoing links grouped by source, and backlinks. Standalone `TASK-0001` references, PRs (`#1810` in `github.defaultRepo`, `Orbit#2738` for a repository in `github.repos`), tracker keys such as `ATL-2845` (from `trackers`), slash lists such as `TASK-0016/0017` or `ATL-2733/2734`, commit SHAs (`Orbit@052702c8`, or bare SHAs inferred from the paragraph's PR references), and Slack permalinks become icon links; Slack links open in the desktop app. Titles and states for GitHub, Linear, Jira, and Slack come from `gh`, `acli`, the Linear key, and an optional `[slack] TOKEN` in `config.toml`, cached in the ignored `tmp/link-metadata.json`. Slack channel names come from that token or from `reference/slack-channels.md`. Run `npm run links` to check for broken document links and unknown tasks (`--fix` lists new Slack channels, `--warm` prefetches titles, `--refresh-slack` updates listed and newly linked channel names using `SLACK_TOKEN` or `[slack] TOKEN`); 
