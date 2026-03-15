/**
 * Module dependencies
 */
import passport from 'passport';
import GoogleStrategy from 'passport-google-oauth20';

import config from '../../../../config/index.js';
import auth from '../../controllers/auth.controller.js';

const callbackURL = `${config.api.protocol}://${config.api.host}${config.api.port ? ':' : ''}${config.api.port ? config.api.port : ''}/${
  config.api.base
}/auth/google/callback`;

/**
 * @desc function to prepare map callback to user profile
 * @param {accessToken}
 * @param {refreshToken}
 * @param {profile}
 * @param {cb} callback
 */
const prepare = async (accessToken, refreshToken, profile, cb) => {
  // Set the provider data and include tokens
  const providerData = profile._json;
  providerData.accessToken = accessToken;
  providerData.refreshToken = refreshToken;
  // Create the user OAuth profile
  const _profile = {
    firstName: profile.name.givenName,
    lastName: profile.name.familyName,
    email: profile.emails[0].value,
    avatar: providerData.picture ? providerData.picture : undefined,
    provider: 'google',
    providerData,
  };
  // Save the user OAuth profile
  try {
    const user = await auth.checkOAuthUserProfile(_profile, 'sub', 'google');
    return cb(null, user);
  } catch (err) {
    return cb(err);
  }
};

/**
 * @desc Export oAuth Strategie
 */
export default () => {
  const google = config.oAuth.google ? config.oAuth.google : null;
  // Use google strategy
  if (google && google.clientID && google.clientSecret) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: google.clientID,
          clientSecret: google.clientSecret,
          callbackURL: google.callbackURL ? google.callbackURL : callbackURL,
          scope: ['profile', 'email'],
        },
        (a, r, p, cb) => prepare(a, r, p, cb),
      ),
    );
  }
};
