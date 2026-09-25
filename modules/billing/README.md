# Billing Module

Stripe-based billing with per-plan quota management and meter-based compute pricing.

## Module boundary — the meter service is calc-agnostic

`billing.meter.service.js` converts a feature-keyed **USD cost map → meter units** via config ratios (`dollarsToUnitRatio`, per-plan `ratios`) and applies config knobs (`runBase`, `maxUnitsPerOperation`). It does **not** know what a run costs.

**Downstream cost semantics — what an op costs, per-run infra base, product-specific floors/caps — live in the downstream's own cost module + config (e.g. a `modules/costs`), never inline in this service.** An inline downstream patch here is silently wiped by `/update-stack`: a run-base floor added downstream inside a `billing.meter.service.js` copy was lost on the next stack sync, zeroing metering for free-tier usage. If a behaviour must live in this service, add it as a **default-off config knob**, never a hardcoded downstream rule.

## Quota System

### Configuration

Each downstream project defines its quotas in the billing config:

```js
// config/defaults/development.config.js
billing: {
  quotas: {
    free:    { documents: { create: 10, export: 50 } },
    starter: { documents: { create: 100, export: 500 } },
    pro:     { documents: { create: Infinity, export: Infinity } },
  },
}
```

### Middleware — `requireQuota(resource, action)`

Enforces per-plan limits on routes. Returns 429 when quota exceeded.

```js
import requireQuota from '../billing/middlewares/billing.requireQuota.js';

app.route('/api/documents')
  .post(passport.authenticate('jwt', { session: false }),
    organization.resolveOrganization,
    requireQuota('documents', 'create'),
    documents.create);
```

### Tracking Usage — `BillingUsageService`

Increment counters after successful operations:

```js
import BillingUsageService from '../billing/services/billing.usage.service.js';

// After creating a document
await BillingUsageService.increment(organizationId, 'documents_create', 1);
```

### Usage Endpoint

`GET /api/billing/usage` — returns current usage, limits, and plan for the authenticated org.

### Events

Listen for plan changes in downstream modules:

```js
import billingEvents from '../billing/lib/events.js';

billingEvents.on('plan.changed', ({ organizationId, previousPlan, newPlan, isDowngrade }) => {
  if (isDowngrade) {
    // Handle downgrade (e.g. disable premium features)
  }
});
```

## Meter Attribution — `BillingMeterService.attribute`

Charges compute units for a completed history run. Idempotent per `(history._id, stepKey)` pair.

```js
import BillingMeterService from '../billing/services/billing.meter.service.js';

// Initial charge — default stepKey='initial'
await BillingMeterService.attribute(history, organizationId);

// Delta charge after setDigest (pass ONLY the digest cost delta, not cumulative)
await BillingMeterService.attribute(historyWithDigestDelta, organizationId, { stepKey: 'digest' });

// Delta charge per fix attempt
await BillingMeterService.attribute(historyWithFixDelta, organizationId, { stepKey: 'fix:1' });
await BillingMeterService.attribute(historyWithFixDelta, organizationId, { stepKey: 'fix:2' });
```

**Per-step semantics**: each `stepKey` is independently idempotent. Replaying the same
`(history._id, stepKey)` is a safe no-op. Passing a new `stepKey` charges the delta once.

**Cost composition rule**: always pass ONLY the incremental cost delta in `history.costs` for each
step. Passing the cumulative total will double-charge costs already attributed in prior steps.

**Backward compat**: callers that only ever attribute once (no multi-step) continue to work
unchanged — the default `stepKey='initial'` makes the idempotency key `${history._id}:initial`.

## Plan-change semantics

When Stripe `plan.changed` webhook fires, devkit calls `forceRotateForPlanChange(orgId, { preserveUsage: true })` by default:
- Updates `meterQuota` and `planVersion` snapshot to the new plan
- Preserves `meterUsed` (no refund, no double-charge)

Consumers wanting clean-break behavior on downgrade should pass `{ preserveUsage: false }`.

## Quota admission and overflow debt

