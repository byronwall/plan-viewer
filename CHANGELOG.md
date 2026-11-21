# planboard

## 0.1.2

### Patch Changes

- abe9a58: Check and repair a missing upstream when opening an existing PR worktree in VS Code.
- 9f4432a: Every open PR without a worktree now offers Check out and Check out and open in VS Code, in any tracked repository, not only ones with a local server command.
- 6ae9b41: The Setup page is now four tabs (Integrations, Settings, Prompts, Files) with one list and an inspector each, a filter that searches every tab, and the selected row kept in the URL.
- c4768a4: Track the matching origin branch when checking out PR worktrees, including existing local branches and repository-specific worktree commands.
- 2dec382: Verify the repository, worktree and upstream for PR checkout and local server actions, and share checkout setup across simultaneous requests.

## 0.1.1

### Patch Changes

- 4fe956f: Planboard installs from npm: run `npx planboard init` in an empty folder, then `npx planboard` to serve it. No clone is needed.
