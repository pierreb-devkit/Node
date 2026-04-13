 
 
/**
 * Module dependencies.
 */
import express from 'express';
import compress from 'compression';
import methodOverride from 'method-override';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'path';
import _ from 'lodash';
import lusca from 'lusca';
import cors from 'cors';
import morgan from 'morgan';
import fs from 'fs';
import YAML from 'js-yaml';
import redoc from 'redoc-express';

import config from '../../config/index.js';
import guidesHelper from '../helpers/guides.js';
import logger from './logger.js';
import requestId from '../middlewares/requestId.js';
import sentry from './sentry.js';
import AnalyticsService from './analytics.js';
import analyticsMiddleware from '../middlewares/analytics.js';

/**
 * Initialize API documentation (Redoc UI + JSON spec endpoint)
 * @param {object} app - express application instance
 * @returns {void}
 */
const initSwagger = (app) => {
  if (config.swagger.enable) {
    if (!config.files.swagger || config.files.swagger.length === 0) {
      logger.warn('[swagger] no swagger files configured — skipping API docs');
      return;
    }
    // Merge all module OpenAPI YAML files into a single spec
    // Use mergeWith to concatenate arrays (tags, servers, security) instead of merging by index
    const contents = config.files.swagger
      .map((filePath) => {
        try {
          const doc = YAML.load(fs.readFileSync(filePath).toString());
          if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
            logger.warn(`[swagger] skipping ${filePath}: YAML did not parse to a plain object`);
            return null;
          }
          return doc;
        } catch (err) {
          throw new Error(`[swagger] failed to load ${filePath}: ${err.message}`, { cause: err });
        }
      })
      .filter(Boolean);
    const spec = contents.reduce(
      (acc, doc) =>
        _.mergeWith(acc, doc, (objValue, srcValue) => {
          if (Array.isArray(objValue)) return objValue.concat(srcValue);
          return undefined;
        }),
      {},
    );

    if (Object.keys(spec).length === 0) {
      logger.warn('[swagger] all YAML files were skipped — no valid spec to serve');
      return;
    }

    // Inject runtime-resolved metadata from config so each downstream project
    // advertises its own title, description, and public domain in the spec.
    spec.info = {
      ...(spec.info || {}),
      title: config.app.title,
      description: config.app.description,
    };
    spec.servers = [{ url: config.domain || 'http://localhost:3000' }];

    // Merge per-module markdown guides into info.description so Redoc
    // renders them in its sidebar alongside the OpenAPI reference.
    const guides = guidesHelper.loadGuides(config.files.guides || []);
    guidesHelper.mergeGuidesIntoSpec(spec, guides);
    if (guides.length > 0) {
      logger.info(`[swagger] merged ${guides.length} markdown guide(s) into API reference`);
    }

    /**
     * Serve the merged OpenAPI spec as JSON.
     * @param {import('express').Request} _req - Incoming request (unused).
     * @param {import('express').Response} res - Express response.
     * @returns {void}
     */
    const serveSpec = (_req, res) => {
      res.json(spec);
    };

    // Serve the merged spec as JSON
    app.get('/api/spec.json', serveSpec);

    // Mount Redoc API reference UI — consumes the spec via URL (not inline).
    // Equivalents for the previous Scalar `hideModels` behavior: hide the
    // download button and schema titles, and expand common success responses
    // so the reference feels compact and consumer-focused.
    app.get(
      '/api/docs',
      redoc({
        title: config.app.title,
        specUrl: '/api/spec.json',
        redocOptions: {
          hideDownloadButton: true,
          hideSchemaTitles: true,
          expandResponses: '200,201',
        },
      }),
    );
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
 * Initialize pre-parser routes (mounted before body parsing and CSRF)
 * @param {object} app - express application instance
 * @returns {Promise<void>}
 */
const initPreParserRoutes = async (app) => {
  for (const routePath of config.files.preRoutes) {
    try {
      const route = await import(path.resolve(routePath));
      if (typeof route.default !== 'function') {
        logger.warn(`Pre-parser route ${routePath} does not export a default function`);
        continue;
      }
      route.default(app);
    } catch (err) {
      logger.error(`Failed to load pre-parser route: ${routePath}`, err);
      throw err;
    }
  }
};

/**
 * Initialize application middleware.
 * @param {object} app - express application instance
 */
const initMiddleware = (app) => {
  // Trust proxy — required behind reverse proxies (Nginx, Traefik, LB)
  if (config.trust && config.trust.proxy) app.set('trust proxy', true);
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
    morgan.token('requestId', (req) => req.id || '-');
    morgan.token('orgId', (req) => _.get(req, 'organization.id') || _.get(req, 'organization._id', '-'));
    app.use(morgan(logger.getLogFormat(), logger.getMorganOptions()));
  }
  // Request body parsing middleware should be above methodOverride
  app.use(
    express.urlencoded({
      extended: true,
    }),
  );
  app.use(express.json(config.bodyParser));
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
    await route.default(app);
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
 * Configure the modules ACL policies via auto-discovery.
 * Each policy file exports named ability builder functions
 * that are registered with the central policy middleware.
 * @returns {Promise<void>}
 */
const initModulesServerPolicies = async () => {
  const policyMod = await import('../middlewares/policy.js');
  await policyMod.default.discoverPolicies(config.files.policies);
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
    logger.error(err.stack);
    res.status(err.status || 500).send({
      message: err.message,
      code: err.code,
    });
  });
};

/**
 * Initialize the Express application.
 *
 * @returns {Promise<import('express').Express>} Configured Express app
 */
const init = async () => {
  // Initialize express app
  const app = express();
  // Initialize modules swagger doc
  initSwagger(app);
  // Initialize local variables
  initLocalVariables(app);
  // Assign a unique request ID before any route registration
  app.use(requestId);
  // Initialize pre-parser routes (before body parsing, CSRF, and analytics)
  await initPreParserRoutes(app);
  // Initialize analytics (PostHog) and mount auto-capture middleware
  // Mounted after pre-parser routes so webhooks are not tracked
  // Wrapped in try/catch so analytics failures never prevent app startup
  try {
    await AnalyticsService.init();
    app.use(analyticsMiddleware);
  } catch (err) {
    logger.warn('[analytics] init failed, running without analytics: %s', err.message);
  }
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
  // Mount Sentry error handler (must be after routes, before generic error handler)
  sentry.setupExpressErrorHandler(app);
  // Initialize error routes
  initErrorRoutes(app);
  return app;
};

export default {
  initSwagger,
  initLocalVariables,
  initPreParserRoutes,
  initMiddleware,
  initModulesConfiguration,
  initHelmetHeaders,
  initModulesClientRoutes,
  initModulesServerPolicies,
  initModulesServerRoutes,
  initErrorRoutes,
  init,
};
