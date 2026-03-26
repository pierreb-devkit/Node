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
  sentry: {
    dsn: process.env.DEVKIT_NODE_sentry_dsn || '',
    environment: process.env.DEVKIT_NODE_sentry_environment || 'development',
    enabled: false,
  },
  domain: '',
  cookie: {
    secure: false, // false in dev (HTTP localhost)
    sameSite: 'strict',
  },
  mailer: {
    provider: 'DEVKIT_NODE_mailer_provider',
    from: 'DEVKIT_NODE_mailer_from',
    options: {
      service: 'DEVKIT_NODE_mailer_options_service',
      auth: {
        user: 'DEVKIT_NODE_mailer_options_auth_user',
        pass: 'DEVKIT_NODE_mailer_options_auth_pass',
      },
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
};

export default config;
