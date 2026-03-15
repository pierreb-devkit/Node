

/**
 * Module dependencies
 */
import path from 'path';
import passport from 'passport';
import * as url from 'url';

import config from '../../config/index.js';
import UserService from '../users/services/users.service.js';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

/**
 * Module init function
 */
export default async (app) => {
  // Serialize identifiable user's information to the session
  // so that it can be pulled back in another request
  passport.serializeUser(({ id }, done) => {
    done(null, id);
  });

  // Deserialize get the user identifying information that we saved
  // in `passport.serializeUser()` and resolves the user account
  // from it so it can be saved in `req.user`
  passport.deserializeUser(async (id, done) => {
    try {
      const user = await UserService.get({ id });
      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  });

  // Initialize strategies
  for (const stratPath of await config.utils.getGlobbedPaths(path.join(__dirname, './strategies/**/*.js'))) {
    const strat = await import(path.resolve(stratPath));
    strat.default(config);
  }

  // Add passport's middleware
  app.use(passport.initialize());
};
