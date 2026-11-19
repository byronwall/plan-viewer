# Workspace layout on disk — implementation plan

## Plan at a glance

1. Shared path module and the migrate command, proven on a temp copy of the demo.
2. Switch every reader to the new layout in one PR, with the demo and fixtures converted by migrate itself.
3. Migrate `~/Projects/planning` (after Byron says go).
4. Retire this initiative.

Migrate comes first because it is the one piece that must understand both layouts. Once it converts the demo cleanly, the reader switch is a mechanical change checked by the existing tests.

## Implementation strategy

- **Seam:** `public/layout.js`, a plain ES module the server (`--experimental-strip-types` imports `.js` fine) and the browser both import. It owns the folder names and the path shapes: `taskFile(id)`, `taskDir(id)`, `taskOfPath(path)`, `dailyFile(date)`, `dateOfPath(path)`, `isViewable(path)`, `CONFIG_FILE`, `ROOTS`.
- **Local loop:** `npm test`, plus `node cli.ts migrate` in a temp copy of `examples/workspace`. No external dependencies.
- **Transition:** no dual support. Migrate reads the old layout with its own small set of old patterns; nothing else ever does.

### Material dependency proof strategy

None. Git is the only tool migrate calls (`git mv`, `git status`), and tests run it in a temp repository the way `plans.test.ts` already does.

## Milestone 1: migrate converts the demo workspace

- Add `public/layout.js` with the new path helpers (not yet used by readers).
- Add `migrate.ts` and the `migrate` subcommand in `cli.ts`, plus a `migrate` script in the workspace `package.json` template.
  - Plan moves: task file into `tasks/TASK-NNNN/`, `-assets/*` beside it, `daily/Y/M/D/plan.md` to `daily/Y-M-D.md`, `plans/**` to `reference/**` (`plans/README.md` to `reference/topics.md`), `reference/*.json`, `slack-channels.md`, `retired-tasks.md` and `viewer.config.json` into `config/`.
  - Fix first: dirty tree, targets that exist, assets without a task file, extra files in a day folder, files under `plans/` that clash with `reference/`.
  - Rewrite: relative Markdown links and images, and root-relative repository paths, in every moved or unmoved `.md`; `code.reposFile` and `code.prNotesDir` values.
  - Verify: every relative link that resolved before still resolves.
  - Leftovers: list lines in `AGENTS.md`, `CLAUDE.md`, `package.json`, `scripts/**` that still name old paths.
- `migrate.test.ts`: copy `examples/workspace` into a temp git repo, dry run (exit 0, move list), `--write`, then assert the tree, three sample links, and the leftover report; a second case with an orphan assets folder exits 1 with its hint.

### Desired end state

`node cli.ts migrate --write` turns a copy of the demo into the new layout with every link resolving. Readers are unchanged, so nothing else moves yet.

## Milestone 2: the viewer and checks read only the new layout

- Run migrate on `examples/workspace` and `fixtures/planning` and commit the result.
- Replace hard-coded paths with `public/layout.js` in `server.ts`, `check-planning.ts`, `check-links.ts`, `move-doc.ts`, `steps.ts`, `outbound.ts`, `task-context.ts`, `init-workspace.ts`, `code-dashboard.ts`, `pr-notes.ts`, `public/config.js`, `public/app.js` (breadcrumbs, Documents panel, world, diagrams).
- Read `config/viewer.json`; defaults `code.reposFile: config/code-repos.json`, `code.prNotesDir: reference/pr-notes`.
- Remove the Topics page and `plans` group; update the ⌘K pages list and the shortcut hint.
- Lint on an old-layout workspace reports one error: run `plan-viewer migrate`.
- Update `docs/guide.md`, `docs/configuration.md`, `examples/workspace/AGENTS.md`, `AGENTS.md`, README layout lines; regenerate screenshots that show paths.

### Desired end state

`npm test` is green on the migrated fixtures, `npm run demo` shows tasks, daily plans, reference and diagrams from the new folders, and `grep -- '-assets'` finds nothing outside migrate and its test.

## Milestone 3: Byron's workspace is migrated

Ask Byron first. Then in `~/Projects/planning`: run `npm run migrate`, fix the "Fix first" list, `--write`, fix leftovers in `AGENTS.md` and `scripts/`, run `npm run lint` and `npm run links`, and open the viewer. Byron commits, or says to.

### Desired end state

Byron's viewer on 4173 shows his workspace from the new layout with clean checks.

## Cross-cutting verification

Browser check of the demo after Milestone 2: Today, a task with diagrams, a task document breadcrumb, the Reference page, and the Steps page.

## Open decisions and spikes

None open. If the link rewrite cannot handle a link form, migrate lists it under Fix first instead of guessing.

## Retire this initiative

The PR after Milestone 3 moves lasting facts into `docs/guide.md` and removes `docs/intent/workspace-layout/`.

## Below the cut line

- Moving `tmp/` caches.
- Rewriting stored favorites or recents, and redirects for old `?path=` links.
- A slug in task folder names.
- Rewriting leftover text in scripts automatically.
