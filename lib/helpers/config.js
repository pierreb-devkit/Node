/**
 * Module dependencies.
 */
import _ from 'lodash';
import chalk from 'chalk';
import { glob } from 'glob';
import fs from 'fs';
import path from 'path';

/**
 * Get files by glob patterns.
 * @param {string|string[]} globPatterns - glob pattern(s) to resolve
 * @param {string|string[]} [excludes] - substring(s) to strip from matched paths
 * @returns {Promise<string[]>} resolved file paths
 */
const getGlobbedPaths = async (globPatterns, excludes) => {
  // URL paths regex
  /* eslint no-useless-escape:0 */
  const urlRegex = /^(?:[a-z]+:)?\/\//i;
  let output = [];
  // If glob pattern is array then we use each pattern in a recursive way, otherwise we use glob
  if (_.isArray(globPatterns)) {
    for (const globPattern of globPatterns) {
      output = _.union(output, await getGlobbedPaths(globPattern, excludes));
    }
  } else if (_.isString(globPatterns)) {
    if (urlRegex.test(globPatterns)) {
      output.push(globPatterns);
    } else {
      let files = glob.sync(globPatterns.replace(/\\/g, '/'));
      if (excludes) {
        files = files.map((file) => {
          if (_.isArray(excludes)) {
            excludes.forEach((exclude) => {
              file = file.replace(exclude, '');
            });
          } else {
            file = file.replace(excludes, '');
          }
          return file;
        });
      }
      output = _.union(output, files);
    }
  }
  return output;
};

/** Validate config.domain is set
 */
const validateDomainIsSet = (config) => {
  if (!config.domain) {
    console.log(chalk.red('+ Important warning: config.domain is empty. It should be set to the fully qualified domain of the app.'));
  }
};

/**
 * Known default / placeholder JWT secret values that must never be used in
 * non-dev environments.  Extend this list when a new project is bootstrapped
 * with its own placeholder secret.
 * @readonly
 */
const JWT_DEFAULT_SECRETS = Object.freeze(new Set([
  'WaosSecretKeyExampleToChnageAbsolutely', // upstream placeholder
  'ExampleNodeDevSecret', // generic project placeholder
  'ChangeThisDevSecret', // generic placeholder
]));

/**
 * @desc Canonical JWT weakness predicate — single source of truth.
 *   Returns true when the secret is empty, whitespace-only, shorter than 32
 *   characters, or matches a known default placeholder.
 * @param {string|null|undefined} secret - raw JWT secret value
 * @returns {boolean}
 */
const isJwtSecretWeak = (secret) => !secret || secret.trim() === '' || secret.length < 32 || JWT_DEFAULT_SECRETS.has(secret);

/**
 * Safe envs where a weak / default secret is tolerated (warn only).
 * Also the single source of truth for the dev-vs-prod hardening predicate:
 * any NODE_ENV outside this set is treated as a production-grade deployment.
 */
const DEV_ENVS = new Set(['development', 'test', 'local']);

/**
 * @desc Predicate — is the given env a known development-grade env?
 *  Used to gate production hardening. The deployment model runs apps under
 *  arbitrary NODE_ENV labels, so "dev" is an explicit allow-list (DEV_ENVS),
 *  never a literal `=== 'development'` check.
 * @param {string} [env=process.env.NODE_ENV??'development'] - environment name (read at call time); defaults to 'development' when NODE_ENV is unset
 * @returns {boolean} true when env is one of development/test/local
 */
const isDevEnv = (env = process.env.NODE_ENV ?? 'development') => DEV_ENVS.has(env);

/**
 * @desc Predicate — should production hardening apply to the given env?
 *  Inverse of {@link isDevEnv}: true for `production` AND for any non-dev label
 *  (e.g. a deployment env name), so hardening is secure-by-default off any
 *  non-dev env, not just the literal `production`.
 * @param {string} [env=process.env.NODE_ENV??'development'] - environment name (read at call time); defaults to 'development' when NODE_ENV is unset
 * @returns {boolean} true when env is NOT one of development/test/local
 */
const isProd = (env = process.env.NODE_ENV ?? 'development') => !DEV_ENVS.has(env);

/**
 * @desc Validate JWT secret strength.
 *  - In non-dev/non-test environments: throw (fail-closed) when the secret is
 *    empty, shorter than 32 chars, or matches a known default placeholder.
 *  - In dev/test/local: keep the existing console.log warn so local and CI
 *    boots still succeed.
 * @param {object} config - application configuration object
 * @returns {void}
 */
