/**
 * Module dependencies
 */
import { randomInt } from 'node:crypto';

/**
 * @function applyJitter
 * @description Sleep for a random number of milliseconds from 0 to maxMs.
 * @param {number} maxMs - Exclusive upper bound for jitter in milliseconds.
 * @returns {Promise<number>} The number of milliseconds slept.
 */
export const applyJitter = async (maxMs) => {
  if (!Number.isFinite(maxMs) || maxMs <= 0) return 0;
  const jitterMaxMs = Math.floor(maxMs);
  if (jitterMaxMs <= 0) return 0;
  const delayMs = randomInt(0, jitterMaxMs);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return delayMs;
};

export default {
  applyJitter,
};
