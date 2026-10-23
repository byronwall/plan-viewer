# Transactional mailer rollout runbook for invite emails

1. Turn on the `invites` flag for the Acme staff workspace.
2. Send a test invite and confirm it arrives within a minute.
3. Watch the mailer's bounce rate for an hour, then widen the flag to ten percent of workspaces.
