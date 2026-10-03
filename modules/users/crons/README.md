# Users Cron Scripts

Standalone CLI scripts intended to be executed as Kubernetes CronJobs (same
pattern as `modules/billing/crons/`).

## Scripts

| Script | Purpose | Recommended schedule |
|--------|---------|----------------------|
| `users.emailSequences.js` | Send config-declared product email sequences (e.g. a day-7/day-21 onboarding series) | Daily `0 6 * * *` |

## `users.emailSequences.js`

No-op until a downstream project declares at least one sequence in
`config.users.emailSequences` (default `{}`), e.g.:

```js
// config/defaults/{project}.config.js
export default {
  users: {
    emailSequences: {
      onboarding: {
        startAt: '2026-10-01T00:00:00.000Z', // cutoff — users created before this never join
        kind: 'onboarding', // 'onboarding' | 'news' — matches emailPreferences / EmailKind
        from: 'Product Team <hello@example.com>', // optional, falls back to config.mailer.from
        replyTo: 'support@example.com', // optional
        steps: [
          { day: 7, template: 'onboarding-day7', subject: 'Getting the most out of it' },
          { day: 21, template: 'onboarding-day21', subject: 'A few things you may have missed' },
        ],
      },
    },
  },
};
```

### Matching semantics

- A step fires for a user when their account age — in **whole UTC calendar
  days**, midnight to midnight, not elapsed milliseconds — equals `step.day`,
  AND `user.createdAt >= sequence.startAt`. Both conditions are applied as a
  MongoDB filter on the per-step page query (`UserRepository.findPage`), not
  by loading every user and filtering in process.
- **There is no sent marker, so running the cron twice on the same UTC day
  mails the same matching users twice.** `concurrencyPolicy: Forbid` and the
  distributed lock below only prevent two runs from *overlapping* — they do
  nothing against a second, sequential run (e.g. a manual
  `kubectl create job --from=cronjob/...` on a day the scheduled run already
  fired). Schedule it exactly once per day and don't re-trigger it manually
  on a day it already ran.
- **No sent marker, no catch-up.** If the cron doesn't run on the day a user
  would have hit `step.day` (downtime, or the sequence was declared after the
  fact), that step never fires for that user. Accepted — see #4163.
- `template`/`subject`/`from`/`replyTo`/`kind` are passed straight through to
  `UserService.sendProductMail`, including its existing `emailVerified` and
  `emailPreferences[kind]` opt-out checks (applied twice: once as a DB filter
  for efficiency, once again inside `sendProductMail` on the fetched
  snapshot — same belt-and-braces pattern as `UserService.announce`).
- Sends are sequential, never parallel, so a large user base can't burst the
  mailer provider's rate limit. A per-recipient failure is logged and does
  **not** stop the run — the rest of the recipients still get mailed.

## Usage

```sh
NODE_ENV=production node modules/users/crons/users.emailSequences.js
```

Exit code 0 = success (or no sequences configured). Exit code 1 = at least
one per-recipient send failure, or a fatal failure (DB connection, lock).

## Kubernetes CronJob example

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: users-email-sequences
  namespace: your-namespace # replace with your namespace
spec:
  schedule: "0 6 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: users-email-sequences
              image: ghcr.io/your-org/your-app:main # replace with your project image
              command: ["node", "modules/users/crons/users.emailSequences.js"]
              env:
                - name: NODE_ENV
                  value: production
```

## Concurrency control

Acquires a distributed lock (`lib/services/distributedLock.js`) before
sending anything. The lock auto-expires after its TTL so a pod crash doesn't
permanently block the next scheduled run.

| Lock name | TTL | Cron |
|-----------|-----|------|
| `users.emailSequences` | 15 min | `users.emailSequences.js` |

Seeing `lock held by another pod, skipping` in logs is expected when two pods
race after a Kubernetes `concurrencyPolicy` bypass (e.g. a pod crash right
after the previous run acquired the lock but before it finalized).
