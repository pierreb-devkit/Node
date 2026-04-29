const config = {
  audit: {
    routeTypeMap: {
      billing: 'Organization',
    },
  },
  billing: {
    activated: true,
    // Plans available for subscriptions — extend as needed
    plans: ['free', 'starter', 'pro', 'enterprise'],
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
     * Meter unit parameters — downstream projects must override with their
     * actual unit economics before enabling meterMode in production.
     *
     * runBaseUnits: flat units charged per run (before per-feature ratios).
     * maxUnitsPerOperation: safety cap per single operation run.
     */
    meter: {
      runBaseUnits: 1,
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
    /**
     * Extra meter packs — downstream projects override with actual packs.
     * Example: [{ packId: 'pack_500k', meterUnits: 500000, stripePriceId: 'price_xxx' }]
     */
    packs: [],
  },
  stripe: {
    secretKey: process.env.DEVKIT_NODE_stripe_secretKey ?? '',
    webhookSecret: process.env.DEVKIT_NODE_stripe_webhookSecret ?? '',
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
