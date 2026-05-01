# Migration: billing.planDefinitions array shape (2026-05-01)

## Why

During PR-N6 (#3555), the `enterprise` plan was present in `billing.plans` but missing from `billing.planDefinitions`. This silent divergence would have caused `ensureSeeded()` to skip seeding the enterprise plan, resulting in a `null` return from `getActivePlan('enterprise')` and a 503 for all metered enterprise users.

The root cause: `plans` (enum array) and `planDefinitions` (definition map) were two separate declarations that had to be kept in sync manually. The fix is to make `planDefinitions` the single source of truth — `plans` is now derived at boot.

## Before / After

**Before (object-keyed — deprecated):**

```js
billing: {
  plans: ['free', 'starter', 'pro', 'enterprise'],   // must match planDefinitions keys — drift risk
  planDefinitions: {
    free:       { meterQuota: 0,        ratios: { default: 1 } },
    starter:    { meterQuota: 50000,    ratios: { default: 1 } },
    pro:        { meterQuota: 500000,   ratios: { default: 1 } },
    enterprise: { meterQuota: 2000000,  ratios: { default: 1 } },
  },
}
```

**After (array — canonical):**

```js
billing: {
  // plans: derived at boot from planDefinitions — do NOT declare manually
  planDefinitions: [
    { planId: 'free',       meterQuota: 0,        ratios: { default: 1 } },
    { planId: 'starter',    meterQuota: 50000,    ratios: { default: 1 } },
    { planId: 'pro',        meterQuota: 500000,   ratios: { default: 1 } },
    { planId: 'enterprise', meterQuota: 2000000,  ratios: { default: 1 } },
  ],
}
```

`config.billing.plans` is still available at runtime (derived by `config/index.js`) — `z.enum(config.billing.plans)` and all Zod/Mongoose schemas keep working unchanged.

## Downstream migration steps

For each downstream project that overrides `billing.planDefinitions` (e.g. `modules/billing/config/billing.{project}.config.js`):

1. Pull the latest devkit: `npm run update-stack` (or merge the upstream devkit branch).
2. Open `modules/billing/config/billing.{project}.config.js`.
3. Convert `planDefinitions` from object to array form (see Before/After above). Remove the `plans: [...]` line — leaving it is harmless (the derivation in `config/index.js` runs after deepMerge and overwrites it), but remove it to avoid confusion.
4. Run unit tests: `NODE_ENV={project} npm run test:unit -- billing`.
5. Smoke test the plans endpoint: `curl https://api.{project}.example.com/api/billing/plans`.

No database migration is required — the `BillingPlan` collection is unchanged.

## Validation

After migration, confirm:

- Boot logs show **no** `[billing] planDefinitions object shape is deprecated` warning (shim did not trigger).
- `NODE_ENV={project} npm run test:unit -- billing` passes.
- `[billing] Subscription.plan value "..." not in planDefinitions` warning is **absent** in boot logs (no orphaned subscriptions).

## Shim removal timeline

The backward-compat shim in `config/index.js` converts legacy object-keyed `planDefinitions` to array form with a `console.warn`. It will be removed **~2026-07-01**, contingent on:

- Zero deprecation warnings observed in any downstream prod log for ≥ 30 days.
- All downstream projects confirmed migrated to array form.

Track removal in a follow-up issue once all downstreams are migrated.
