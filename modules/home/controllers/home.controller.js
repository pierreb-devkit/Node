/**
 * Module dependencies
 */
import fs from 'fs';

import errors from '../../../lib/helpers/errors.js';
import responses from '../../../lib/helpers/responses.js';
import HomeService from '../services/home.service.js';

/**
 * @desc Endpoint to ask the service to get the list of users
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const team = async (req, res) => {
  try {
    const users = await HomeService.team();
    responses.success(res, 'team list')(users);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc Endpoint to ask the service to get a page
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const page = async (req, res) => {
  try {
    responses.success(res, 'page')(req.page);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

/**
 * @desc MiddleWare to ask the service the file for this name
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @param {String} name - file name
 */
const pageByName = async (req, res, next, name) => {
  try {
    if (!fs.existsSync(`./config/markdown/${name}.md`)) return responses.error(res, 404, 'Not Found', 'No page with that name has been found')();
    const page = await HomeService.page(name);
    req.page = page;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * @desc Health check endpoint
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const health = (req, res) => {
  const data = HomeService.getHealthStatus();
  const isAdmin = req.user?.roles?.includes('admin');
  const payload = isAdmin ? data : { status: data.status };
  if (data.status !== 'ok') {
    return responses.error(res, 503, 'Service Unavailable', 'degraded')(payload);
  }
  responses.success(res, 'health check')(payload);
};

/**
 * @desc Endpoint to return SaaS readiness checks (admin only).
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void}
 */
const readiness = (req, res) => {
  try {
    const data = HomeService.getReadinessStatus();
    responses.success(res, 'readiness check')(data);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

export default {
  team,
  page,
  pageByName,
  health,
  readiness,
};