- **Admission is a pre-check, not a reservation.** `assertCanExecute` (used by `requireQuota` and any other caller) reads the meter and extras balance, then allows or denies. It never holds units; usage is recorded after the run. Concurrent requests can all pass on the same state, so overshoot is bounded by concurrency × one run's cost. This is an accepted trade-off.
- **Single-run bound:** `billing.meter.maxUnitsPerOperation` is the only cap on what one run can cost.
- **Runaway detector:** the negative-balance alert (`billing.extras.runaway_debit`) only fires on plans with a weekly quota (`meterQuota > 0`).
- **Overflow debt is repaid once per week.** Units consumed past the quota are debited from extras, which may go negative. On each `resetWeek` (weeks with a quota > 0 only) it repays debt from the target week's REMAINING quota: `settle = min(meterQuota − meterUsed, overflowDebt)` — the week is often already partly used, since the cron anchors on the current time. Extras are credited `settle` via an `adjustment` entry with refId `settle:<weekKey>`, then the week doc is charged that stored credit once (`meterUsed += settle`, guarded by the `settle:<weekKey>` key in `consumedAttributionKeys`) — a re-run, retry or concurrent reset never credits or charges twice. What does not fit stays as debt for the next reset. Refund debt and pack-expiry shortfall (the part of a pack clawback or a pack expiry that took the balance below zero) are never settled from quota — only a new pack repays them. The expiry sweep removes only a pack's own unspent units at its `expiresAt` (spending is attributed earliest-expiry-first; a fully spent pack gets a zero-amount marker, hidden from the customer ledger), so new expiries only create debt for usage recorded between a pack's `expiresAt` and the sweep (that part is never settled from quota); legacy full-amount expiration entries are left as is. Plans with `meterQuota = 0` are unchanged.

## Credit-balance alerts (plans without a weekly quota)

A plan with `meterQuota: 0` and a one-shot `signupGrant` (e.g. the stack default `free`
plan) has no weekly usage doc to alert against — every unit is debited straight from
`BillingExtraBalance.cachedBalance`, so that balance IS the limit. `incrementMeter` detects
crossings of the configured `billing.alerts.thresholdPercents` (filtered to 80/100, same
supported set as the weekly-quota alerts) against `plan.signupGrant * (100 - threshold) / 100`
(not `(1 - threshold/100) * signupGrant` — that form hits float imprecision at common values,
e.g. `500 * (1 - 80/100) = 99.99999999999997`, silently missing an exact boundary crossing),
comparing the debit's own pre/post balance, and emits `billing.extras.balance_threshold_crossed`
(`{ organizationId, threshold, remaining, planId }`). `billing.email.js` sends a
credit-warning (80%) or credit-exhausted (100%) email off of it.

- **Stateless — no `alertedAtN` field.** The weekly `alertedAt80`/`alertedAt100` fields
  are scoped to a week and would re-fire every week against a lifetime balance, so this
  path re-derives the crossing from the debit itself each time. A pack or referral credit
  that pushes the balance back above a level means the next crossing alerts again — intended.
- **Accepted limitation — "% of grant" only fits the signup grant.** Once a pack purchase
  tops up the same `cachedBalance`, "percent of grant remaining" is ambiguous, so this only
  applies when `meterQuota === 0` and the plan has a valid `signupGrant`. Copy always speaks
  in absolute credits left, never a percentage.
- **Accepted limitation — expiry and refunds don't alert.** A balance drop from a pack
  expiring (`crons/billing.extrasExpiration.js`) or a refund (`billing.refund.service.js`)
  does not go through `incrementMeter`'s debit path, so it never triggers this crossing check.

## Extras debit reliability

`attribute()` returns optimistically after usage increment + outbox row insert. Extras debit happens out of band; if it fails, cron `retry-pending-extras-debit` reconciles on the configured retry interval. After the configured failed-attempt limit, the outbox row is marked `failed` and the configured exhausted event is emitted for alerting.

Consumers should NOT retry on `applied: true` — the outbox handles eventual consistency.

