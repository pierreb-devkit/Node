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
 * @desc Warn if JWT secret is still set to the default placeholder value.
 * @param {object} config - application configuration object
 * @returns {void}
 */
const validateJwtSecret = (config) => {
  if (config.jwt && config.jwt.secret === 'WaosSecretKeyExampleToChnageAbsolutely') {
    console.log(chalk.red('+ Important warning: JWT secret is set to the default value. It should be changed in production via DEVKIT_NODE_jwt_secret.'));
  }
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
    console.log(chalk.red('  To create them, simply run the following from your shell: sh ./scripts/generate-ssl-certs.sh'));
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
 * Initialize global configuration files
 */
const initGlobalConfigFiles = async (assets) => {
  const files = {}; // Appending files
  files.swagger = await getGlobbedPaths(assets.allYaml); // Setting Globbed module yaml files
  files.mongooseModels = await getGlobbedPaths(assets.mongooseModels); // Setting Globbed mongoose model files
  files.sequelizeModels = await getGlobbedPaths(assets.sequelizeModels); // Setting Globbed sequelize model files
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
  validateJwtSecret,
  initSecureMode,
  initGlobalConfigFiles,
  filterByActivation,
  CORE_MODULES,
};
