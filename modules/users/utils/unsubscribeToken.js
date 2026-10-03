/**
 * Module dependencies
 */
import crypto from 'crypto';

import config from '../../../config/index.js';

/**
 * HMAC domain separation prefix (#4162). Binds the signature to "this is an
 * unsubscribe token" so it can never be replayed as, or confused with, any
 * other HMAC this stack might sign in the future with the same secret.
 */
const DOMAIN = 'unsubscribe:';

/**
 * @desc Compute the HMAC-SHA256 signature for a (userId, kind) pair.
 * @param {string} userId - stringified user id
 * @param {string} kind - email kind ('onboarding' | 'news')
 * @returns {string} hex-encoded signature
 */
const sign = (userId, kind) => crypto.createHmac('sha256', config.jwt.secret).update(`${DOMAIN}${userId}:${kind}`).digest('hex');

/**
 * @desc Build a stateless, self-verifying one-click unsubscribe token. No DB
 * storage, no expiry (#4162): the token encodes the (userId, kind) pair it
 * authorizes, signed with the stack's existing JWT secret so it can't be
 * forged without it.
 * @param {string} userId - stringified user id
 * @param {string} kind - email kind ('onboarding' | 'news')
 * @returns {string} token in the form `userId.kind.sig`
 */
const createUnsubscribeToken = (userId, kind) => `${userId}.${kind}.${sign(userId, kind)}`;

/**
 * @desc Verify a token produced by `createUnsubscribeToken` and recover the
 * (userId, kind) pair it authorizes. Constant-time signature comparison
 * (`crypto.timingSafeEqual`) so a byte-by-byte timing side-channel can't be
 * used to guess a valid signature. Tolerant of any malformed input — never
 * throws, always returns null on anything that doesn't parse or verify.
 * @param {string} token - raw token from the request path
 * @returns {{userId: string, kind: string}|null} the authorized pair, or
 *   null when the token is malformed, tampered with, or unsignable.
 */
const verifyUnsubscribeToken = (token) => {
  if (typeof token !== 'string' || token === '') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, kind, sig] = parts;
  if (!userId || !kind || !sig) return null;

  // Buffer.from(str, 'hex') never throws on bad input — it silently truncates
  // at the first non-hex character (possibly to 0 bytes) — so a length
  // mismatch against the expected 32-byte SHA-256 digest is the only check
  // needed to reject a malformed/truncated signature.
  const expectedBuf = Buffer.from(sign(userId, kind), 'hex');
  const sigBuf = Buffer.from(sig, 'hex');
  if (expectedBuf.length === 0 || expectedBuf.length !== sigBuf.length) return null;
  if (!crypto.timingSafeEqual(expectedBuf, sigBuf)) return null;

  return { userId, kind };
};

export { createUnsubscribeToken, verifyUnsubscribeToken };
