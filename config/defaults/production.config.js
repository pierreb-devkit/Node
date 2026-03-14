const config = {
  app: {
    title: 'Devkit Node - Production Environment',
  },
  api: {
    host: '0.0.0.0',
    port: 4200,
  },
  db: {
    uri: 'mongodb://127.0.0.1:27017/WaosNode',
    debug: false,
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
  },
  log: {
    format: 'custom',
    pattern:
      ':id :email :remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"', // only for custom format
  },
};

export default config;
