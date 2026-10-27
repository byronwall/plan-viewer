// Per-workspace preferences, read from `<planning root>/viewer.config.json` and merged over these defaults.
// Shared by the server (which loads the file) and the browser (which fetches /api/config before rendering).
export const DEFAULT_CONFIG = {
  // Browser tab and startup banner.
  title: "Plan Viewer",
  // Name used in agent prompts ("<user>'s commentary").
  user: "User",
  port: 4173,
  // Folders under daily/, tasks/, plans/ or reference/ the library and lint skip (generated corpora).
  exclude: [],
  // People the identity index can't join on its own: [{ names, emails, github, avatar }], so every avatar matches.
  people: [],
  github: {
    // `owner/<repo>` for every reference below.
    owner: "",
    // Repository a bare `#1234` or bare commit SHA belongs to; empty leaves them as text.
    defaultRepo: "",
    // Repositories written as `<repo>#1234` or `<repo>@<sha>` in documents (matched case-insensitively).
    repos: [],
  },
  // Issue keys such as `ABC-123`: { prefix, service: "linear" | "jira" | other, url: "https://…/{id}" }.
  // Linear and Jira keys also get titles and states through the Linear key and `acli`.
  trackers: [],
  code: {
    // Tracked repositories for the Code page; the gear menu edits this file.
    reposFile: "reference/code-repos.json",
    // Where a repository named in a document (`<repo>@abc1234`) is looked for when it isn't tracked.
    checkoutsDir: "~/repos",
    // Local PR review notes, one Markdown file per PR.
    prNotesDir: "plans/pr-notes",
    // Commands for the worktree open buttons; `{path}` is the worktree.
    editor: ["/usr/bin/open", "-n", "-b", "com.microsoft.VSCode", "--args", "{path}"],
    terminal: { label: "Terminal", command: ["/usr/bin/open", "-a", "Terminal", "{path}"] },
    // Review skills drafted against a PR; each lives under the repo's `.claude/skills/<id>/`. `icon` names a built-in icon.
    // An open "Discuss" prompt always follows them.
    prSkills: [],
    // Skill file the "Post as review" notes prompt follows; empty asks the agent to post without one.
    postNotesSkill: "",
    // Skill the Plans tab's Update and Retire drafts name (an initiative-planning skill); empty leaves it out.
    planSkill: "",
    // Opens a PR preview from a repo that has every `requires` file; `{number}` is the PR. null hides the button.
    prPreview: null,
    // Starts a local server in a worktree from repos that have every `requires` file: { requires, command, worktree }.
    // `worktree` (run in the repo, `{branch}` filled) checks out a PR that has no worktree yet. null hides the button.
    run: null,
  },
  issues: {
    // JQL for the Issues page; empty hides the page. Read through `command` (acli), already signed in.
    jql: "",
    command: ["acli"],
    // Labels that mark machine-made issues (security scanners and the like), hidden until the bot toggle shows them.
    hideLabels: [],
    // The triage queue: issues in these statuses, plus open issues with a label starting with a `labels` prefix
    // (a migration's review label, say).
    triage: { statuses: ["Needs Triage"], labels: [] },
    // Agent drafts for issues: { id, label, icon, prompt }; the issue list follows the prompt. "Discuss" always follows.
    skills: [],
    // Folder the drafts open in (the repository the issues are about); empty uses the planning workspace.
    workspace: "",
    refreshMinutes: 5,
    // Site-specific custom field ids: { start, confidence, statusUpdate, epicLink }.
    fields: {},
    // Linear teams (by key) whose issues and projects sit beside the Jira ones, read with the Linear API key.
    linear: { teams: [] },
    // true reads the GitHub issues of every repository the Code page tracks, through `gh`.
    github: false,
  },
};

const merge = (overrides = {}) => ({
  ...DEFAULT_CONFIG,
  ...overrides,
  github: { ...DEFAULT_CONFIG.github, ...overrides.github },
  code: { ...DEFAULT_CONFIG.code, ...overrides.code },
  issues: { ...DEFAULT_CONFIG.issues, ...overrides.issues, triage: { ...DEFAULT_CONFIG.issues.triage, ...overrides.issues?.triage }, linear: { ...DEFAULT_CONFIG.issues.linear, ...overrides.issues?.linear } },
});

let current = merge();
let references = null;

export function setConfig(overrides) {
  current = merge(overrides);
  references = null;
  return current;
}

export const config = () => current;

// The Issues page shows when any source is configured: a Jira scope, Linear teams, or GitHub issues.
export const issuesOn = () => Boolean(current.issues.jql || current.issues.linear?.teams?.length || current.issues.github);

export const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Lookup tables and regex sources for document references, rebuilt when the config changes.
export function referenceConfig() {
  if (references) return references;
  const { github, trackers } = current;
  const repos = Object.fromEntries([github.defaultRepo, ...github.repos].filter(Boolean).map((name) => [name.toLowerCase(), name]));
  references = {
    owner: github.owner,
    defaultRepo: github.defaultRepo,
    repos,
    // Never empty, so the regexes it joins still compile; `(?!)` matches nothing.
    repoNames: Object.values(repos).map(escapeRegExp).join("|") || "(?!)",
    ownerPattern: github.owner ? `(?:${escapeRegExp(github.owner)}/)?` : "",
    trackers: trackers.filter((tracker) => /^[A-Z][A-Z0-9]*$/.test(tracker.prefix)),
    defaultSlug: github.owner && github.defaultRepo ? `${github.owner}/${github.defaultRepo}` : "",
  };
  return references;
}

export const githubSlug = (repo) => `${current.github.owner}/${repo}`;

// The desktop agent every handoff opens in, chosen in the library rail and kept per browser.
export const AGENTS = { codex: "Codex", claude: "Claude" };
export function agentApp() {
  try { return AGENTS[localStorage.getItem("code-agent-app")] ? localStorage.getItem("code-agent-app") : "codex"; } catch { return "codex"; }
}
export const agentName = () => AGENTS[agentApp()];
export function setAgentApp(app) {
  try { localStorage.setItem("code-agent-app", app); } catch {}
}
