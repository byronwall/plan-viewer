---
title: Daily review
sent: Recaps the day, lists stale and waiting work, groups agent flags into fixes, and drafts tomorrow's plan
routine: true
---

Run {user}'s end-of-day review for {today} in the planning workspace at {root}. Follow its AGENTS.md. Report in four parts, then draft tomorrow's plan.

1. Day recap. Compare daily/{today}.md with what happened: tasks whose `updated:` is today, the dated updates they gained, steps marked done, and pull requests opened or merged today in the repositories in {repos-file} (`gh pr list --state all --search "updated:>={today}"`). Say which scheduled tasks moved, which did not, and what happened that the plan did not expect.
2. Stale and waiting. List waiting tasks whose `check_in` date has passed or that have no update in {check-in-days} days, active tasks with no update in {check-in-days} days, and open steps that were scheduled today but did not move. Suggest one next move for each.
3. Agent flags. Read the open agent flags (notes with `kind: agent-flag` and `flag: open` in tasks/*/notes/ and reference/notes/). Group them by cause, and propose a fix for each group: a change to AGENTS.md, a script, a skill or a prompt. Do not make the fixes; list them for {user} to pick.
4. Draft tomorrow. Write daily/{tomorrow}.md the same way as a daily plan: carry over unfinished work, then the Steps priority order (`{cli} next` and `{viewer-url}/api/steps`), then check-ins due tomorrow. Mark it as a draft at the top.

Record nothing as done that you did not verify. Run `{cli} lint` and fix what it reports. End with the questions that only {user} can answer.
