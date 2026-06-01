/**
 * @desc Compute the public beta-capacity view for the auth config endpoint:
 * the configured cap and how many seats remain. Skips the (collection-wide)
 * count entirely when uncapped, so the common case stays a no-op.
 * @param {number|string|null|undefined} rawCap - config.sign.cap (null/undefined/non-numeric = uncapped; 0 = fully closed, 0 seats)
 * @param {() => Promise<number>} countFn - async total-account counter (UserService.count)
 * @returns {Promise<{cap: number|null, remaining: number|null}>}
 */
export const computeSignupCapacity = async (rawCap, countFn) => {
  const cap = rawCap != null ? Number(rawCap) : null;
  if (cap == null || !Number.isFinite(cap)) return { cap: null, remaining: null };
  const remaining = Math.max(0, cap - (await countFn()));
  return { cap, remaining };
};
