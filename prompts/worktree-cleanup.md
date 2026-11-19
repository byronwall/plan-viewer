---
title: Worktree cleanup
sent: Clean up on selected worktrees (Code page)
---

Help me clean up old git worktrees in {repo}. I have far too many and want to remove the ones that hold nothing I need.

Candidates:
{candidates}

For each candidate, check for uncommitted or untracked changes, commits not on any remote branch (`git log <branch> --not --remotes`), stashes, and ignored local files that look hand-made rather than generated (notes, .env overrides, scratch scripts). Follow this repository's own worktree instructions if it has any. Remove a worktree with `git worktree remove <path>` (never --force) only when it holds nothing unique; keep its branch. Do not delete branches or push anything. Finish with `git worktree prune` and a short table: removed, kept (with the reason), and anything you need me to decide.
