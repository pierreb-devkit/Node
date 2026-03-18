/**
 * Module dependencies
 */
import UsageRepository from '../repositories/billing.usage.repository.js';

/**
 * Compute the current month string in YYYY-MM format.
 * @returns {String} e.g. '2026-03'
 */
const currentMonth = () => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

/**
 * @desc Increment a usage counter for the given organization (current month).
 * @param {String} organizationId - The organization ID.
 * @param {String} key - The counter key to increment.
 * @param {Number} amount - The amount to increment by.
 * @returns {Promise<Object>} The updated usage document.
 */
const increment = (organizationId, key, amount) => UsageRepository.increment(organizationId, currentMonth(), key, amount);

/**
 * @desc Get usage for the given organization (current month).
 * @param {String} organizationId - The organization ID.
 * @returns {Promise<Object>} The usage document or an object with empty counters.
 */
const get = async (organizationId) => {
  const month = currentMonth();
  const usage = await UsageRepository.get(organizationId, month);
  return usage || { organizationId, month, counters: {} };
};

/**
 * @desc Reset usage counters for the given organization (current month).
 * @param {String} organizationId - The organization ID.
 * @returns {Promise<Object|null>} The updated usage document or null.
 */
const reset = (organizationId) => UsageRepository.reset(organizationId, currentMonth());

export default {
  increment,
  get,
  reset,
};
