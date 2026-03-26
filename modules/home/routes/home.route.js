/**
 * Module dependencies
 */
import policy from '../../../lib/middlewares/policy.js';
import home from '../controllers/home.controller.js';

/**
 * Routes
 */
export default (app) => {
  // health check — public, no auth
  app.route('/api/health').get(home.health);
  // changelogs
  app.route('/api/home/releases').all(policy.isAllowed).get(home.releases);
  // changelogs
  app.route('/api/home/changelogs').all(policy.isAllowed).get(home.changelogs);
  // changelogs
  app.route('/api/home/team').all(policy.isAllowed).get(home.team);
  // markdown files
  app.route('/api/home/pages/:name').all(policy.isAllowed).get(home.page);

  // Finish by binding the task middleware
  app.param('name', home.pageByName);
};
