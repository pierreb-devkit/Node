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

## Backward-compat shim

Three re-export shims remain at `scripts/crons/billing.*.js`:

```js
// LEGACY SHIM — remove ~2026-07-01
await import('../../modules/billing/crons/billing.weeklyReset.js');
```

These keep existing infra K8s manifests and downstream `scripts/crons/` references working during the migration window.

## Downstream owner steps

1. Pull devkit via `/update-stack`.
2. Run `git status` — verify `scripts/crons/billing.*.js` are now shims (3-line files forwarding via `await import`).
3. K8s CronJob manifests pointing to `args: ["scripts/crons/billing.*.js"]` keep working via the shim. To migrate proactively, update to `args: ["modules/billing/crons/billing.*.js"]`.
4. Run `NODE_ENV={project} npm run test:unit -- billing` to confirm tests pass.

## Validation

- Shim `await import()` chain tested locally — syntax OK (`node --check` green on all 6 files).
- Unit tests pass (relocated to `modules/billing/tests/`, imports updated to relative `../`).
- `scripts/crons/scraps.js` untouched — separate concern, not billing.

## Shim removal timeline

~2026-07-01 — coordinated with planDefinitions shim cleanup (see `2026-05-01-billing-plan-definitions-array.md`). Once all downstream + infra manifests updated to the new path, drop the 3 shim files and remove this note from `scripts/crons/README.md`.
