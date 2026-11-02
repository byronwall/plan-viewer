# Invite expiry and single-use link decision

## Decision

Invites expire seven days after they are sent, and each link works once. Alex and Jordan agreed on seven days on October 20: long enough to cover a week of leave, short enough that a forwarded email goes stale.

## What people see

- A used or expired link shows "This invite is no longer valid" with a button to ask the owner for a new one.
- Revoking an invite expires it immediately.

## Alternatives considered

- Thirty days, as the old beta did. Rejected: forwarded links stayed live for a month.
- Links that work until accepted. Rejected for the same reason.
