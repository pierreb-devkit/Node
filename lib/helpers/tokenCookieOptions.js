/**
 * Module dependencies
 */
import config from '../../config/index.js';

/**
 * @desc Options for the `TOKEN` auth cookie, the one shape every route that sets
 *   or clears it uses (httpOnly, secure and sameSite from `config.cookie`).
 * @type {{ httpOnly: boolean, secure: boolean, sameSite: string }}
 */
const tokenCookieOptions = {
  httpOnly: true,
  secure: config.cookie.secure,
  sameSite: config.cookie.sameSite,
};

export default tokenCookieOptions;
