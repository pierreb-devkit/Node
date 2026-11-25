/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

/**
 * Limiter wiring (#4355): organization invite create + resend use their own
 * `organizationInvitationsCreate` bucket, platform create keeps `invitationsCreate`.
 * Every dependency is mocked with a named sentinel so the registered middleware
 * stacks can be read back from a fake Express app.
 */
const sentinel = (name) => {
  const fn = (req, res, next) => next();
  fn.sentinel = name;
  return fn;
};

jest.unstable_mockModule('passport', () => ({ default: { authenticate: () => sentinel('jwt') } }));
jest.unstable_mockModule('../../../lib/middlewares/rateLimiter.js', () => ({
  default: new Proxy({}, { get: (target, name) => (target[name] ||= sentinel(`limiter:${String(name)}`)) }),
}));
jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({ default: { isValid: () => sentinel('isValid') } }));
jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({ default: { isAllowed: sentinel('isAllowed') } }));
jest.unstable_mockModule('../controllers/invitations.controller.js', () => ({
  default: new Proxy({}, { get: (target, name) => (target[name] ||= sentinel(`controller:${String(name)}`)) }),
}));
jest.unstable_mockModule('../../organizations/middlewares/organizations.middleware.js', () => ({
  default: { loadMembership: sentinel('loadMembership') },
}));
jest.unstable_mockModule('../models/invitations.schema.js', () => ({ default: {} }));

const { default: routes } = await import('../routes/invitations.routes.js');

/**
 * Register the routes on a fake app and collect the middleware stack per `METHOD path`.
 * @returns {Record<string, string[]>} sentinel names, `.all()` stack first
 */
const register = () => {
  const stacks = {};
  const app = {
    param: () => {},
    route: (path) => {
      let all = [];
      const chain = {
        all: (...fns) => { all = fns; return chain; },
      };
      for (const method of ['get', 'post', 'delete', 'put']) {
        chain[method] = (...fns) => {
          stacks[`${method.toUpperCase()} ${path}`] = [...all, ...fns].map((fn) => fn.sentinel);
          return chain;
        };
      }
      return chain;
    },
  };
  routes(app);
  return stacks;
};

describe('invitations routes — limiter wiring (#4355):', () => {
  const stacks = register();

  test('platform create keeps the invitationsCreate bucket', () => {
    const stack = stacks['POST /api/invitations'];
    expect(stack).toContain('limiter:invitationsCreate');
    expect(stack).not.toContain('limiter:organizationInvitationsCreate');
  });

  test.each([
    ['POST /api/organizations/:organizationId/invitations'],
    ['POST /api/organizations/:organizationId/invitations/:invitationId/resend'],
  ])('%s uses its own organizationInvitationsCreate bucket', (key) => {
    const stack = stacks[key];
    expect(stack).toContain('limiter:organizationInvitationsCreate');
    expect(stack).not.toContain('limiter:invitationsCreate');
  });
});
