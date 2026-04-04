const config = {
  developers: {
    keys: { enabled: false },
    webhooks: { enabled: false },
  },
  rateLimit: {
    apiKey: {
      windowMs: 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
    },
  },
};

export default config;