const validateJwtSecret = (config) => {
  const secret = config.jwt?.secret;
  const env = process.env.NODE_ENV ?? 'development';

  const isWeak = isJwtSecretWeak(secret);

  if (!isWeak) return; // strong secret — nothing to do

  const message = '+ Important warning: JWT secret is empty, too short (< 32 chars), or set to a known default placeholder. Set a strong secret via DEVKIT_NODE_jwt_secret.';

  if (isDevEnv(env)) {
    console.log(chalk.red(message));
    return;
  }

  // Non-dev environments: fail closed — crash loud rather than run insecurely.
  throw new Error(`[security] validateJwtSecret: ${message}`);
};

/**
 * Validate secure parameters and create SSL credentials.
 * @param {object} config - application configuration object
 * @returns {true|undefined} returns true when SSL is not enabled
 */
const initSecureMode = (config) => {
  if (!config.secure || config.secure.ssl !== true) return true;

  const keyPath = config.secure.key || config.secure.privateKey;
  const certPath = config.secure.cert || config.secure.certificate;

  if (!keyPath || !certPath) {
    console.log(chalk.red('+ Error: Certificate file or key file path is not configured, falling back to non-SSL mode'));
    config.secure.ssl = false;
    return;
  }

  const key = fs.existsSync(path.resolve(keyPath));
  const cert = fs.existsSync(path.resolve(certPath));

  if (!key || !cert) {
    console.log(chalk.red('+ Error: Certificate file or key file is missing, falling back to non-SSL mode'));
    console.log(chalk.red('  To create them: openssl req -newkey rsa:4096 -nodes -keyout <key> -x509 -days 365 -out <cert> -subj "/CN=localhost"'));
    console.log();
    config.secure.ssl = false;
  } else {
    config.secure.credentials = {
      key: fs.readFileSync(path.resolve(keyPath)),
      cert: fs.readFileSync(path.resolve(certPath)),
    };
  }
};

/**
 * Core modules that are always active regardless of the `activated` flag.
 */
const CORE_MODULES = new Set(['core', 'auth', 'users', 'home']);

/**
 * Extract the module name from a file path.
 * E.g. `modules/tasks/routes/tasks.routes.js` → `tasks`
 * @param {string} filePath
 * @returns {string|null} module name or null if not inside modules/
 */
const extractModuleName = (filePath) => {
  const normalizedPath = String(filePath).replace(/\\/g, '/');
  const match = normalizedPath.match(/modules\/([^/]+)\//);
  return match ? match[1] : null;
};

/**
 * Filter file paths by module activation config.
 * Files belonging to deactivated modules are excluded.
 * Core modules are never filtered out.
 * Missing `activated` key defaults to active (true).
 *
 * NOTE: Changing the `activated` flag for a module in the environment config requires
 * a full application restart to take effect — the file list is resolved at startup
 * and is not re-evaluated at runtime.
 *
 * @param {string[]} files - array of file paths
 * @param {object} config - merged configuration object
 * @returns {string[]} filtered file paths
 */
const filterByActivation = (files, config) => files.filter((file) => {
  const moduleName = extractModuleName(file);
  if (!moduleName) return true; // not a module file, keep it
  if (CORE_MODULES.has(moduleName)) return true; // core modules always active
  const moduleConfig = config[moduleName];
  if (!moduleConfig || moduleConfig.activated === undefined) return true; // default to active
  return moduleConfig.activated !== false;
});

/**
 * Initialize global configuration files by resolving asset glob patterns.
 *
 * Globs each category of files (swagger YAML, markdown guides, mongoose
 * models, routes, configs, policies) from the provided asset patterns and
 * returns them as a flat `files` object that is later merged into the
 * runtime config and filtered by module activation.
 *
 * @param {object} assets - Asset glob patterns (see `config/assets.js`).
 * @returns {Promise<object>} Object keyed by file category with resolved file paths.
 */
const initGlobalConfigFiles = async (assets) => {
  const files = {}; // Appending files
  files.swagger = await getGlobbedPaths(assets.allYaml); // Setting Globbed module yaml files
  files.guides = await getGlobbedPaths(assets.allGuides); // Setting Globbed module markdown guide files
  files.mongooseModels = await getGlobbedPaths(assets.mongooseModels); // Setting Globbed mongoose model files
  files.preRoutes = await getGlobbedPaths(assets.preRoutes); // Setting Globbed pre-parser route files
  files.routes = await getGlobbedPaths(assets.routes); // Setting Globbed route files
  files.configs = await getGlobbedPaths(assets.config); // Setting Globbed config files
  // files.sockets = getGlobbedPaths(assets.sockets); // Setting Globbed socket files
  files.policies = await getGlobbedPaths(assets.policies); // Setting Globbed policies files
  return files;
};

export default {
  getGlobbedPaths,
  validateDomainIsSet,
  JWT_DEFAULT_SECRETS,
  isJwtSecretWeak,
  isDevEnv,
  isProd,
  validateJwtSecret,
  initSecureMode,
  initGlobalConfigFiles,
  filterByActivation,
  CORE_MODULES,
};
