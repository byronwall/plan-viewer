# Configuration

Every setting is optional. A new workspace usually needs only the first few:

```json
{
  "user": "Alex",
  "github": { "owner": "acme", "defaultRepo": "atlas" },
  "trackers": [{ "prefix": "ATL", "service": "linear", "url": "https://linear.app/acme/issue/{id}" }]
}
```

That turns `#1234`, commit SHAs, and `ATL-12` in your Markdown into links with live titles and states. Add `code` settings when you want the Code view's buttons wired to your editor, terminal, and review skills, and `issues` when you want the Issues page.

## `viewer.config.json`

`viewer.config.json` at the workspace root holds everything that differs between people and teams. Every key is optional; missing keys fall back to the defaults in [`public/config.js`](../public/config.js). Restart the viewer after editing it. [`examples/workspace/viewer.config.json`](../examples/workspace/viewer.config.json) is a working example.

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
    "planSkill": "plan-initiatives",
    "prPreview": { "requires": ["all.ts"], "command": ["bun", "all", "pr", "{number}"] },
    "run": { "requires": ["all.ts"], "command": ["bun", "all", "--ports"], "worktree": ["bun", "all", "worktree", "{branch}"] }
  }
}
```

| Key | Meaning |
| --- | --- |
| `title` | Browser tab title, startup banner, and the name agent handoffs give the viewer. |
| `user` | Name used in agent prompts ("Alex's commentary"). |
| `port` | Default port. |
| `exclude` | Folders under the four content roots that the library, watcher, and lint skip, such as a generated issue export. |
| `people` | People the avatar index can't join on its own: `[{ "names": ["Ada Lovelace"], "emails": ["ada@acme.test"], "github": "ada-acme", "avatar": "https://…" }]`. Every field is optional; `github` picks the GitHub photo and `avatar` overrides it. The index otherwise joins GitHub commit authors, Linear users and, with a Slack user token (`SLACK_TOKEN` or `[slack] TOKEN` in `config.toml`, scopes `users:read` and `users:read.email`), Slack profiles. |
| `github.owner` | GitHub owner for every PR and commit reference. Empty disables PR and commit links. |
| `github.defaultRepo` | Repository a bare `#1234` or bare commit SHA means. Empty leaves them as text. |
| `github.repos` | Other repositories written as `Orbit#1234` or `Orbit@abc1234` (case-insensitive). |
| `trackers` | Issue keys: `prefix` (uppercase), `service`, and a `url` with `{id}`. Keys for `linear` and `jira` also get titles and states, through the Linear API key and `acli`. |
| `code.reposFile` | Tracked repositories for the Code page, as `{ "repos": ["/absolute/path/to/checkout"] }`; the gear menu writes it. Each checkout needs a GitHub `origin` and a signed-in `gh` for PRs and CI. |
| `code.checkoutsDir` | Where a repository named in a document is found when it isn't tracked. |
| `code.prNotesDir` | Local PR review notes, one Markdown file per PR. |
| `code.editor`, `code.terminal.command` | Commands for the worktree buttons (`E`, `X`); `{path}` is the worktree. |
| `code.prSkills` | Review skills drafted against a PR (`1`…`N`). Each `id` is a skill under the repository's `.claude/skills/`; `icon` names a built-in icon. An open "Discuss" prompt always follows. |
| `code.postNotesSkill` | Skill the "Post as review" notes prompt tells the agent to follow. |
| `code.planSkill` | Skill the Plans tab's **Update** and **Retire** drafts tell the agent to use (`/<skill>` in Claude, "the <skill> skill" in Codex). Empty leaves the skill out of the prompt. |
| `code.prPreview` | Preview button for repositories containing every `requires` file; runs `command` with `{number}`. `null` hides it. |
| `code.run` | Run button (`L`) for worktrees and PRs in repositories containing every `requires` file: runs `command` in the worktree as a background local server, shows the first `localhost` URL it prints and its output, and stops it on demand or when the viewer exits. A PR without a worktree is checked out first with `worktree` (run in the repository, `{branch}` filled); without `worktree` only checked-out PRs get the button. `null` hides it. |
| `issues.jql` | Jira scope for the Issues page (`component = Atlas OR project = OPS`). The page hides when this, `issues.linear.teams` and `issues.github` are all empty. |
| `issues.command` | How to run `acli` (default `["acli"]`, already signed in); the fixtures point it at `fixtures/jira/fake-acli.js`. |
| `issues.hideLabels` | Labels of machine-made issues (security scanners) hidden until **Bots** is checked. |
| `issues.triage` | The Triage queue: `statuses` (default `Needs Triage`) plus open issues with a label starting with one of `labels` (a migration's review label). |
| `issues.skills` | Agent drafts against issues (`1`…`N`): `{ id, label, icon, prompt }`; the selected issues follow the prompt as bullets. An open "Discuss" prompt always follows. |
| `issues.workspace` | Folder issue drafts open in (the repository the issues are about); empty uses the planning workspace. Drafts about one tracked GitHub repository's issues open in that repository's checkout instead. Claude drafts open in the Claude Desktop preset whose folder this is. |
| `issues.fields` | Site-specific custom field ids: `start`, `confidence`, `statusUpdate`, `epicLink`. |
| `issues.refreshMinutes` | Minutes between incremental syncs (default 5). |
| `issues.linear.teams` | Linear team keys (`["ATL"]`) whose issues and projects sit beside the Jira ones, read with the Linear API key. With both trackers the page gains a source switch and a Migration tab. |
| `issues.github` | `true` reads the open and closed GitHub issues of every repository in `code.reposFile`, through `gh`. Default `false`. |

Credentials stay with their tools: `gh` for GitHub, `acli` for Jira, `LINEAR_API_KEY` or `[linear] API_KEY` in `config.toml`, and `SLACK_TOKEN` or `[slack] TOKEN`. Link titles are cached in the workspace's ignored `tmp/` folder.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `PLANNING_ROOT` | Workspace to serve or check. Defaults to the current directory. |
| `PLAN_VIEWER_PORT` | Port for `plan-viewer serve`, over `port` in the config. |
| `PLAN_VIEWER_WATCH=0` | Run the server without `node --watch` (it otherwise restarts itself when the viewer's own code changes). |
| `PLAN_VIEWER_DRY_RUN=1` | Validate agent handoffs and log them without opening Codex or Claude. Useful when testing. |
| `LINEAR_API_KEY` | Linear key for titles, states, and the Issues page. `[linear] API_KEY` in `config.toml` works too. |
| `SLACK_TOKEN` | Slack token for message and channel titles. `[slack] TOKEN` in `config.toml` works too. |
| `TZ` | Time zone that decides which day is "today". |
