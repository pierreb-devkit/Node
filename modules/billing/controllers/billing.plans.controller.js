/**
 * Module dependencies
 */
import errors from '../../../lib/helpers/errors.js';
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
    responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
  }
};

export default {
  getPlans,
};
