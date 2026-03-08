/**
 * Module dependencies.
 */
import _ from 'lodash';
import chalk from 'chalk';
import fs, { readFileSync } from 'fs';
import path from 'path';
import objectPath from 'object-path';
import { pathToFileURL } from 'url';
import assets from './assets.js';
import configHelper from '../lib/helpers/config.js';

/**
 * Load a single config file by path.
 * @param {string} filePath - absolute path to the config module
 * @returns {Promise<object>} the default export of the config module, or empty object if missing
 */
const loadConfigFile = async (filePath) => {
  try {
    const mod = await import(pathToFileURL(filePath).href);
    return mod.default || {};
  } catch (err) {
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND' || err.code === 'ENOENT')) {
      return {};
    }
    console.error(chalk.red(`+ Error loading config file ${filePath}: ${err.message || err}`));
    throw err;
  }
};

/**
 * Glob module-level config files and merge them into a single object.
 * @param {string} pattern - glob pattern for module config files
 * @returns {Promise<object>} merged config from all matched files
 */
const loadModuleConfigs = async (pattern) => {
  const files = await configHelper.getGlobbedPaths(pattern);
  let merged = {};
  for (const file of files) {
    const abs = path.resolve(file);
    const mod = await loadConfigFile(abs);
    merged = _.merge(merged, mod);
  }
  return merged;
};

/**
 * Initialize global configuration by layering module defaults, global defaults,
 * environment overrides, and DEVKIT_NODE_* env vars.
 * @returns {Promise<object>} fully merged configuration object
 */
const initGlobalConfig = async () => {
  const env = process.env.NODE_ENV || 'development';

  // Layer 1: module development defaults (base layer)
  let config = await loadModuleConfigs('modules/*/config/config.development.js');

  // Layer 2: global development defaults
  const globalDevPath = path.join(process.cwd(), 'config', 'defaults', 'config.development.js');
  if (fs.existsSync(globalDevPath)) {
    const globalDev = await loadConfigFile(globalDevPath);
    config = _.merge(config, globalDev);
  }

  // Layer 3 & 4: environment overrides (only if not development)
  if (env !== 'development') {
    // Layer 3: module env overrides
    const moduleEnvConfigs = await loadModuleConfigs(`modules/*/config/config.${env}.js`);
    config = _.merge(config, moduleEnvConfigs);

    // Layer 4: global env override
    const globalEnvPath = path.join(process.cwd(), 'config', 'defaults', `config.${env}.js`);
    if (fs.existsSync(globalEnvPath)) {
      const globalEnv = await loadConfigFile(globalEnvPath);
      config = _.merge(config, globalEnv);
    }
  }

  // Layer 5: DEVKIT_NODE_* env vars (final override)
  let environmentVars = _.mapKeys(
    _.pickBy(process.env, (_value, key) => key.startsWith('DEVKIT_NODE_')),
    (_v, k) => k.split('_').slice(2).join('.'),
  );
  // convert string array from sys to real array
  environmentVars = _.mapValues(environmentVars, (v) => (v[0] === '[' && v[v.length - 1] === ']' ? v.replace(/'/g, '').slice(1, -1).split(',') : v));
  const environmentConfigVars = {};
  _.forEach(environmentVars, (v, k) => {
    let value = v;
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    return objectPath.set(environmentConfigVars, k, value);
  });
  config = _.merge(config, environmentConfigVars);

  // read package.json for project information
  const packageJSON = JSON.parse(readFileSync(path.resolve('./package.json')));
  _.merge(config, { package: packageJSON });
  // Initialize global globbed files
  _.merge(config, { files: await configHelper.initGlobalConfigFiles(assets) });
  // Init Secure SSL if can be used
  configHelper.initSecureMode(config);
  // Print a warning if config.domain is not set
  if (process.env.NODE_ENV !== 'test') configHelper.validateDomainIsSet(config);
  // Expose configuration utilities
  const conf = { ...config };
  conf.utils = {
    getGlobbedPaths: configHelper.getGlobbedPaths,
  };
  return conf;
};

export default await initGlobalConfig();
