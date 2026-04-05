const config = {
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
    },
  },
};

export default config;
