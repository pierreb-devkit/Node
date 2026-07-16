import {
  PRICING_VERSION,
  PLAN_QUOTAS,
  RATIOS,
  STRIPE_PRICE_CENTS,
  STRIPE_PACK_CENTS,
} from './billing.pricing.constants.js';

const config = {
  app: {
    title: 'Devkit Node - Development Environment',
    description: 'Node - Boilerplate Back : Express, Jwt, Mongo',
    keywords: 'node, express, mongo, jwt, stack, boilerplate',
    googleAnalyticsTrackingID: 'DEVKIT_NODE_app_googleAnalyticsTrackingID',
    contact: 'contact@example.com',
    version: '', // app release version — overridden at build via DEVKIT_NODE_app_version (Layer 4 env override); getConfig falls back to package.json version
  },
  openapi: {
    enable: true,
    // opt-in: serve the unauthenticated /api/spec.json publicly in production-grade envs (public API docs); off by default
    public: false,
  },
  docs: {
    // Grouping primitive for guide sections. See `public.docs.tree.js` JSDoc for full schema details.
    guideSections: [
      { title: 'Get Started', prefixMin: 0, prefixMax: 9 },
    ],
    // Modules whose doc/*.yml (OpenAPI) + doc/guides/*.md are excluded from the
    // public spec (/api/spec.json) and guide tree (/api/public/docs), independent
    // of module activation — works even on core modules (core/auth/users/home).
    // Empty = include all (the sample guides stay a working tutorial). A project
    // overrides this (e.g. ['home']) when its own guides reuse the sample slugs.
    excludeModules: [],
  },
  api: {
    protocol: 'http',
    port: 3000,
    host: '127.0.0.1',
    base: 'api',
    timeout: 2 * 60 * 1000,
  },
  db: {
    uri: 'mongodb://127.0.0.1:27017/NodeDev',
    debug: true,
    options: {
      user: '',
      pass: '',
      /**
        * Uncomment to enable ssl certificate based authentication to mongodb
        * servers. Adjust the settings below for your specific certificate
        * setup.
      ssl: true,
      sslValidate: false,
      checkServerIdentity: false,
      sslCA: './config/sslcerts/ssl-ca.pem',
      sslCert: './config/sslcerts/ssl-cert.pem',
      sslKey: './config/sslcerts/ssl-key.pem',
      sslPass: '1234'
      */
    },
  },
  // SSL on express server (FYI : Wiki)
  // secure: {
  //   ssl: false,
  //   key: './config/sslcerts/key.pem',
  //   cert: './config/sslcerts/cert.pem',
  // },
  log: {
    // logging with Morgan - https://github.com/expressjs/morgan
    // Can specify one of 'combined', 'common', 'dev', 'short', 'tiny', 'custom'
    format: 'custom',
    pattern: ':requestId :id :email :method :url :status :response-time ms - :res[content-length]', // only for custom format
    // Structured JSON output for Winston console transport (enable in production)
    json: false,
    // Winston log level: error, warn, info, http, verbose, debug, silly
    level: 'info',
    fileLogger: {
      directoryPath: process.cwd(),
      fileName: 'app.log',
      maxsize: 10485760,
      maxFiles: 2,
      json: false,
    },
    // Path segments consumed by `lib/helpers/redactUrl.js` (`redactPathSecrets`)
    // to redact single-use secrets carried as a PATH parameter (e.g.
    // `/api/auth/reset/:token`). A module that adds its own token-bearing route
    // extends this list from its own config instead of editing shared lib/.
    sensitivePathMarkers: ['reset', 'verify', 'verify-email'],
    // Query-string parameter names consumed by `lib/helpers/redactUrl.js`
    // (`redactUrl`) to redact single-use secrets carried in the query string
    // (e.g. `POST /api/auth/signup?inviteToken=…`).
    sensitiveQueryKeys: ['inviteToken'],
  },
  csrf: {
    csrf: false,
    csp: false,
    xframe: 'SAMEORIGIN',
    p3p: 'ABCDEF',
    xssProtection: true,
  },
  bodyParser: {
    limit: '500kb',
  },
  validation: {
    supportedMethods: ['post', 'put'],
  },
  cors: {
    origin: ['http://localhost:8080'],
    credentials: true,
  },
  trust: {
    proxy: false,
  },
  analytics: {
    posthog: {
      enabled: process.env.DEVKIT_NODE_analytics_posthog_enabled === 'true',
      key: process.env.DEVKIT_NODE_analytics_posthog_key ?? '',
      host: process.env.DEVKIT_NODE_analytics_posthog_host ?? 'https://eu.i.posthog.com',
      appTag: process.env.DEVKIT_NODE_analytics_posthog_appTag ?? '',
      flushAt: 20,
      flushInterval: 10000,
      errorTracking: process.env.DEVKIT_NODE_analytics_posthog_errorTracking === 'true',
      autoCapture: process.env.DEVKIT_NODE_analytics_posthog_autoCapture === 'true',
    },
    // Regex-source string used by the PostHog context middleware to detect a
    // CLI client from its User-Agent (capture group 1 = version). Empty → no
    // CLI detection (source stays 'web'). A project that ships a CLI sets this
    // to e.g. '@example-org/cli/(\\S+)'.
    cliUserAgentPattern: process.env.DEVKIT_NODE_analytics_cliUserAgentPattern ?? '',
  },
  domain: '',
  cookie: {
    secure: false, // false in dev (HTTP localhost)
    sameSite: 'strict',
  },
  mailer: {
    provider: 'nodemailer', // 'nodemailer' (default) or 'resend'
    from: 'DEVKIT_NODE_mailer_from',
    options: {
      // nodemailer options
      service: 'DEVKIT_NODE_mailer_options_service',
      auth: {
        user: 'DEVKIT_NODE_mailer_options_auth_user',
        pass: 'DEVKIT_NODE_mailer_options_auth_pass',
      },
      // resend options
      apiKey: 'DEVKIT_NODE_mailer_options_apiKey',
    },
  },
  seedDB: {
    seed: true,
    options: {
      logResults: true,
      seedTasks: [
        {
          title: 'title1',
          description: 'do something about something else',
        },
        {
          title: 'title2',
          description: 'do something about something else',
        },
      ],
      seedUser: {
        provider: 'local',
        email: 'seeduser@localhost.com',
        firstName: 'User',
        lastName: 'Local',
        displayName: 'User Local',
        roles: ['user'],
      },
      seedAdmin: {
        provider: 'local',
        email: 'seedadmin@localhost.com',
        firstName: 'Admin',
        lastName: 'Local',
        displayName: 'Admin Local',
        roles: ['user', 'admin'],
      },
    },
  },
  billing: {
    /**
     * Pricing constants contract — safe devkit defaults.
     * Downstream projects override these values in their own config file.
     * These values are also directly importable from
     * `config/defaults/billing.pricing.constants.js` for migrations and
     * standalone tooling that cannot import the full config object.
     */
    pricing: { PRICING_VERSION, PLAN_QUOTAS, RATIOS, STRIPE_PRICE_CENTS, STRIPE_PACK_CENTS },
  },
};

export default config;
