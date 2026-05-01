/**
 * Module dependencies
 */
import responses from '../../../lib/helpers/responses.js';
import BillingRefundService from '../services/billing.refund.service.js';
import BillingPlanService from '../services/billing.plan.service.js';

/**
 * @desc Admin endpoint to trigger a Stripe refund for a charge
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const adminRefundCharge = async (req, res) => {
  try {
    const { chargeId, amountCents, reason } = req.body;
    const refund = await BillingRefundService.refundCharge(chargeId, amountCents, { reason });
    responses.success(res, 'billing refund created')(refund);
  } catch (err) {
    const status = err.message?.startsWith('invalid argument') ? 422 : 502;
    const title = status === 422 ? 'Unprocessable Entity' : 'Bad Gateway';
    responses.error(res, status, title, 'Failed to refund charge')(err);
  }
};

/**
 * @desc Admin endpoint to create a new plan version
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const adminBumpPlanVersion = async (req, res) => {
  try {
    const { planId, meterQuota, ratios } = req.body;
    const nextPlan = await BillingPlanService.bumpVersion(planId, { meterQuota, ratios });
    responses.success(res, 'billing plan version bumped')(nextPlan);
  } catch (err) {
    responses.error(res, 422, 'Unprocessable Entity', 'Failed to bump billing plan version')(err);
  }
};

export default {
  adminRefundCharge,
  adminBumpPlanVersion,
};
