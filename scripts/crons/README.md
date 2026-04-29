# Billing Cron Scripts

Standalone CLI scripts intended to be executed as Kubernetes CronJobs.

All scripts gate on `config.billing.meterMode === true` and exit 0 immediately when the flag is `false` (default).
No `node-cron` dependency — orchestration is handled by Kubernetes CronJob manifests.

## Scripts

| Script | Purpose | Recommended schedule |
|--------|---------|----------------------|
| `billing.weeklyReset.js` | Reset meter counters for orgs whose billing period rolled over | Daily `0 1 * * *` |
| `billing.extrasExpiration.js` | Expire topup ledger entries past their `expiresAt` date | Daily `0 2 * * *` |
| `billing.dunningSweep.js` | Downgrade stale `past_due` subs (>14d) to `unpaid` + `free` | Daily `0 3 * * *` |

## Usage

```sh
NODE_ENV=production node scripts/crons/billing.weeklyReset.js
NODE_ENV=production node scripts/crons/billing.extrasExpiration.js
NODE_ENV=production node scripts/crons/billing.dunningSweep.js
```

Exit code 0 = success (or meterMode disabled). Exit code 1 = at least one error or fatal failure.

## Kubernetes CronJob example

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: billing-weekly-reset
  namespace: pierreb-projects
spec:
  schedule: "0 1 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: billing-weekly-reset
              image: ghcr.io/your-org/your-app:main
              command: ["node", "scripts/crons/billing.weeklyReset.js"]
              env:
                - name: NODE_ENV
                  value: production
```

Repeat the manifest for `billing.extrasExpiration.js` and `billing.dunningSweep.js`, adjusting `name` and `schedule`.

## Dependency: meterMode flag

All scripts check `config.billing.meterMode` at startup. Downstream projects must set this flag to `true` in their project config to activate billing crons. The devkit default is `false` — all crons are no-ops until explicitly enabled.
