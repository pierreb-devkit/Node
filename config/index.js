/**
 * Module dependencies.
 */
import _ from 'lodash';
import chalk from 'chalk';
import fs, { readFileSync } from 'fs';
import path from 'path';
import objectPath from 'object-path';
import assets from './assets.js';
import configHelper from '../lib/helpers/config.js';
/**
 * Initialize global configuration
 */

const initGlobalConfig = async () => {
  // Get the current config
  const _path = path.join(process.cwd(), './config', 'defaults', `${process.env.NODE_ENV || 'development'}.js`);
  let defaultConfig;
  if (fs.existsSync(`${_path}`)) defaultConfig = await import(_path);
  else {
    console.error(chalk.red(`+ Error: No configuration file found for "${process.env.NODE_ENV}" environment using development instead. (${_path})`));
    defaultConfig = await import(path.join(process.cwd(), './config', 'defaults', 'development.js'));
  }
  // Get the config from  process.env.DEVKIT_NODE_*
  let environmentVars = _.mapKeys(
    _.pickBy(process.env, (_value, key) => key.startsWith('DEVKIT_NODE_')),
    (_v, k) => k.split('_').slice(2).join('.'),
  );
  // convert string array from sys  to real array
  environmentVars = _.mapValues(environmentVars, (v) => (v[0] === '[' && v[v.length - 1] === ']' ? v.replace(/'/g, '').slice(1, -1).split(',') : v));
  const environmentConfigVars = {};
  _.forEach(environmentVars, (v, k) => {
    let value = v;
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    return objectPath.set(environmentConfigVars, k, value);
  });
  // Merge config files
  const config = _.merge(defaultConfig.default, environmentConfigVars);
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
