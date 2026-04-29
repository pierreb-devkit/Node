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
     * Set to true in downstream project config to enable compute-based pricing.
     * When false, all compute code paths are no-ops; legacy behavior unchanged.
     */
    computeMode: false,
    /**
     * Compute unit parameters — downstream projects may override.
     * runBaseUnits: flat units charged per run (before per-feature ratios).
     * dollarsToComputeRatio: how many compute units per USD of LLM cost.
     * maxComputePerScrap: safety cap per single scrape run.
     */
    compute: {
      runBaseUnits: 1,
      dollarsToComputeRatio: 1000,
      maxComputePerScrap: 10000,
    },
    /**
     * Extra compute packs — downstream projects override with actual packs.
     * Example: [{ packId: 'pack_500k', computeUnits: 500000, stripePriceId: 'price_xxx' }]
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
