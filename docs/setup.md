# Set up a planning workspace (for agents)

A person cloned this repository and asked you to set them up. Follow these steps in order. When you finish, the person has their own planning workspace open in the viewer, with today's plan and one real task in it.

Talk to the person as you go. Ask only the questions listed here, and say what each step did.

## 1. Check Node

Run `node --version`. The viewer needs Node.js 22.6 or later. If it is older or missing, stop and tell the person to install a current Node.js from <https://nodejs.org>. Nothing else needs to be installed.

## 2. Make the workspace folder

The workspace is a separate folder beside this checkout, so plans never mix with the viewer's code. Use `../planning` (a sibling of this checkout). If that folder exists and is not empty, ask the person for another name.

```bash
mkdir -p ../planning
```

## 3. Run init

Run init from inside the workspace folder:

```bash
cd ../planning && ../plan-viewer/cli.ts init
```

If this checkout's folder is not named `plan-viewer`, use its real path. The last line `init` prints names the command that starts the viewer, with the right path. `init` starts a git repository, sets its hooks path so each commit checks the plans, and copies `AGENTS.md` and `CLAUDE.md`. Read the workspace's new `AGENTS.md` now. It says where every file goes and how plans and tasks are written. Follow it for the rest of this setup.

## 4. Start the viewer

From the workspace folder, start the viewer as a background process, so it keeps running while you work:

```bash
../plan-viewer/cli.ts
```

It prints `Plan Viewer is ready … at http://127.0.0.1:4173`. If the port is busy, set `PLAN_VIEWER_PORT` to another port. Give the person the URL and ask them to open it. The page is mostly empty for now.

## 5. Ask the person four questions

Ask these in one message:

1. What name should the viewer show for you?
2. What do you work on? One project or area is enough.
3. What is one real piece of work you want to track? It becomes the first task.
4. What do you want to get done today?

## 6. Write the first task and today's plan

Use the answers and the workspace `AGENTS.md`:

- Set `user` to their name in the workspace's viewer config file. `docs/configuration.md` in this checkout names the file and every other key; leave the others out for now.
- Write one task for the piece of work from question 3: front matter, a short outcome, and a work breakdown of two to four steps. Use their project from question 2.
- Write today's plan. Schedule the task, and add what they want to get done today from question 4.

Then run the checks from the workspace `AGENTS.md` (`lint`, then `links`) and fix what they report.

## 7. Commit

Commit the workspace. The pre-commit hook runs the same checks. If it fails, fix the files and commit again.

## 8. Show the result

Ask the person to reload the viewer. It opens today's plan, with the task as a card. Then tell them three things:

- To add work, they ask you (or any agent in the workspace) to write tasks and plans. The viewer never edits files.
- The optional integrations (GitHub pull requests, Jira, Linear, Slack, and agent handoffs from the viewer) are in the README's "Optional integrations" table. Each one is off until it is set up.
- `../plan-viewer/cli.ts` starts the viewer again later. Pulling this checkout updates it.
