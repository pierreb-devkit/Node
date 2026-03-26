/**
 * Module dependencies
 */
import axios from 'axios';
import path from 'path';
import _ from 'lodash';
import { Base64 } from 'js-base64';
import { promises as fs } from 'fs';
import mongoose from 'mongoose';

import AuthService from '../../auth/services/auth.service.js';
import config from '../../../config/index.js';
import HomeRepository from '../repositories/home.repository.js';

/**
 * @desc Function to get all admin users in db
 * @return {Promise} All users
 */
const page = async (name) => {
  const markdown = await fs.readFile(path.resolve(`./config/markdown/${name}.md`), 'utf8');
  const test = await fs.stat(path.resolve(`./config/markdown/${name}.md`));
  return Promise.resolve([
    {
      title: _.startCase(name),
      updatedAt: test.mtime,
      markdown,
    },
  ]);
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
 * @return {Promise} All users
 */
const team = async () => {
  const result = await HomeRepository.team();
  return Promise.resolve(result.map((user) => AuthService.removeSensitive(user)));
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

export default {
  page,
  releases,
  changelogs,
  team,
  getHealthStatus,
};
