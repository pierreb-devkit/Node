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

const STANDARD_ENVS = new Set(['development', 'production', 'test']);

/**
 * Validates that a NODE_ENV value is safe for use in glob patterns and file paths.
 * Rejects values containing glob metacharacters or path separators.
 * @param {string} env
 * @throws {Error} if env is not a safe identifier
 */
const assertSafeEnv = (env) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(env)) {
    throw new Error(`NODE_ENV "${env}" contains unsafe characters. Only alphanumerics, underscores, and hyphens are allowed.`);
  }
};

/**
 * Deep merge two objects, replacing arrays instead of merging by index.
 * @param {Object} target - Base object
 * @param {Object} source - Override object
 * @returns {Object} Merged result (new object, inputs are not mutated)
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const deepMerge = (target, source) => {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const srcVal = source[key];
    if (srcVal === undefined) continue;
    const tgtVal = result[key];
    if (Array.isArray(srcVal)) {
      result[key] = [...srcVal];
    } else if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) && tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
};

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
    merged = deepMerge(merged, mod);
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
  assertSafeEnv(env);

  // Layer 1: module defaults (base layer)
  let config = await loadModuleConfigs('modules/*/config/*.development.config.js');

  // Layer 2: global development defaults
  const globalDevPath = path.join(process.cwd(), 'config', 'defaults', 'development.config.js');
  if (fs.existsSync(globalDevPath)) {
    const globalDev = await loadConfigFile(globalDevPath);
    config = deepMerge(config, globalDev);
  }

  // Layer 3: environment overrides (only if not development)
  if (env !== 'development') {
    // (Module env overrides removed — env overrides are central only)

    // Layer 3: global env override
    const globalEnvPath = path.join(process.cwd(), 'config', 'defaults', `${env}.config.js`);
    const hasGlobalEnvConfig = fs.existsSync(globalEnvPath);
    if (hasGlobalEnvConfig) {
      const globalEnv = await loadConfigFile(globalEnvPath);
      config = deepMerge(config, globalEnv);
    }

    // Layer 3.5: per-module project overrides (modules/*/config/*.{project}.config.js)
    // Only applies for non-standard envs (i.e. a downstream project name, the NODE_ENV value)
    if (!STANDARD_ENVS.has(env)) {
      const moduleProjectPattern = `modules/*/config/*.${env}.config.js`;
      const moduleProjectFiles = await configHelper.getGlobbedPaths(moduleProjectPattern);
      if (moduleProjectFiles.length > 0) {
        let moduleProjectConfig = {};
        for (const file of moduleProjectFiles) {
          const mod = await loadConfigFile(path.resolve(file));
          moduleProjectConfig = deepMerge(moduleProjectConfig, mod);
        }
        config = deepMerge(config, moduleProjectConfig);
      } else if (!hasGlobalEnvConfig) {
        // Warn only when no config exists at all (neither global nor per-module)
        console.warn(
          chalk.yellow(`+ Warning: NODE_ENV="${env}" but no ${env}.config.js found in config/defaults/ and no *.${env}.config.js in modules/ — using development defaults. Downstream projects should create config files (see README).`),
        );
      }
    }
  }

  // Layer 4: DEVKIT_NODE_* env vars (final override)
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
  config = deepMerge(config, environmentConfigVars);

  // read package.json for project information
  const packageJSON = JSON.parse(readFileSync(path.resolve('./package.json')));
  config = deepMerge(config, { package: packageJSON });
  // Initialize global globbed files
  config = deepMerge(config, { files: await configHelper.initGlobalConfigFiles(assets) });
  // Filter files by module activation (deactivated modules are excluded)
  const fileKeys = ['openapi', 'guides', 'mongooseModels', 'preRoutes', 'routes', 'configs', 'policies'];
  for (const key of fileKeys) {
    if (config.files[key]) {
      config.files[key] = configHelper.filterByActivation(config.files[key], config);
    }
  }
  // Exclude doc files (OpenAPI YAML + guides) for modules listed in
  // config.docs.excludeModules — independent of runtime activation, so it works
  // even for core modules. Empty/missing list = no-op.
  const docFileKeys = ['openapi', 'guides'];
  for (const key of docFileKeys) {
    if (config.files[key]) {
      config.files[key] = configHelper.filterByDocExclusion(config.files[key], config);
    }
  }
  // Init Secure SSL if can be used
  configHelper.initSecureMode(config);
  // Print a warning if config.domain is not set
  if (process.env.NODE_ENV !== 'test') configHelper.validateDomainIsSet(config);
  if (process.env.NODE_ENV !== 'test') configHelper.validateJwtSecret(config);

  // Per-process DB isolation (single mechanism — #3563):
  // Append _p${pid}_w${workerId} to db.uri so every jest invocation hits its own
  // isolated MongoDB database. This covers both:
  //   - Multi-worktree agent batches running npm run test:coverage in parallel
  //     (each process has a distinct pid; workerId = '0' when JEST_WORKER_ID is unset).
  //   - Jest --maxWorkers > 1 within a single invocation (each worker has a distinct
  //     JEST_WORKER_ID; pid anchors the invocation, workerId anchors the in-process worker).
  // The globalSetup main process (no JEST_WORKER_ID) gets suffix _p${pid}_w0 — it always
  // operates on the correct unsuffixed-for-sibling-isolation URI for drop+migrate.
  // CI sets DEVKIT_NODE_db_uri explicitly (Layer 4), so the suffix appends after that
  // override and remains unique across concurrent CI runs on the same mongod.
  if (process.env.NODE_ENV === 'test') {
    const pid = process.pid;
    const workerId = process.env.JEST_WORKER_ID ?? '0';
    const suffix = `_p${pid}_w${workerId}`;
    const uri = config.db?.uri ?? '';
    if (uri) {
      // Use the URL API to safely append the suffix to the database name
      // in the path segment, avoiding corruption of host/port or query string.
      const parsed = new URL(uri);
      const dbName = parsed.pathname.replace(/^\//, '') || 'test';
      if (!dbName.endsWith(suffix)) {
        parsed.pathname = `/${dbName}${suffix}`;
        config.db.uri = parsed.toString();
      }
    }
  }

  // Expose configuration utilities
  const conf = { ...config };
  conf.utils = {
    getGlobbedPaths: configHelper.getGlobbedPaths,
  };
  return conf;
};

/**
 * Normalize billing.planDefinitions to the canonical array-of-objects shape.
 *
 * Accepts either:
 *  - Array (new shape): returned as-is.
 *  - Plain object (legacy shape): converted to array and a deprecation warning is emitted.
 *    The object key is always authoritative as planId; any nested planId value is overridden.
 *
 * Safe when planDefinitions is missing/null — returns the input unchanged.
 * Non-object, non-array values (e.g. strings) are returned unchanged.
 *
 * @param {Array|Object|null|undefined} planDefinitions
 * @returns {Array|Object|null|undefined} Array form when convertible; original value otherwise.
 */
const normalizePlanDefinitions = (planDefinitions) => {
  if (!planDefinitions) return planDefinitions;
  if (Array.isArray(planDefinitions)) return planDefinitions;
  if (typeof planDefinitions === 'object') {
    console.warn(
      '[billing] planDefinitions object shape is deprecated, switch to array — see docs/migrations/2026-05-01-billing-plan-definitions-array.md. Will be removed ~2026-07.',
    );
    return Object.entries(planDefinitions).map(([planId, def]) => ({ ...(def ?? {}), planId }));
  }
  return planDefinitions;
};

const config = await initGlobalConfig();

// Post-merge billing normalization: shim legacy planDefinitions + derive plans enum.
if (config.billing?.planDefinitions != null) {
  config.billing.planDefinitions = normalizePlanDefinitions(config.billing.planDefinitions);
  if (Array.isArray(config.billing.planDefinitions)) {
    config.billing.plans = config.billing.planDefinitions
      .map((p) => p.planId)
      .filter((id) => typeof id === 'string' && id.length > 0);
  }
}

export { deepMerge, assertSafeEnv, normalizePlanDefinitions };
export default config;
