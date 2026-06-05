/**
 * Module dependencies
 */
import path from 'path';
import _ from 'lodash';
import { promises as fs } from 'fs';
import mongoose from 'mongoose';

import config from '../../../config/index.js';
import mailer from '../../../lib/helpers/mailer/index.js';
import HomeRepository from '../repositories/home.repository.js';

/**
 * @desc Check whether a config value is meaningfully set (non-empty, not a DEVKIT placeholder).
 * @param {*} value - Config value to check
 * @returns {boolean} true when value is a non-empty string and not a DEVKIT_NODE_ placeholder
 */
const isSet = (value) => !!(value && typeof value === 'string' && value.trim() !== '' && !value.startsWith('DEVKIT_NODE_'));

/**
 * @desc Function to get page content from markdown file
 * @param {string} name - The name of the markdown file
 * @returns {Promise<Array>} Page content array
 */
const page = async (name) => {
  const markdown = await fs.readFile(path.resolve(`./config/markdown/${name}.md`), 'utf8');
  const test = await fs.stat(path.resolve(`./config/markdown/${name}.md`));
  return [
    {
      title: _.startCase(name),
      updatedAt: test.mtime,
      markdown,
    },
  ];
};

/**
 * @desc Function to get all admin users in db, returning only public-safe fields.
 * Uses a lean projection so no Mongoose virtuals (e.g. `id`) can re-introduce hidden fields.
 * @returns {Promise<Array<{firstName: string, lastName: string, bio: string, position: string, avatar: string}>>} Public user profiles
 */
const team = async () => HomeRepository.team();

/**
 * @desc Build health status including database connectivity.
 * @returns {{ status: string, db: string, uptime: number, version: string, memory: Object }}
 */
const getHealthStatus = () => {
  const mongoStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const dbState = mongoose.connection.readyState;
  return {
    status: dbState === 1 ? 'ok' : 'degraded',
    db: mongoStates[dbState] || 'unknown',
    uptime: Math.floor(process.uptime()),
    version: config.package?.version || process.env.npm_package_version || '0.0.0',
    memory: process.memoryUsage(),
  };
};

/**
 * @desc Run SaaS readiness checks against current configuration.
 * Each check returns { category, status, message }.
 * @returns {Array<{category: string, status: string, message: string}>}
 */
const getReadinessStatus = () => {
  const checks = [];

  // config — domain
  const domainSet = isSet(config.domain);
  checks.push({
    category: 'config',
    status: domainSet ? 'ok' : 'warning',
    message: domainSet ? 'Domain configured' : 'Domain not configured',
  });

  // security — JWT secret
  // Re-use the same weakness predicate as validateJwtSecret (config helper):
  //   empty / whitespace / < 32 chars / known default placeholder.
  const JWT_DEFAULTS = new Set([
    'WaosSecretKeyExampleToChnageAbsolutely',
    'TrawlNodeDevSecret',
    'ComesNodeDevSecret',
    'MontaineNodeDevSecret',
    'PierrebNodeDevSecret',
    'IsmNodeDevSecret',
  ]);
  const jwtSecret = config.jwt?.secret;
  const jwtInsecure = !jwtSecret || jwtSecret.trim() === '' || jwtSecret.length < 32 || JWT_DEFAULTS.has(jwtSecret);
  checks.push({
    category: 'security',
    status: jwtInsecure ? 'warning' : 'ok',
    message: jwtInsecure ? 'JWT secret is missing, too short (< 32 chars), or a known default — change it before production' : 'JWT secret is custom',
  });

  // auth — OAuth providers
  const oAuthProviders = [];
  if (isSet(config.oAuth?.google?.clientID)) oAuthProviders.push('Google');
  if (isSet(config.oAuth?.apple?.clientID)) oAuthProviders.push('Apple');
  checks.push({
    category: 'auth',
    status: oAuthProviders.length > 0 ? 'ok' : 'warning',
    message: oAuthProviders.length > 0 ? `OAuth configured (${oAuthProviders.join(', ')})` : 'No OAuth provider configured',
  });

  // mail — mailer
  const mailConfigured = mailer.isConfigured();
  checks.push({
    category: 'mail',
    status: mailConfigured ? 'ok' : 'warning',
    message: mailConfigured ? 'Mail provider configured' : 'No mail provider configured',
  });

  // billing — Stripe
  const stripeConfigured = isSet(config.stripe?.secretKey);
  checks.push({
    category: 'billing',
    status: stripeConfigured ? 'ok' : 'warning',
    message: stripeConfigured ? 'Stripe configured' : 'Stripe not configured',
  });

  // analytics — PostHog
  const posthogConfigured = isSet(config.analytics?.posthog?.key);
  checks.push({
    category: 'analytics',
    status: posthogConfigured ? 'ok' : 'warning',
    message: posthogConfigured ? 'PostHog configured' : 'PostHog not configured',
  });

  // errorTracking — PostHog
  const errorTrackingEnabled = posthogConfigured && config.analytics?.posthog?.errorTracking === true;
  checks.push({
    category: 'errorTracking',
    status: errorTrackingEnabled ? 'ok' : 'warning',
    message: errorTrackingEnabled ? 'PostHog $exception capture enabled' : 'PostHog Error Tracking not enabled (set analytics.posthog.errorTracking=true)',
  });

  return checks;
};

export default {
  page,
  team,
  getHealthStatus,
  getReadinessStatus,
};
