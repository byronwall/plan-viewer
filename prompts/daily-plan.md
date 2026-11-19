---
title: Daily plan
sent: Writes today's plan from the last plan, Up next, the Steps priority, check-ins and reviews, then asks you to confirm the order
routine: true
---

Draft today's plan for {user} in the planning workspace at {root}. Follow its AGENTS.md.

Today is {today}. Write daily/{today}.md, starting with `# Daily plan — {today-long}`. If the file already exists, update it and keep what {user} wrote.

Build the plan from these sources, in this order:

1. The most recent earlier plan in daily/: carry over scheduled tasks that are not completed.
2. The Steps priority order: run `{cli} next` for the steps and notes flagged Up next, and read `{viewer-url}/api/steps` (the running viewer) for every open step with its priority score. Higher scores go first.
3. Waiting tasks whose `check_in` date is today or earlier, and waiting tasks with no update in {check-in-days} days.
4. Open pull requests that wait on {user}'s review (`gh pr list --search "review-requested:@me"` in each repository in {repos-file}).

List the day's tasks under `## Scheduled tasks`, one per line, linked relative to the plan, each with what to do on it today. Keep the list to what fits in one day; name what you left out and why.

Then show {user} the proposed order and ask them to confirm or reorder it before you treat the plan as final. Run `{cli} lint` on the plan and fix what it reports.
