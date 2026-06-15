const config = {
  app: {
    title: 'Devkit Node - Production Environment',
  },
  // Secure-by-default: keep the unauthenticated API docs surface off in production.
  // The runtime gate in lib/services/express.js (isProd) already prevents mounting
  // docs in any non-dev env; this flag makes the intent explicit at the config layer.
  swagger: {
    enable: false,
  },
  api: {
    host: '0.0.0.0',
    port: 4200,
  },
  db: {
    uri: 'mongodb://127.0.0.1:27017/WaosNode',
    debug: false,
  },
  trust: {
    proxy: 1, // single reverse proxy hop (Traefik, Nginx) — ensures req.ip uses X-Forwarded-For
  },
  secure: {
    ssl: false,
    privateKey: './config/sslcerts/key.pem',
    certificate: './config/sslcerts/cert.pem',
    caBundle: './config/sslcerts/cabundle.crt',
  },
  cookie: {
    secure: true, // HTTPS only in prod
    sameSite: 'strict',
  },
  rateLimit: {
    auth: {
      windowMs: 15 * 60 * 1000,
      max: 10, // stricter in prod
      message: { message: 'Too many requests, please try again later.' },
      standardHeaders: true,
      legacyHeaders: false,
    },
    api: {
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: { message: 'Too many requests, please try again later.' },
      standardHeaders: true,
      legacyHeaders: false,
    },
    // Public, unauthenticated route that fans out to Stripe on cache miss.
    // Tighter window than `api` to harden against Stripe-API-quota DoS.
    billingPlans: {
      windowMs: 60 * 1000,
      max: 30,
      message: { message: 'Too many requests, please try again later.' },
      standardHeaders: true,
      legacyHeaders: false,
    },
  },
  log: {
    format: 'custom',
    pattern:
      ':requestId :id :email :remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"', // only for custom format
    json: true,
    level: 'info',
  },
};

export default config;
