# Workspace invites

The design behind [TASK-0101](../../tasks/TASK-0101.md).

## Goals

- An invited teammate reaches a working account in under a minute.
- A forwarded or stale link never grants access.
- Owners can see and revoke every pending invite.

## Design

Each invite stores a hashed single-use token, the inviter, the invitee's email, and an expiry seven days out. Accepting checks the token, the expiry, and that the signed-in email matches the invite. Revoking deletes the row, so the link fails like any unknown token.

## Open questions

- Should owners be able to change the expiry per invite? Not for the first release.
- Do we notify the inviter when an invite is accepted? Leaning yes, as an in-app notice.
