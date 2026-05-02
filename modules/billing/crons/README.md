# Billing Cron Scripts

Standalone CLI scripts intended to be executed as Kubernetes CronJobs.

Relocated here from `scripts/crons/` as of 2026-05-01 (#3546) — billing logic belongs in the billing module.
The old paths at `scripts/crons/billing.*.js` no longer exist. See `docs/migrations/2026-05-01-billing-crons-module-relocation.md` for the cutover procedure.

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
NODE_ENV=production node modules/billing/crons/billing.weeklyReset.js
NODE_ENV=production node modules/billing/crons/billing.extrasExpiration.js
NODE_ENV=production node modules/billing/crons/billing.dunningSweep.js
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
              image: ghcr.io/your-org/your-app:main  # replace with your project image
              command: ["node", "modules/billing/crons/billing.weeklyReset.js"]
              env:
                - name: NODE_ENV
                  value: production
```

Repeat the manifest for `billing.extrasExpiration.js` and `billing.dunningSweep.js`, adjusting `name` and `schedule`.

## Jitter & sharding

Devkit-shipped crons run on identical UTC schedules across all consumer deployments. To avoid thundering-herd against a shared DB or external API:

### Recommended pattern — startup jitter

These scripts are invoked once per CronJob execution and exit immediately after. Add a random delay at the top of your entrypoint to spread load across deployments:

```js
// Wrap in an async IIFE — cron entrypoints are CommonJS, so top-level await is not available.
// Jitter is re-randomized on each CronJob invocation — this is intentional for K8s CronJobs.
// For a stable per-pod offset, derive from process.env.HOSTNAME instead (see note below).
(async () => {
  const jitterMs = Math.floor(Math.random() * 60_000); // 0–60s window
  await new Promise(r => setTimeout(r, jitterMs));
  await BillingResetService.resetAllDue();
})();
```

> **Stable per-pod jitter (optional):** If you want the same pod to always fire at the same offset within the window, derive jitter from the pod hostname instead of `Math.random()`. Use a distinct variable name to avoid shadowing if both snippets appear in the same file:
> ```js
> const seed = process.env.HOSTNAME ?? 'default';
> const hostHash = [...seed].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
> const stableJitterMs = Math.abs(hostHash) % 60_000;
> ```

### When to shard

If your tenant count > 10k OR the operation touches a single table that doesn't tolerate concurrent writes well:
- Shard by `organizationId` modulo N (e.g. 8 shards, each at a different hour offset: `0 2-9 * * 1`)
- Or use a per-tenant queue with worker pool

To implement shard-based filtering, pass a `SHARD_INDEX` and `SHARD_TOTAL` env vars in the CronJob manifest:

```yaml
env:
  - name: SHARD_INDEX
    value: "0"       # 0..N-1
  - name: SHARD_TOTAL
    value: "8"
```

Then filter in the script by hashing a stable field (e.g. the string representation of `_id`) against the shard count:

```js
const shardIndex = parseInt(process.env.SHARD_INDEX ?? '0', 10);
const shardTotal = parseInt(process.env.SHARD_TOTAL ?? '1', 10);
// Only process orgs assigned to this shard (stable hash on _id string).
// Note: this loads all _id values into memory. For very large tenant counts,
// prefer a server-side filter (e.g. MongoDB $expr + $mod on a numeric shard key).
const allOrgs = await Org.find({}, '_id').lean();
const orgs = allOrgs.filter(o => {
  const id = o._id.toString();
  const h = [...id].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
  return Math.abs(h) % shardTotal === shardIndex;
});
```

### Constraints

- Don't jitter more than the operation's idempotency window — if reset is idempotent within 1h, jitter ≤ 30min. Beyond that, late-running jobs miss their window.
- Don't jitter critical SLA-bound jobs (alerts, notifications) — jitter undermines time-sensitivity.

## Dependency: meterMode flag

All scripts check `config.billing.meterMode` at startup. Downstream projects must set this flag to `true` in their project config to activate billing crons. The devkit default is `false` — all crons are no-ops until explicitly enabled.
