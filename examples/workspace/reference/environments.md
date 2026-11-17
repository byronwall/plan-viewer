# Environments

Every Acme environment with telemetry, from the last usage export. Expand the table to sort, filter and resize it.

| Environment | Owner | 30-day usage | Telemetry since | Days of data | User days | Page loads | Error rate |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| `atlas-prod` | Priya | weekly | Jul 11 | 77 | 2 | 78 | 1.86% |
| `atlas-staging` | Alex | startup only | Jul 22 | 38 | 1 | 33 | 0.03% |
| `atlas-preview` | Priya | weekly | Sep 3 | 63 | 5 | 130 | 1.78% |
| `billing-prod` | Jordan | weekly | Aug 28 | 28 | 4 | 200 | 0.09% |
| `billing-sandbox` | Sam | idle | Jul 27 | 4 | 0 | 0 | 2.01% |
| `webhooks-prod` | Priya | startup only | Sep 18 | 64 | 1 | 41 | 1.97% |
| `webhooks-replay` | Sam | daily | Jul 8 | 75 | 10 | 400 | 3.73% |
| `queue-worker-1` | Sam | idle | Jul 16 | 2 | 0 | 0 | 1.97% |
| `queue-worker-2` | Sam | idle | Sep 15 | 1 | 0 | 0 | 3.91% |
| `ci-runner-east` | Sam | startup only | Aug 8 | 48 | 0 | 0 | 0.10% |
| `ci-runner-west` | Priya | weekly | Jul 22 | 28 | 3 | 57 | 0.83% |
| `invites-canary` | Alex | idle | Aug 3 | 0 | 0 | 0 | 3.75% |
| `invites-load-test` | Priya | idle | Sep 25 | 1 | 1 | 19 | 2.13% |
| `search-indexer` | Alex | startup only | Aug 12 | 78 | 1 | 59 | 2.75% |
| `search-sandbox` | Priya | daily | Jul 22 | 58 | 5 | 90 | 2.17% |
| `reports-nightly` | Priya | startup only | Sep 27 | 50 | 0 | 0 | 3.76% |
| `reports-adhoc` | Sam | daily | Aug 10 | 38 | 23 | 322 | 2.40% |
| `demo-external` | Priya | daily | Aug 10 | 85 | 20 | 680 | 3.26% |
| `demo-internal` | Alex | idle | Aug 11 | 1 | 0 | 0 | 2.84% |
| `sandbox-alex` | Sam | idle | Jul 22 | 1 | 0 | 0 | 1.83% |
| `sandbox-priya` | Priya | idle | Jul 28 | 0 | 0 | 0 | 1.82% |
| `sandbox-jordan` | Jordan | daily | Aug 5 | 41 | 15 | 165 | 0.45% |
| `sandbox-sam` | Priya | startup only | Jul 5 | 53 | 1 | 42 | 3.84% |
| `legacy-api` | Alex | idle | Sep 8 | 1 | 1 | 91 | 2.98% |
| `legacy-cron` | Priya | idle | Jul 22 | 2 | 1 | 46 | 1.83% |
| `export-batch` | Sam | daily | Aug 16 | 57 | 31 | 1,395 | 2.19% |
| `import-batch` | Priya | idle | Jul 10 | 3 | 1 | 83 | 1.96% |
| `feature-flags` | Alex | daily | Sep 18 | 46 | 42 | 2,604 | 1.98% |
| `audit-log` | Priya | startup only | Aug 17 | 79 | 1 | 52 | 2.48% |
| `status-page` | Jordan | weekly | Aug 23 | 43 | 6 | 498 | 0.33% |

Idle environments are candidates for the quarterly cleanup.

## Access

How the team reaches each environment's admin console today, and who can hand out access.

| Environment | How we get in today | Roles available | Can grant? | Profile |
| --- | --- | --- | --- | --- |
| `atlas-prod` | Personal token in the `atlas` profile, renewed each quarter; single sign-on also works | `ADMIN` (default), `DEVELOPER`, `READ_ONLY` | Yes: `ADMIN` owns `DEPLOY_BOT` and `SUPPORT` and can create roles | `atlas` (active), works |
| `atlas-staging` | Personal token in the profile | `ADMIN`, `SECURITY_ADMIN`, `DEVELOPER`, `QA_RUNNER` and others | Yes, full admin | `staging`, works |
| `billing-prod` | Personal token (one year, created Nov 2) after the password reset; no single sign-on | `DEVELOPER` (default; has `MANAGE_GRANTS` and `CREATE_DATABASE`), `BILLING_READER`, `FINANCE_EXPORT` | Yes, through `MANAGE_GRANTS` | `billing`, works; run `USE ROLE` first |
| `webhooks-prod` | Personal token; a network-policy exception lets it skip the office IP check | `ACCOUNT_ADMIN` (profile role), `SYSADMIN`, four `REPLAY_*` reader roles; no `DEVELOPER` role exists here | Yes, full admin | `webhooks`, works |
| `search-indexer` | Shared service token, rotated by Alex | `INDEXER` only | No | `search`, read only |
| `legacy-api` | Nothing. No single sign-on, no profile | Unknown | Unknown | None |
| `audit-log` | Nothing. Access request open with IT | Unknown | Unknown | None |
