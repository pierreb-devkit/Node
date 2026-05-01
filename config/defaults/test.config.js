/**
 * Test environment defaults.
 *
 * The plain `NodeTest` URI here is intentionally neutral. Per-process isolation
 * is applied in a single post-merge block in `config/index.js`, which appends
 * `_p${pid}_w${workerId}` so every jest invocation (multi-worktree agent batches,
 * parallel workers, CI runs) hits its own isolated MongoDB database.
 *
 * The literal `NodeTest` prefix preserves the `/test/i` DB-name guard in
 * `scripts/jest.globalSetup.js` (#3476). CI workflows set
 * `DEVKIT_NODE_db_uri` explicitly (`Layer 4` env override in `config/index.js`)
 * so they keep their own per-run unique DB and never pick up this default.
 */
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
  audit: {
    enabled: true,
    ttlDays: 1,
  },
  sentry: {
    dsn: '',
    enabled: false,
  },
  organizations: {
    enabled: false,
    domainMatching: false,
  },
  rateLimit: {
    auth: {
      max: Number.MAX_SAFE_INTEGER, // disable rate limiting in tests
    },
    api: {
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
