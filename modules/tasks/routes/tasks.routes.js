/**
 * Module dependencies
 */
import passport from 'passport';

import model from '../../../lib/middlewares/model.js';
import policy from '../../../lib/middlewares/policy.js';
import tasks from '../controllers/tasks.controller.js';
import tasksSchema from '../models/tasks.schema.js';

/**
 * Routes
 */
export default (app) => {
  // stats
  app.route('/api/tasks/stats').all(policy.isAllowed).get(tasks.stats);

  // list & post
  app
    .route('/api/tasks')
    .get(tasks.list) // list
    .post(passport.authenticate('jwt', { session: false }), policy.isAllowed, model.isValid(tasksSchema.Task), tasks.create); // create

  // classic crud — ownership is enforced by CASL conditions in isAllowed
  app
    .route('/api/tasks/:taskId')
    .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
    .get(tasks.get) // get
    .put(model.isValid(tasksSchema.TaskUpdate), tasks.update) // update
    .delete(tasks.remove); // delete

  // Finish by binding the task middleware
  app.param('taskId', tasks.taskByID);
};
