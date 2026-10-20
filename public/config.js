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
    // Claude Desktop environment per tracked repo folder name, e.g. { "app": "app" }; drafts there open in it, not "This computer".
    claudeEnvironments: {},
    // Opens a PR preview from a repo that has every `requires` file; `{number}` is the PR. null hides the button.
    prPreview: null,
  },
};

const merge = (overrides = {}) => ({
  ...DEFAULT_CONFIG,
  ...overrides,
  github: { ...DEFAULT_CONFIG.github, ...overrides.github },
  code: { ...DEFAULT_CONFIG.code, ...overrides.code },
});

let current = merge();
let references = null;

export function setConfig(overrides) {
  current = merge(overrides);
  references = null;
  return current;
}

export const config = () => current;

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
