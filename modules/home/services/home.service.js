/**
 * Module dependencies
 */
import axios from 'axios';
import path from 'path';
import _ from 'lodash';
import { Base64 } from 'js-base64';
import { promises as fs } from 'fs';
import mongoose from 'mongoose';

import config from '../../../config/index.js';
import mailer from '../../../lib/helpers/mailer/index.js';
import HomeRepository from '../repositories/home.repository.js';
import { removeSensitive } from '../../users/utils/sanitizeUser.js';

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
 * @desc Fetch releases from configured GitHub repos. Returns an empty array on API failure (graceful degradation).
 * @return {Promise<Array<{title: string, list: Array}>>} Releases grouped by repo, or [] on error
 */
const releases = async () => {
  try {
    const requests = config.repos.map((item) =>
      axios.get(`https://api.github.com/repos/${item.owner}/${item.repo}/releases`, {
        headers: item.token ? { Authorization: `token ${item.token}` } : {},
      }),
    );
    let results = await axios.all(requests);
    results = results.map((result, i) => ({
      title: config.repos[i].title,
      list: result.data.map((release) => ({
        name: release.name,
        prerelease: release.prerelease,
        published_at: release.published_at,
      })),
    }));
    return results;
  } catch (_err) {
    return [];
  }
};

/**
 * @desc Fetch changelogs from configured GitHub repos. Returns an empty array on API failure (graceful degradation).
 * @return {Promise<Array<{title: string, markdown: string}>>} Changelogs grouped by repo, or [] on error
 */
const changelogs = async () => {
  try {
    const repos = _.filter(config.repos, (repo) => repo.changelog);
    const requests = repos.map((item) =>
      axios.get(`https://api.github.com/repos/${item.owner}/${item.repo}/contents/${item.changelog}`, {
        headers: item.token ? { Authorization: `token ${item.token}` } : {},
      }),
    );
    let results = await axios.all(requests);
    results = results.map((result, i) => ({
      title: repos[i].title,
      markdown: Base64.decode(result.data.content),
    }));
    return results;
  } catch (_err) {
    return [];
  }
};

/**
 * @desc Function to get all admin users in db
 * @returns {Promise<Array>} All users (sanitized)
 */
const team = async () => {
  const result = await HomeRepository.team();
  return result.map((user) => removeSensitive(user));
};

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
  const jwtSecret = config.jwt?.secret;
  const jwtInsecure = !jwtSecret || jwtSecret.trim() === '' || jwtSecret === 'WaosSecretKeyExampleToChnageAbsolutely';
  checks.push({
    category: 'security',
    status: jwtInsecure ? 'warning' : 'ok',
    message: jwtInsecure ? 'JWT secret is missing or default — change it before production' : 'JWT secret is custom',
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
  releases,
  changelogs,
  team,
  getHealthStatus,
  getReadinessStatus,
};
