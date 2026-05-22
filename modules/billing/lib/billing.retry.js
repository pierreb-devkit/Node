/**
 * Retry an async operation with exponential backoff.
 *
 * For default opts (attempts=3, baseMs=200), delays are 200ms then 400ms
 * (no delay after the final attempt). General formula: baseMs * 2^i for
 * each non-final attempt i.
 *
 * Returns the result of the first successful call, or throws the last
 * error after all attempts are exhausted.
 *
 * @param {() => Promise<T>} fn - Async function to attempt.
 * @param {object}  [opts]
 * @param {number}  [opts.attempts=3]  - Maximum number of attempts (including the first call).
 * @param {number}  [opts.baseMs=200]  - Base delay in ms for the first retry.
 * @returns {Promise<T>}
 */
export async function retryWithBackoff(fn, { attempts = 3, baseMs = 200 } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError(`retryWithBackoff: attempts must be a positive integer, received ${attempts}`);
  }
  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new TypeError(`retryWithBackoff: baseMs must be a non-negative finite number, received ${baseMs}`);
  }
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}
