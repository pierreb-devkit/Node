# Migration: billing crons relocated to modules/billing/crons/ (2026-05-01)

## Why

Billing cron scripts belong in the billing module, not in the top-level `scripts/` directory. Module cohesion means all billing logic — services, repositories, and scheduled jobs — lives under `modules/billing/`. Issue #3546.

## Before / After

**Before:**

```
scripts/crons/billing.weeklyReset.js
scripts/crons/billing.extrasExpiration.js
scripts/crons/billing.dunningSweep.js
scripts/tests/billing.cron.*.unit.tests.js
```

**After (canonical):**

```
modules/billing/crons/billing.weeklyReset.js
modules/billing/crons/billing.extrasExpiration.js
modules/billing/crons/billing.dunningSweep.js
modules/billing/tests/billing.cron.*.unit.tests.js
```

## Cutover procedure

This is an atomic move with no backward-compat shim. The cutover for each downstream project requires coordinated steps:

1. Run `/update-stack` on the downstream project repo (e.g. trawl_node) — pulls the new structure with crons at `modules/billing/crons/`.
2. CI on the downstream repo builds a new image and pushes to GHCR.
3. Update the infra K8s CronJob manifests in `clusters/{cluster}/apps/{project}-billing-*.yaml` — change `args: ["scripts/crons/billing.*.js"]` to `args: ["modules/billing/crons/billing.*.js"]`.
4. Push the infra change → Flux applies → CronJobs use new args + new image together.

Expect a ≤5 min window where a CronJob run might fail with "script not found" if it fires between step 2 and step 4. Acceptable for billing crons (run weekly / daily / hourly — single missed run is recoverable on next tick).

If the cutover window is unacceptable for a specific cron, schedule the migration during that cron's idle gap.

No shim — atomic migration.

## Validation

- Unit tests pass (relocated to `modules/billing/tests/`, imports updated to relative `../`).
- `scripts/crons/scraps.js` untouched — separate concern, not billing.
