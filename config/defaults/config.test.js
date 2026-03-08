const config = {
  app: {
    title: 'Devkit Node - Test Environment',
  },
  api: {
    port: 3001,
  },
  db: {
    uri: 'mongodb://127.0.0.1:27017/NodeTest',
    debug: false,
  },
  rateLimit: {
    auth: {
      max: Number.MAX_SAFE_INTEGER, // disable rate limiting in tests
    },
  },
};

export default config;
