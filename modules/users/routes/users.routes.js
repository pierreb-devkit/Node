/**
 * Module dependencies
 */
import passport from 'passport';

import multer from '../../../lib/services/multer.js';
import model from '../../../lib/middlewares/model.js';
import config from '../../../config/index.js';
import policy from '../../../lib/middlewares/policy.js';
import usersSchema from '../models/user.schema.js';
import users from '../controllers/users.account.controller.js';
import usersImage from '../controllers/users.images.controller.js';
import usersData from '../controllers/users.data.controller.js';
import authPassword from '../../auth/controllers/auth.password.controller.js';
import admin from '../controllers/users.admin.controller.js';

export default (app) => {
  /**
   * Admin
   */

  app.route('/api/users/stats').all(policy.isAllowed).get(users.stats);

  app.route('/api/users/me').get(passport.authenticate('jwt', { session: false }), policy.isAllowed, users.me);

  app.route('/api/users/terms').get(passport.authenticate('jwt', { session: false }), policy.isAllowed, users.terms);

  app
    .route('/api/users')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .put(model.isValid(usersSchema.UserUpdate), users.update)
    .delete(users.remove);

  app.route('/api/users/password').post(passport.authenticate('jwt', { session: false }), policy.isAllowed, authPassword.updatePassword);

  app
    .route('/api/users/avatar')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .post(multer.create(config.uploads.avatar), usersImage.updateAvatar)
    .delete(usersImage.removeAvatar);

  app
    .route('/api/users/data')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(usersData.get)
    .delete(usersData.remove);

  app
    .route('/api/users/data/mail')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(usersData.getMail);

  /**
   * Users
   */

  app.route('/api/users').get(passport.authenticate('jwt', { session: false }), policy.isAllowed, admin.list); // list

  // Users page
  app.route('/api/users/page/:userPage').get(passport.authenticate('jwt', { session: false }), policy.isAllowed, admin.list); // list

  // Single user routes
  app
    .route('/api/users/:userId')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(admin.get) // get
    .put(admin.update) // update
    .delete(admin.remove); // delete

  // Finish by binding the user middleware
  app.param('userId', admin.userByID);
  app.param('userPage', admin.userByPage);
};
