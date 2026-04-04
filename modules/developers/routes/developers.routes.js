/**
 * Module dependencies
 */
import passport from 'passport';

import config from '../../../config/index.js';
import model from '../../../lib/middlewares/model.js';
import policy from '../../../lib/middlewares/policy.js';
import organization from '../../organizations/middleware/organizations.middleware.js';
import apiKeySchema from '../models/developers.apiKey.schema.js';
import webhookSchema from '../models/developers.webhook.schema.js';
import keys from '../controllers/developers.keys.controller.js';
import webhooks from '../controllers/developers.webhooks.controller.js';

/**
 * @desc Register developers routes
 * @param {Object} app - Express application instance
 * @returns {void}
 */
export default (app) => {
  // --- API Keys routes ---
  if (config.developers?.keys?.enabled) {
    app
      .route('/api/developers/keys')
      .all(
        passport.authenticate('jwt', { session: false }),
        organization.resolveOrganization,
        policy.isAllowed,
      )
      .get(keys.list)
      .post(model.isValid(apiKeySchema.ApiKeyCreate), keys.create);

    app
      .route('/api/developers/keys/:keyId')
      .all(
        passport.authenticate('jwt', { session: false }),
        organization.resolveOrganization,
        policy.isAllowed,
      )
      .delete(keys.revoke);

    app.param('keyId', keys.apiKeyByID);
  }

  // --- Webhooks routes ---
  if (config.developers?.webhooks?.enabled) {
    app
      .route('/api/developers/webhooks')
      .all(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed)
      .get(webhooks.list)
      .post(model.isValid(webhookSchema.WebhookCreate), webhooks.create);

    app
      .route('/api/developers/webhooks/:webhookId')
      .all(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed)
      .get(webhooks.get)
      .put(model.isValid(webhookSchema.WebhookUpdate), webhooks.update)
      .delete(webhooks.remove);

    app
      .route('/api/developers/webhooks/:webhookId/deliveries')
      .all(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed)
      .get(webhooks.listDeliveries);

    app
      .route('/api/developers/webhooks/:webhookId/test')
      .all(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed)
      .post(webhooks.testPing);

    app.param('webhookId', webhooks.webhookByID);
  }
};
