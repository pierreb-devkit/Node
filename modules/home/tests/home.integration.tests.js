/**
 * Module dependencies.
 */
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import path from 'path';
import request from 'supertest';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';
/**
 * Unit tests
 */
describe('Home integration tests:', () => {
  let app; // Express app instance for fresh (unauthenticated) requests (#3472)
  let agent;
  let HomeService;
  let adminToken;
  let adminUser;
  let userToken;
  let regularUser;
  let originalOrganizationsEnabled;

  //  init
  beforeAll(async () => {
    try {
      originalOrganizationsEnabled = config.organizations.enabled;
      config.organizations.enabled = false;
      const init = await bootstrap();
      HomeService = (await import(path.resolve('./modules/home/services/home.service.js'))).default;
      app = init.app;
      agent = request.agent(app);

      // Create admin user and sign JWT for health endpoint test
      const User = mongoose.model('User');
      await User.deleteOne({ email: 'admin-home-health@test.com' });
      adminUser = await User.create({
        firstName: 'Admin',
        lastName: 'Health',
        email: 'admin-home-health@test.com',
        password: 'W@os.jsI$Aw3$0m3',
        provider: 'local',
        roles: ['admin'],
      });
      adminToken = jwt.sign({ userId: adminUser.id }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

      // Create regular user and sign JWT for readiness auth tests
      await User.deleteOne({ email: 'regular-readiness@test.com' });
      regularUser = await User.create({
        firstName: 'Regular',
        lastName: 'User',
        email: 'regular-readiness@test.com',
        password: 'W@os.jsI$Aw3$0m3',
        provider: 'local',
        roles: ['user'],
      });
      userToken = jwt.sign({ userId: regularUser.id }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  // Public ("logged out") route tests. Use a fresh `request(app)` per test
  // instead of the shared `agent` so no cookie state from this block leaks
  // into later describes (#3472). Auth-required cases still use explicit
  // `set('Cookie', 'TOKEN=...')` headers derived from JWTs.
  describe('Logout', () => {
    test('should be able to get team members with public fields only', async () => {
      try {
        const result = await request(app).get('/api/home/team').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('team list');
        expect(result.body.data).toBeInstanceOf(Array);
        // Assert the strict public-field allowlist: every key must be one of these,
        // so no unexpected field (incl. _id / id / sensitive data) can ever leak.
        const ALLOWED_FIELDS = new Set(['firstName', 'lastName', 'bio', 'position', 'avatar']);
        result.body.data.forEach((member) => {
          Object.keys(member).forEach((key) => {
            expect(ALLOWED_FIELDS.has(key)).toBe(true);
          });
        });
      } catch (err) {
        expect(err).toBeFalsy();
        console.log(err);
      }
    });

    test('should be able to get an existing page', async () => {
      try {
        const result = await request(app).get('/api/home/pages/terms').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('page');
        expect(result.body.data[0].title).toBe('Terms');
        expect(typeof result.body.data[0].updatedAt).toBe('string');
        expect(typeof result.body.data[0].markdown).toBe('string');
      } catch (err) {
        expect(err).toBeFalsy();
        console.log(err);
      }
    });

    test('should be able to catch error of unknown page', async () => {
      try {
        const result = await request(app).get('/api/home/pages/test').expect(404);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Not Found');
        expect(result.body.description).toBe('No page with that name has been found');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return minimal health status without auth', async () => {
      const result = await request(app).get('/api/health').expect(200);
      expect(result.body.type).toBe('success');
      expect(result.body.data.status).toBe('ok');
      expect(result.body.data.db).toBeUndefined();
      expect(result.body.data.memory).toBeUndefined();
    });

    test('should return detailed health status for admin', async () => {
      const result = await request(app).get('/api/health').set('Cookie', `TOKEN=${adminToken}`).expect(200);
      expect(result.body.type).toBe('success');
      expect(result.body.data.status).toBe('ok');
      expect(result.body.data.db).toBe('connected');
      expect(typeof result.body.data.uptime).toBe('number');
      expect(result.body.data.memory).toBeDefined();
      expect(result.body.data.memory.heapUsed).toBeDefined();
    });

    test('should return 503 when health status is degraded', async () => {
      jest.spyOn(HomeService, 'getHealthStatus').mockReturnValueOnce({
        status: 'degraded',
        db: 'disconnected',
        uptime: 0,
        version: '0.0.0',
        memory: process.memoryUsage(),
      });
      const result = await request(app).get('/api/health').expect(503);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Service Unavailable');
    });
  });

  describe('Readiness', () => {
    test('should return 401 for unauthenticated user', async () => {
      const result = await agent.get('/api/admin/readiness').expect(401);
      expect(result.body).toBeDefined();
      expect(result.status).toBe(401);
    });

    test('should return 403 for regular user', async () => {
      const result = await agent.get('/api/admin/readiness').set('Cookie', `TOKEN=${userToken}`).expect(403);
      expect(result.body.type).toBe('error');
    });

    test('should return 200 with readiness checks for admin', async () => {
      const result = await agent.get('/api/admin/readiness').set('Cookie', `TOKEN=${adminToken}`).expect(200);
      expect(result.body.type).toBe('success');
      expect(result.body.message).toBe('readiness check');
      expect(result.body.data).toBeInstanceOf(Array);
      expect(result.body.data.length).toBeGreaterThan(0);
    });

    test('should return correct shape for each readiness check', async () => {
      const result = await agent.get('/api/admin/readiness').set('Cookie', `TOKEN=${adminToken}`).expect(200);
      const expectedCategories = ['config', 'security', 'auth', 'mail', 'billing', 'analytics', 'errorTracking'];
      const categories = result.body.data.map((c) => c.category);
      expect(categories).toEqual(expectedCategories);
      result.body.data.forEach((item) => {
        expect(item).toHaveProperty('category');
        expect(item).toHaveProperty('status');
        expect(item).toHaveProperty('message');
        expect(['ok', 'warning']).toContain(item.status);
        expect(typeof item.message).toBe('string');
      });
    });

    test('should report ok status when config values are properly set', async () => {
      const mailer = (await import('../../../lib/helpers/mailer/index.js')).default;
      const origDomain = config.domain;
      const origJwt = config.jwt.secret;
      const origOAuth = config.oAuth;
      const origStripe = config.stripe;
      const origAnalytics = config.analytics;
      const mailerSpy = jest.spyOn(mailer, 'isConfigured').mockReturnValue(true);
      try {
        config.domain = 'example.com';
        config.jwt.secret = 'a-real-custom-secret-key';
        config.oAuth = { google: { clientID: 'google-id' }, apple: { clientID: 'apple-id' } };
        config.stripe = { secretKey: 'sk_test_123' };
        config.analytics = { posthog: { key: 'phk_123', errorTracking: true } };

        const result = await agent.get('/api/admin/readiness').set('Cookie', `TOKEN=${adminToken}`).expect(200);
        result.body.data.forEach((item) => {
          expect(item.status).toBe('ok');
        });
        // Verify OAuth message includes both providers
        const authCheck = result.body.data.find((c) => c.category === 'auth');
        expect(authCheck.message).toContain('Google');
        expect(authCheck.message).toContain('Apple');
      } finally {
        config.domain = origDomain;
        config.jwt.secret = origJwt;
        config.oAuth = origOAuth;
        config.stripe = origStripe;
        config.analytics = origAnalytics;
        mailerSpy.mockRestore();
      }
    });

    test('should report warning when JWT secret is the default value', async () => {
      const origJwt = config.jwt.secret;
      try {
        config.jwt.secret = 'WaosSecretKeyExampleToChnageAbsolutely';
        const result = await agent.get('/api/admin/readiness').set('Cookie', `TOKEN=${adminToken}`).expect(200);
        const secCheck = result.body.data.find((c) => c.category === 'security');
        expect(secCheck.status).toBe('warning');
        expect(secCheck.message).toContain('default');
      } finally {
        config.jwt.secret = origJwt;
      }
    });

    test('should report warning when domain is a DEVKIT placeholder', async () => {
      const origDomain = config.domain;
      try {
        config.domain = 'DEVKIT_NODE_DOMAIN';
        const result = await agent.get('/api/admin/readiness').set('Cookie', `TOKEN=${adminToken}`).expect(200);
        const cfgCheck = result.body.data.find((c) => c.category === 'config');
        expect(cfgCheck.status).toBe('warning');
      } finally {
        config.domain = origDomain;
      }
    });

    test('should handle only Google OAuth configured', async () => {
      const origOAuth = config.oAuth;
      try {
        config.oAuth = { google: { clientID: 'google-id' }, apple: {} };
        const result = await agent.get('/api/admin/readiness').set('Cookie', `TOKEN=${adminToken}`).expect(200);
        const authCheck = result.body.data.find((c) => c.category === 'auth');
        expect(authCheck.status).toBe('ok');
        expect(authCheck.message).toContain('Google');
        expect(authCheck.message).not.toContain('Apple');
      } finally {
        config.oAuth = origOAuth;
      }
    });

    test('should report warning when config values are empty strings or whitespace', async () => {
      const origDomain = config.domain;
      const origStripe = config.stripe;
      try {
        config.domain = '   ';
        config.stripe = { secretKey: '' };
        const result = await agent.get('/api/admin/readiness').set('Cookie', `TOKEN=${adminToken}`).expect(200);
        const cfgCheck = result.body.data.find((c) => c.category === 'config');
        const billingCheck = result.body.data.find((c) => c.category === 'billing');
        expect(cfgCheck.status).toBe('warning');
        expect(billingCheck.status).toBe('warning');
      } finally {
        config.domain = origDomain;
        config.stripe = origStripe;
      }
    });

    test('should report warning when JWT secret is empty', async () => {
      const origJwt = config.jwt.secret;
      try {
        config.jwt.secret = '';
        const result = await agent.get('/api/admin/readiness').set('Cookie', `TOKEN=${adminToken}`).expect(200);
        const secCheck = result.body.data.find((c) => c.category === 'security');
        expect(secCheck.status).toBe('warning');
      } finally {
        config.jwt.secret = origJwt;
      }
    });

    test('should return 422 when readiness service throws', async () => {
      jest.spyOn(HomeService, 'getReadinessStatus').mockImplementationOnce(() => {
        throw new Error('config error');
      });
      const result = await agent.get('/api/admin/readiness').set('Cookie', `TOKEN=${adminToken}`).expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.description).toBe('config error.');
    });
  });

  describe('Errors', () => {
    test('should return 422 when team service fails', async () => {
      jest.spyOn(HomeService, 'team').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.get('/api/home/team').expect(422);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Unprocessable Entity');
      expect(result.body.description).toBe('DB error.');
    });

    test('should handle error in pageByName when page service fails', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(HomeService, 'page').mockRejectedValueOnce(new Error('DB error'));
      const result = await agent.get('/api/home/pages/terms').expect(500);
      expect(result.body.message).toBe('DB error');
      consoleSpy.mockRestore();
    });
  });

  // Cleanup and mongoose disconnect
  afterAll(async () => {
    jest.restoreAllMocks();
    config.organizations.enabled = originalOrganizationsEnabled;
    try {
      if (adminUser || regularUser) {
        const User = mongoose.model('User');
        if (adminUser) await User.deleteOne({ _id: adminUser._id });
        if (regularUser) await User.deleteOne({ _id: regularUser._id });
      }
    } catch (_) { /* cleanup – ignore errors */ }
    try {
      await mongooseService.disconnect();
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });
});
