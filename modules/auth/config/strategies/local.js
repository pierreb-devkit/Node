/**
 * Module dependencies
 */
import passport from 'passport';
import { Strategy } from 'passport-local';

import AppError from '../../../../lib/helpers/AppError.js';
import AuthService from '../../services/auth.service.js';

export default () => {
  passport.use(
    new Strategy(
      {
        usernameField: 'email',
        passwordField: 'password',
      },
      async (email, password, done) => {
        try {
          const user = await AuthService.authenticate(email, password);
          if (user) return done(null, user);

          return done(null, false, {
            message: 'Invalid email or password',
          });
        } catch (err) {
          if (err instanceof AppError && err.code === 'ACCOUNT_LOCKED') {
            return done(err);
          }
          if (err instanceof AppError && err.code === 'SERVICE_ERROR') {
            return done(null, false, { message: 'Invalid email or password' });
          }
          return done(err);
        }
      },
    ),
  );
};