## Meter hardening configuration

### Configuration knobs

| Knob | Type | Devkit default | Notes |
|------|------|----------------|-------|
| `billing.meter.runBase` | number | 1 | METER_RUN_BASE base unit cost |
| `billing.meter.fallbackPlanId` | string \| null | null | Fallback plan when active not resolvable |
| `billing.meter.dollarsToUnitRatio` | number | 1000 | Dollar → unit conversion. DOWNSTREAM-OVERRIDE-REQUIRED. Constant fallback: `getDollarsToUnitRatio()` |
| `billing.meter.maxUnitsPerOperation` | number | 10000 | Cap per single attribute call (dev config). Constant fallback: `Infinity` via `getMaxUnitsPerOperation()` |
| `billing.meter.ratioVersion` | string \| null | '2026.05' | DOWNSTREAM-OVERRIDE-REQUIRED — pricing version namespace. Read directly from config, no constant wrapper |
| `billing.outbox.maxRetryAttempts` | number | 5 | Outbox retry limit before exhausted |
| `billing.outbox.retryIntervalSec` | number | 300 | Cron retry interval |
| `billing.crons.jitterMaxMs` | number | 60000 | Cron startup jitter max. Constant fallback: `getCronJitterMaxMs()` |
| `billing.planChange.preserveUsageDefault` | boolean | true | forceRotateForPlanChange default |
| `billing.alerts.thresholdPercents` | number[] | [80, 100] | Schema-supported only — others warn at boot, alert silently skipped. Constant fallback: `getAlertThresholdPercents()` |
| `billing.events.extrasExhausted` | string | 'billing.extras_debit.exhausted' | Event name for downstream alerting |
| `billing.defaultPlan` | string | 'free' | Default plan ID for fallback. Constant fallback: `getDefaultPlanId()` |

Canonical constant fallbacks live in `modules/billing/lib/billing.constants.js`. Downstream project overrides go in `modules/billing/config/billing.development.config.js`:

```js
billing: {
  meter: {
    runBase: 1,
    maxUnitsPerOperation: 10000,
    fallbackPlanId: null,
  },
  outbox: {
    maxRetryAttempts: 5,
    retryIntervalSec: 300,
  },
  crons: {
    jitterMaxMs: 60_000,
  },
  planChange: {
    preserveUsageDefault: true,
  },
  alerts: {
    thresholdPercents: [80, 100],  // only 80 and 100 are supported schema fields; other values warn and are skipped
  },
  events: {
    extrasExhausted: 'billing.extras_debit.exhausted',
  },
}
```

Example override:

```js
// config/defaults/production.config.js
export default {
  billing: {
    meter: {
      runBase: 2,
      maxUnitsPerOperation: 25000,
      fallbackPlanId: 'starter',
    },
    outbox: {
      maxRetryAttempts: 8,
      retryIntervalSec: 120,
    },
    crons: {
      jitterMaxMs: 30_000,
    },
    planChange: {
      preserveUsageDefault: false,
    },
    alerts: {
      thresholdPercents: [80, 100],
    },
    events: {
      extrasExhausted: 'billing.extras_debit.exhausted',
    },
  },
};
```

`meter.runBaseUnits` is still accepted as a backward-compatible alias for `meter.runBase`.

## Stripe — `automatic_tax` flag

```js
// config/defaults/development.config.js (downstream project override)
stripe: {
  automaticTax: true, // set true once Stripe Tax product is enabled in Dashboard
}
```

Default is `false` (devkit default). When `false`, checkout sessions are created without
`automatic_tax` or `customer_update` fields, which is safe for merchants not using Stripe Tax
(e.g. auto-entrepreneur FR, franchise TVA art. 293 B).

**V1 note**: do NOT set `automaticTax: true` in production until the Stripe Tax product is
activated in the Stripe Dashboard. In LIVE mode without Tax setup Stripe returns:
`invalid_request_error — The 'automatic_tax' parameter requires the Stripe Tax product`.
