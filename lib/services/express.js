 
 
/**
 * Module dependencies.
 */
import express from 'express';
import bodyParser from 'body-parser';
import compress from 'compression';
import methodOverride from 'method-override';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'path';
import _ from 'lodash';
import lusca from 'lusca';
import cors from 'cors';
import cons from 'consolidate';
import morgan from 'morgan';
import fs from 'fs';
import YAML from 'js-yaml';
import swaggerUi from 'swagger-ui-express';

import config from '../../config/index.js';
import logger from './logger.js';

/**
 * Initialize Swagger
 */
const initSwagger = (app) => {
  if (config.swagger.enable) {
    // Merge files.
    try {
      const contents = config.files.swagger.map((filePath) => YAML.load(fs.readFileSync(filePath).toString()));
      const merged = contents.reduce(_.merge);
      fs.writeFile('./public/swagger.yml', YAML.dump(merged), (error) => {
        if (error) {
          throw error;
        }
      });
    } catch (e) {
      throw new Error(e);
    }

    app.use(config.swagger.options.swaggerUrl, express.static('./public/swagger.yml'));
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(null, config.swagger.options));
  }
};

/**
 * Initialize local variables
 */
const initLocalVariables = (app) => {
  // Setting application local variables
  app.locals.title = config.app.title;
  app.locals.description = config.app.description;
  if (config.secure && config.secure.ssl === true) app.locals.secure = config.secure.ssl;
  app.locals.keywords = config.app.keywords;
  app.locals.env = process.env.NODE_ENV;
  app.locals.domain = config.domain;
  // Passing the request url to environment locals
  app.use((req, res, next) => {
    res.locals.host = `${req.protocol}://${req.hostname}`;
    res.locals.url = `${req.protocol}://${req.headers.host}${req.originalUrl}`;
    next();
  });
};

/**
 * Initialize application middleware
 */
const initMiddleware = (app) => {
  // Should be placed before express.static
  app.use(
    compress({
      filter(req, res) {
        return /json|text|javascript|css|font|svg/.test(res.getHeader('Content-Type'));
      },
      level: 9,
    }),
  );
  // Enable logger (morgan) if enabled in the configuration file
  if (_.has(config, 'log.format') && process.env.NODE_ENV !== 'test') {
    morgan.token('id', (req) => _.get(req, 'user.id') || 'Unknown id');
    morgan.token('email', (req) => _.get(req, 'user.email') || 'Unknown email');
    app.use(morgan(logger.getLogFormat(), logger.getMorganOptions()));
  }
  // Request body parsing middleware should be above methodOverride
  app.use(
    bodyParser.urlencoded({
      extended: true,
    }),
  );
  app.use(bodyParser.json(config.bodyParser));
  app.use(methodOverride());
  // Add the cookie parser and flash middleware
  app.use(cookieParser());
  app.use(
    cors({
      origin: config.cors.origin || [],
      credentials: config.cors.credentials || false,
      optionsSuccessStatus: config.cors.optionsSuccessStatus || 200, // some legacy browsers (IE11, various SmartTVs) choke on 204
    }),
  );
};

/**
 * Invoke modules server configuration
 */
const initModulesConfiguration = async (app) => {
  for (const configPath of config.files.configs) {
    const route = await import(path.resolve(configPath));
    route.default(app);
  }
};

/**
 * Configure Helmet headers configuration
 */
const initHelmetHeaders = (app) => {
  const SIX_MONTHS = 15778476000;
  app.use(helmet.frameguard());
  app.use(helmet.xssFilter());
  app.use(helmet.noSniff());
  app.use(helmet.ieNoOpen());
  app.use(
    helmet.hsts({
      maxAge: SIX_MONTHS,
      includeSubDomains: true,
      force: true,
    }),
  );
  app.disable('x-powered-by');
};

/**
 * Configure the modules static routes
 */
const initModulesClientRoutes = (app) => {
  app.use('/', express.static(path.resolve('./public'), { maxAge: 86400000 }));
};

/**
 * Configure the modules ACL policies
 */
const initModulesServerPolicies = async () => {
  for (const policyPath of config.files.policies) {
    const policy = await import(path.resolve(policyPath));
    policy.default.invokeRolesPolicies();
  }
};

/**
 * Configure the modules server routes
 */
const initModulesServerRoutes = async (app) => {
  for (const routePath of config.files.routes) {
    const route = await import(path.resolve(routePath));
    route.default(app);
  }
  app.get('/{*path}', (req, res) => {
    res.send('<center><br /><h1>Devkit Node Api</h1><h3>Available on <a href="/api/tasks">/api</a>. #LetsGetTogether</h3></center>');
  });
};

/**
 * Configure error handling
 */
const initErrorRoutes = (app) => {
  app.use((err, req, res, next) => {
    if (!err) return next();
    console.error(err.stack);
    res.status(err.status || 500).send({
      message: err.message,
      code: err.code,
    });
  });
};

/**
 * set rendering Engine
 */
const setEngine = (app) => {
  app.engine('html', cons.swig);
  app.set('view engine', 'html');
  app.set('views', path.resolve('config/templates'));
};

/**
 * Initialize the Express application
 */
const init = async () => {
  // Initialize express app
  const app = express();
  // Initialize modules swagger doc
  initSwagger(app);
  // Initialize local variables
  initLocalVariables(app);
  // Initialize Express middleware
  initMiddleware(app);
  // Initialize Helmet security headers
  initHelmetHeaders(app);
  // Initialize modules static client routes,
  initModulesClientRoutes(app);
  // add lusca csrf
  app.use(lusca(config.csrf));
  // Initialize Modules configuration
  await initModulesConfiguration(app);
  // Initialize modules server authorization policies
  await initModulesServerPolicies(app);
  // Initialize modules server routes
  await initModulesServerRoutes(app);
  // Initialize error routes
  initErrorRoutes(app);
  // Set engine
  setEngine(app);
  return app;
};

export default {
  initSwagger,
  initLocalVariables,
  initMiddleware,
  initModulesConfiguration,
  initHelmetHeaders,
  initModulesClientRoutes,
  initModulesServerPolicies,
  initModulesServerRoutes,
  initErrorRoutes,
  setEngine,
  init,
};
