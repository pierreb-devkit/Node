/**
 * Module dependencies
 */
import { activeStatuses } from '../lib/constants.js';
import config from '../../../config/index.js';
import responses from '../../../lib/helpers/responses.js';
import BillingService from '../services/billing.service.js';
import BillingUsageService from '../services/billing.usage.service.js';
import BillingExtraService from '../services/billing.extra.service.js';
import BillingExtraBalanceRepository from '../repositories/billing.extraBalance.repository.js';

// NOTE: BillingExtraBalance uses 'organization' (ObjectId ref); BillingUsage uses 'organizationId' (string field).
// These two collections have asymmetric field names for historical reasons — keep queries consistent with each model's own convention.

/**
 * @desc Endpoint to create a Stripe Checkout session
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const checkout = async (req, res) => {
  try {
    const { priceId, successUrl, cancelUrl } = req.body;
    const url = await BillingService.createCheckout(req.organization, priceId, successUrl, cancelUrl);
    responses.success(res, 'checkout session created')({ url });
  } catch (err) {
    const status = err.message?.startsWith('Invalid') || err.message?.includes('not found') ? 422 : 502;
    const title = status === 422 ? 'Unprocessable Entity' : 'Bad Gateway';
    responses.error(res, status, title, 'Failed to create checkout session')(err);
  }
};

/**
 * @desc Endpoint to create a Stripe Customer Portal session
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const portal = async (req, res) => {
  try {
    const { returnUrl } = req.body;
    const url = await BillingService.createPortalSession(req.organization, returnUrl);
    responses.success(res, 'portal session created')({ url });
  } catch (err) {
    const status = err.message?.startsWith('Invalid') || err.message?.includes('not found') ? 422 : 502;
    const title = status === 422 ? 'Unprocessable Entity' : 'Bad Gateway';
    responses.error(res, status, title, 'Failed to create portal session')(err);
  }
};

/**
 * @desc Endpoint to get the subscription for the current organization
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const getSubscription = async (req, res) => {
  try {
    const subscription = await BillingService.getSubscription(req.organization._id);
    responses.success(res, 'subscription')(subscription);
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to retrieve subscription')(err);
  }
};

/**
 * @desc Endpoint to get billing usage for the current organization.
 *       When meterMode is enabled, returns meter fields (meterUsed, meterQuota,
 *       meterBreakdown, extrasRemaining, weekKey, weekResetAt, planVersion).
 *       Legacy mode (meterMode=false) returns the existing counters/limits shape — unchanged.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const getUsage = async (req, res) => {
  try {
    // Determine current plan via service layer
    const subscription = await BillingService.getSubscription(req.organization._id);
    const plan = (!subscription || !activeStatuses.includes(subscription.status)) ? 'free' : (subscription.plan || 'free');

    if (config.billing?.meterMode) {
      // Meter mode — return compute fields
      const meter = await BillingUsageService.getMeter(req.organization._id.toString());
      const extrasRemaining = await BillingExtraBalanceRepository.getBalance(req.organization._id.toString());
      const packsAvailable = config.billing?.packs ?? [];

      return responses.success(res, 'billing usage')({
        plan,
        planVersion: meter?.planVersion ?? null,
        weekKey: meter?.weekKey ?? BillingUsageService.currentWeekKey(),
        weekResetAt: meter?.resetAt ?? null,
        meterUsed: meter?.meterUsed ?? 0,
        meterQuota: meter?.meterQuota ?? 0,
        meterBreakdown: meter?.meterBreakdown ?? {},
        extrasRemaining,
        packsAvailable,
      });
    }

    // Legacy mode — counters/limits shape unchanged
    const usage = await BillingUsageService.get(req.organization._id.toString());

    // Flatten quotas config into { "resource_action": limit } format
    // Normalize Infinity to null for JSON-safe serialization
    const quotas = config.billing?.quotas;
    let limits = {};
    if (quotas?.[plan]) {
      const planQuotas = quotas[plan];
      for (const resource of Object.keys(planQuotas)) {
        for (const action of Object.keys(planQuotas[resource])) {
          const rawLimit = planQuotas[resource][action];
          limits[`${resource}_${action}`] = Number.isFinite(rawLimit) ? rawLimit : null;
        }
      }
    }

    return responses.success(res, 'billing usage')({
      plan,
      period: usage.month,
      usage: usage.counters || {},
      limits,
    });
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to retrieve billing usage')(err);
  }
};

/**
 * @desc Endpoint to create a Stripe Checkout Session for an extras pack purchase
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js controller, not Qwik
const extrasCheckout = async (req, res) => {
  try {
    const { packId, successUrl, cancelUrl } = req.body;
    const result = await BillingService.createExtrasCheckout(req.organization, packId, successUrl, cancelUrl);
    responses.success(res, 'extras checkout session created')(result);
  } catch (err) {
    const status = err.message?.startsWith('Invalid') || err.message?.includes('not found') ? 422 : 502;
    const title = status === 422 ? 'Unprocessable Entity' : 'Bad Gateway';
    responses.error(res, status, title, 'Failed to create extras checkout session')(err);
  }
};

/**
 * @desc Endpoint to get the current extras balance for the organization
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js controller, not Qwik
const extrasBalance = async (req, res) => {
  try {
    const balance = await BillingExtraBalanceRepository.getBalance(req.organization._id.toString());
    const packsAvailable = config.billing?.packs ?? [];
    responses.success(res, 'extras balance')({ balance, packsAvailable });
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to retrieve extras balance')(err);
  }
};

/**
 * @desc Endpoint to get paginated extras ledger for the organization
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js controller, not Qwik
const extrasLedger = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const result = await BillingExtraService.listLedger(req.organization._id.toString(), { page, limit });
    responses.success(res, 'extras ledger')(result);
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to retrieve extras ledger')(err);
  }
};

export default {
  checkout,
  portal,
  getSubscription,
  getUsage,
  extrasCheckout,
  extrasBalance,
  extrasLedger,
};
