/**
 * Module dependencies
 */
import express from 'express';

import webhook from '../controllers/billing.webhook.controller.js';

/**
 * @desc Register billing pre-parser routes (mounted before body parsing and CSRF)
 * @param {Object} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  app.route('/api/billing/webhook').post(express.raw({ type: 'application/json' }), webhook.handleWebhook);
};
