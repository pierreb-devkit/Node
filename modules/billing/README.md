# Billing Module

Stripe-based billing with per-plan quota management and meter-based compute pricing.

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

## Extras debit reliability

`attribute()` returns optimistically after usage increment + outbox row insert. Extras debit happens out of band; if it fails, cron `retry-pending-extras-debit` reconciles within 5min. After 5 failed attempts, the outbox row is marked `failed` and event `billing.extras_debit.exhausted` is emitted for alerting.

Consumers should NOT retry on `applied: true` — the outbox handles eventual consistency.

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
