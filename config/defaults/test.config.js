const config = {
  app: {
    title: 'Devkit Node - Test Environment',
  },
  api: {
    port: 3000,
  },
  db: {
    uri: 'mongodb://127.0.0.1:27017/NodeTest',
    debug: false,
  },
  organizations: {
    enabled: false,
    domainMatching: false,
  },
  rateLimit: {
    auth: {
      max: Number.MAX_SAFE_INTEGER, // disable rate limiting in tests
    },
  },
  uploads: {
    avatar: {
      kind: 'avatar',
      limits: {
        fileSize: Math.floor(0.05 * 1024 * 1024), // Max file size in bytes (~52 KB)
      },
    },
  },
};

export default config;
