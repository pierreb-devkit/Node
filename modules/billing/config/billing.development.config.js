const config = {
  audit: {
    routeTypeMap: {
      billing: 'Organization',
    },
  },
  billing: {
    enabled: true,
    // Quotas — downstream projects override these per plan:
    // quotas: {
    //   free:    { documents: { create: 10, export: 50 } },
    //   starter: { documents: { create: 100, export: 500 } },
    //   pro:     { documents: { create: Infinity, export: Infinity } },
    // },
    // Stripe subscription statuses — see https://docs.stripe.com/api/subscriptions/object#subscription_object-status
    statuses: [
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'canceled',
      'unpaid',
      'paused',
    ],
    /**
     * Feature flag — default OFF.
     * Set to true in downstream project config to enable meter-based pricing.
     * When false, all meter code paths are no-ops; legacy behavior unchanged.
     */
    meterMode: false,
    /**
     * Default plan used when an organization has no subscription. Configurable per project.
     */
    defaultPlan: 'free',
    /**
     * URL the front-end should redirect users to when quota is exhausted or past_due.
     * Used by middleware error responses (METER_EXHAUSTED, QUOTA_EXCEEDED).
     */
    upgradeUrl: '/billing/plans',
    /**
     * When true, mounts attachUsageContext on protected /api/billing/* routes.
     * Emits X-Meter-Remaining on billing responses. Off by default to avoid
     * extra DB reads on routes that do not need the header.
     */
    attachUsageHeader: false,
    /**
     * Plan definitions — DOWNSTREAM-OVERRIDE-REQUIRED for meter mode.
     * Used by BillingPlanService.ensureSeeded() at boot to upsert BillingPlan docs.
     * Array of objects: { planId, meterQuota: units/week, ratios: { featureKey: multiplier }, version?, signupGrant?, oneShot? }.
     * billing.plans enum is derived at boot from planDefinitions.map(p => p.planId) — do NOT
     * declare billing.plans manually. This is the single source of truth for plan identifiers.
     *
     * version: optional — falls back to billing.meter.ratioVersion, then v${count + 1}.
     * Downstream projects that use YYYY.MM versioning should set this (or set ratioVersion).
     */
    planDefinitions: [
      /**
       * signupGrant: one-time credit given to fresh orgs at signup (N2 feature).
       * oneShot: true = grant does not renew on weekly/monthly reset.
       * DOWNSTREAM-OVERRIDE: set meterQuota + signupGrant per project's actual unit economics.
       */
      { planId: 'free', meterQuota: 0, signupGrant: 500, oneShot: true, ratios: { default: 1 } },
      { planId: 'starter', meterQuota: 50000, ratios: { default: 1 } },
      { planId: 'pro', meterQuota: 500000, ratios: { default: 1 } },
      { planId: 'enterprise', meterQuota: 2000000, ratios: { default: 1 } },
    ],
    /**
     * Meter unit parameters — downstream projects must override with their
     * actual unit economics before enabling meterMode in production.
     *
     * runBase: flat units charged per run when no cost data is available.
     * runBaseUnits: deprecated alias kept for downstream backward compatibility.
     * maxUnitsPerOperation: safety cap per single operation run.
     */
    meter: {
      runBase: 1,
      runBaseUnits: 1,
      fallbackPlanId: null,
      /**
       * Canonical version string emitted by billing.meter.service attribute() when writing
       * history.planVersion. Downstream projects MUST override this value and keep it
       * aligned with:
       *   1. planDefinitions[].version (or omit it and rely on this value as the fallback)
       *   2. The version string their cost-config writes into history records
       *
       * Preferred format: YYYY.MM (calendar-style, e.g. '2026.05').
       * Legacy format v${N} (e.g. 'v1') is still supported for backward compat,
       * but new projects should use YYYY.MM from the start.
       *
       * A mismatch here causes getPlanByVersion() to return null → ratio=1 fallback +
       * a WARN log in unitsFromCosts. Check that warn at boot if meter charges look flat.
       *
       * DOWNSTREAM-OVERRIDE-REQUIRED — this devkit default is illustrative.
       */
      ratioVersion: '2026.05',
      /**
       * Conversion ratio: 1 unit = 1 / dollarsToUnitRatio USD of underlying cost.
       *
       * DOWNSTREAM-OVERRIDE-REQUIRED — the devkit default (1000) is illustrative.
       * Each downstream project must set this based on their unit economics
       * (cost-target × margin multiplier). Setting this wrong directly affects
       * gross margin: a value of N means each $1 of cost consumes N units, so
       * lowering N halves the margin coverage.
       */
      dollarsToUnitRatio: 1000,
      maxUnitsPerOperation: 10000,
    },
    crons: {
      jitterMaxMs: 60_000,
    },
    planChange: {
      preserveUsageDefault: true,
    },
    alerts: {
      thresholdPercents: [80, 100],
    },
    events: {
      extrasExhausted: 'billing.extras_debit.exhausted',
    },
    /**
     * Extra meter packs — downstream projects override with actual packs.
     * Example: [{ packId: 'pack_500k', meterUnits: 500000, stripePriceId: 'price_xxx' }]
     */
    packs: [],
  },
  stripe: {
    secretKey: process.env.DEVKIT_NODE_stripe_secretKey ?? '',
    webhookSecret: process.env.DEVKIT_NODE_stripe_webhookSecret ?? '',
    /**
     * Feature flag — default OFF.
     * Set to true in downstream project config once Stripe Tax product is enabled
     * in the Stripe Dashboard. In LIVE mode, Stripe rejects automatic_tax: enabled
     * if the Tax product is not activated → checkout sessions will fail.
     * See: https://stripe.com/docs/tax/set-up
     *
     * V1 intent: disabled (auto-entrepreneur FR, franchise TVA art. 293 B).
     */
    automaticTax: false,
    prices: {
      starter: {
        monthly: process.env.DEVKIT_NODE_stripe_prices_starter_monthly ?? '',
        annual: process.env.DEVKIT_NODE_stripe_prices_starter_annual ?? '',
      },
      pro: {
        monthly: process.env.DEVKIT_NODE_stripe_prices_pro_monthly ?? '',
        annual: process.env.DEVKIT_NODE_stripe_prices_pro_annual ?? '',
      },
      /**
       * Extra packs price map — downstream project override.
       * Example: { pack_500k: 'price_xxx', pack_2m: 'price_yyy' }
       */
      packs: {},
    },
  },
};

export default config;
