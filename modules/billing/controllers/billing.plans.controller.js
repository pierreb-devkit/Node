/**
 * Module dependencies
 */
import responses from '../../../lib/helpers/responses.js';
import BillingPlansService from '../services/billing.plans.service.js';

/**
 * @desc Endpoint to get billing plans
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
const getPlans = async (req, res) => {
  try {
    const plans = await BillingPlansService.getPlans();
    responses.success(res, 'billing plans')(plans);
  } catch (err) {
    responses.error(res, 500, 'Internal Server Error', 'Failed to retrieve billing plans')(err);
  }
};

export default {
  getPlans,
};
