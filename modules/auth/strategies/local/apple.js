/**
 * Module dependencies
 */
import passport from 'passport';
import AppleStrategy from 'passport-apple';

import config from '../../../../config/index.js';
import auth from '../../controllers/auth.controller.js';

const callbackURL = `${config.api.protocol}://${config.api.host}${config.api.port ? ':' : ''}${config.api.port ? config.api.port : ''}/${
  config.api.base
}/auth/apple/callback`;

/**
 * @desc Map Apple OAuth callback to user profile and delegate to checkOAuthUserProfile
 * @param {Object} req - Express request (passReqToCallback)
 * @param {string} accessToken - Apple access token
 * @param {string} refreshToken - Apple refresh token
 * @param {Object} decodedIdToken - Decoded Apple ID token
 * @param {Object} profile - Apple profile (may be empty on repeat sign-ins)
 * @param {Function} cb - Passport callback (err, user)
 * @returns {Promise<void>}
 */
const prepare = async (req, accessToken, refreshToken, decodedIdToken, profile, cb) => {
  // Set the provider data and include tokens
  const providerData = decodedIdToken;
  providerData.appleProfile = req.appleProfile;
  providerData.accessToken = accessToken || null;
  providerData.refreshToken = refreshToken || null;
  providerData.profile = profile || null;
  providerData.sub = decodedIdToken.sub;
  // Create the user OAuth profile
  const _profile = {
    firstName: req.appleProfile && req.appleProfile.name ? req.appleProfile.name.firstName : null,
    lastName: req.appleProfile && req.appleProfile.name ? req.appleProfile.name.lastName : null,
    email: req.appleProfile ? req.appleProfile.email : null,
    avatar: null,
    provider: 'apple',
    providerData,
    emailVerifiedByProvider: decodedIdToken.email_verified === true || decodedIdToken.email_verified === 'true',
  };
  // Save the user OAuth profile
  try {
    const user = await auth.checkOAuthUserProfile(_profile, 'sub', 'apple');
    return cb(null, user);
  } catch (err) {
    return cb(err);
  }
};

export default () => {
  const apple = config.oAuth.apple ? config.oAuth.apple : null;
  // Use google strategy
  if (apple && apple.clientID && apple.teamID && apple.keyID) {
    passport.use(
      new AppleStrategy(
        {
          clientID: apple.clientID,
          teamID: apple.teamID,
          callbackURL: apple.callbackURL ? apple.callbackURL : callbackURL,
          keyID: config.oAuth.apple.keyID,
          privateKeyLocation: apple.privateKeyLocation ? apple.privateKeyLocation : null,
          scope: ['email', 'name'],
          passReqToCallback: true,
        },
        (req, a, r, d, p, cb) => prepare(req, a, r, d, p, cb),
      ),
    );
  }
};
