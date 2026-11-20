# Set up a planning workspace (for agents)

A person asked you to set them up with Planboard. They either cloned this repository and started you in it, or started you in an empty folder and asked for `npx planboard`. Follow these steps in order. When you finish, the person has their own planning workspace open in the viewer, with today's plan and one real task in it.

Talk to the person as you go. Ask only the questions listed here, and say what each step did.

## 1. Check Node

Run `node --version`. The viewer needs Node.js 22.6 or later from a clone, and 22.15 or later from npm. If it is older or missing, stop and tell the person to install a current Node.js from <https://nodejs.org>. Nothing else needs to be installed.

In the steps below, `../planboard/cli.ts` is the clone's command. With no clone, use `npx planboard` in its place, run from the workspace.

## 2. Make the workspace folder

The workspace is a separate folder, so plans never mix with the viewer's code. From a clone, use `../planning` (a sibling of the checkout). With no clone, use the empty folder you started in and skip the `mkdir`. If the folder exists and is not empty, ask the person for another name.

```bash
mkdir -p ../planning
```

## 3. Run init

Run init from inside the workspace folder:

```bash
cd ../planning && ../planboard/cli.ts init
```

With no clone, run `npx --yes planboard init` in the workspace instead. If the checkout's folder is not named `planboard`, use its real path. The last line `init` prints names the command that starts the viewer, with the right path. `init` starts a git repository, sets up a pre-commit hook so each commit checks the plans, and copies `AGENTS.md` and `CLAUDE.md`, with that same command in their checks. Read the workspace's new `AGENTS.md` now. It says where every file goes and how plans and tasks are written. Follow it for the rest of this setup.

## 4. Start the viewer

From the workspace folder, start the viewer as a background process, so it keeps running while you work:

```bash
../planboard/cli.ts
```

It prints `Planboard is ready … at http://127.0.0.1:4173`. If the port is busy, set `PLAN_VIEWER_PORT` to another port. Give the person the URL and ask them to open it. The page is mostly empty for now.

## 5. Ask the person four questions

Ask these in one message:

1. What name should the viewer show for you?
2. What do you work on? One project or area is enough.
3. What is one real piece of work you want to track? It becomes the first task.
4. What do you want to get done today?

## 6. Write the first task and today's plan

Use the answers and the workspace `AGENTS.md`:

- Set `user` to their name in the workspace's viewer config file. `docs/configuration.md` in this checkout names the file and every other key; leave the others out for now.
- Write one task for the piece of work from question 3: front matter, a short outcome, and a work breakdown of two to four steps. Use their project from question 2. An active task needs a next action with a prompt for its first ready step; lint rejects it otherwise.
- Write today's plan. Schedule the task, and add what they want to get done today from question 4.

Then run the checks from the workspace `AGENTS.md` (`lint`, then `links`) and fix what they report.

## 7. Commit

Commit the workspace. If `git config user.name` or `git config user.email` is empty, ask the person for them and set them in the workspace repository; never make up an identity. The pre-commit hook runs the same checks. If it fails, fix the files and commit again.

## 8. Show the result

Ask the person to reload the viewer. It opens today's plan, with the task as a card. Then tell them three things:

- To add work, they ask you (or any agent in the workspace) to write tasks and plans. The viewer never edits files.
- The optional integrations (GitHub pull requests, Jira, Linear, Slack, and agent handoffs from the viewer) are in the README's "Optional integrations" table. Each one is off until it is set up.
- The command `init` printed (`../planboard/cli.ts` or `npx planboard`) starts the viewer again later. Pulling the checkout updates a clone; `npx planboard@latest` updates an npm install.
