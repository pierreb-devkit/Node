const config = {
  app: {
    title: 'Devkit Node - Development Environment',
    description: 'Node - Boilerplate Back : Express, Jwt, Mongo, Sequelize (Beta) ',
    keywords: 'node, express, mongo, jwt, sequelize, stack, boilerplate',
    googleAnalyticsTrackingID: 'DEVKIT_NODE_app_googleAnalyticsTrackingID',
    contact: 'contact@example.com',
  },
  swagger: {
    enable: true,
    options: {
      swaggerUrl: '/api/docs/swagger.yml',
      explore: true,
    },
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
    pattern: ':id :email :method :url :status :response-time ms - :res[content-length]', // only for custom format
    fileLogger: {
      directoryPath: process.cwd(),
      fileName: 'app.log',
      maxsize: 10485760,
      maxFiles: 2,
      json: false,
    },
  },
  // orm: {
  //    dbname: 'WaosNodeDev',
  //    user: '',
  //    pass: '',
  //    options: {
  //      // sequelize supports one of: mysql, postgres, sqlite, mariadb and mssql.
  //      dialect: 'postgres',
  //      host: '',
  //      port: ''
  //    }
  //  },
  // Lusca config
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
  cors: {
    origin: ['http://localhost:8080'],
    credentials: true,
  },
  trust: {
    proxy: false,
  },
  domain: '',
  cookie: {
    secure: false, // false in dev (HTTP localhost)
    sameSite: 'strict',
  },
  rateLimit: {
    auth: {
      windowMs: 15 * 60 * 1000, // 15 min
      max: 20, // 20 requests per window in dev (more lenient)
      message: { message: 'Too many requests, please try again later.' },
      standardHeaders: true,
      legacyHeaders: false,
    },
  },
  // validation is used to manage schema restrictions, on the top of mongo / orm
  validation: {
    // enabled HTTP methods for request data validation
    supportedMethods: ['post', 'put'],
  },
};

export default config;
