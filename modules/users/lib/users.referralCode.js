/**
 * Personal referral code = the user id encoded (base64url of the 12 ObjectId bytes,
 * 16 chars). Derived, never stored: no field, no migration. The code is NOT a secret
 * and grants nothing by itself; it only names a referrer.
 */
const ID_PATTERN = /^[0-9a-f]{24}$/;
const CODE_PATTERN = /^[A-Za-z0-9_-]{16}$/;

/**
 * @desc Encode a user id as its referral code.
 * @param {string|Object} id - user id (24-hex string or ObjectId)
 * @returns {string|null} 16-char base64url code, or null when the id is not an ObjectId
 */
export const encodeReferralCode = (id) => {
  const hex = String(id ?? '');
  if (!ID_PATTERN.test(hex)) return null;
  return Buffer.from(hex, 'hex').toString('base64url');
};

/**
 * @desc Decode a referral code back to the user id.
 * @param {string} code - candidate referral code
 * @returns {string|null} 24-hex user id, or null when the code is not a well-formed code
 */
export const decodeReferralCode = (code) => {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return null;
  // 12 bytes = exactly 16 base64url chars with no padding bits, so every code that
  // matches CODE_PATTERN is canonical: one id, one code.
  return Buffer.from(code, 'base64url').toString('hex');
};

export default { encodeReferralCode, decodeReferralCode };
