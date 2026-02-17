/**
 * Module dependencies
 */
import passport from 'passport';
import { Strategy } from 'passport-local';

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
        } catch (_err) {
          return done();
        }
      },
    ),
  );
};
