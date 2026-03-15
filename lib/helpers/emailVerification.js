import mailer from './mailer/index.js';
import AppError from './AppError.js';

/**
 * @desc Assert that the user's email is verified when mailer is configured.
 * When mailer is not configured (e.g. local dev), this is a no-op.
 * @param {Object} user - The user object (must have emailVerified field).
 * @throws {AppError} If mailer is configured and user.emailVerified is falsy.
 */
const assertEmailVerified = (user) => {
  if (mailer.isConfigured() && !user.emailVerified) {
    throw new AppError('Email verification required before this action', { code: 'FORBIDDEN' });
  }
};

export { assertEmailVerified };
export default { assertEmailVerified };
