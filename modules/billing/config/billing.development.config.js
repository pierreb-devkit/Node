const config = {
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
