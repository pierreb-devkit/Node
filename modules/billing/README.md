# Billing Module

Stripe-based billing with per-plan quota management.

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
await BillingUsageService.increment(organizationId, 'documents.create', 1);
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
