/**
 * Test environment defaults.
 *
 * The default `db.uri` is suffixed with `process.pid` so concurrent jest
 * invocations (e.g. multiple agent worktrees running `npm run test:coverage`
 * in parallel) hit isolated databases. Without this isolation, each process'
 * `globalSetup` `dropDatabase()` wipes the others' fixtures mid-run, producing
 * the 401/404/422/MongoPoolClosedError flake patterns documented in
 * https://github.com/pierreb-devkit/Node/issues/3515.
 *
 * The literal `NodeTest_` prefix preserves the `/test/i` DB-name guard in
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
    uri: `mongodb://127.0.0.1:27017/NodeTest_${process.pid}`,
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
