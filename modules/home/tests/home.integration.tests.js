/**
 * Module dependencies.
 */
import { jest } from '@jest/globals';
import axios from 'axios';
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
  let agent;
  let HomeService;
  let adminToken;
  let originalOrganizationsEnabled;

  //  init
  beforeAll(async () => {
    // Mock GitHub API calls to avoid real network requests in tests
    jest.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (url.includes('/releases')) {
        return { data: [{ name: 'v1.0.0', prerelease: false, published_at: '2024-01-01T00:00:00Z' }] };
      }
      if (url.includes('/contents/')) {
        return { data: { content: Buffer.from('# Changelog\n## v1.0.0\n- First release').toString('base64') } };
      }
      throw new Error(`Unexpected GitHub API URL: ${url}`);
    });
    try {
      originalOrganizationsEnabled = config.organizations.enabled;
      config.organizations.enabled = false;
      const init = await bootstrap();
      HomeService = (await import(path.resolve('./modules/home/services/home.service.js'))).default;
      agent = request.agent(init.app);

      // Create admin user and sign JWT for health endpoint test
      const User = mongoose.model('User');
      const admin = await User.create({
        firstName: 'Admin',
        lastName: 'Health',
        email: 'admin-health@test.com',
        password: 'W@os.jsI$Aw3$0m3',
        provider: 'local',
        roles: ['admin'],
      });
      adminToken = jwt.sign({ userId: admin.id }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  describe('Logout', () => {
    test('should be able to get releases', async () => {
      const result = await agent.get('/api/home/releases').expect(200);
      expect(result.body.type).toBe('success');
      expect(result.body.message).toBe('releases');
      expect(result.body.data).toBeInstanceOf(Array);
    });

    test('should be able to get changelogs', async () => {
      const result = await agent.get('/api/home/changelogs').expect(200);
      expect(result.body.type).toBe('success');
      expect(result.body.message).toBe('changelogs');
      expect(result.body.data).toBeInstanceOf(Array);
    });

    test('should be able to get team members', async () => {
      try {
        const result = await agent.get('/api/home/team').expect(200);
        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('team list');
        expect(result.body.data).toBeInstanceOf(Array);
      } catch (err) {
        expect(err).toBeFalsy();
        console.log(err);
      }
    });

    test('should be able to get an existing page', async () => {
      try {
        const result = await agent.get('/api/home/pages/terms').expect(200);
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
        const result = await agent.get('/api/home/pages/test').expect(404);
        expect(result.body.type).toBe('error');
        expect(result.body.message).toBe('Not Found');
        expect(result.body.description).toBe('No page with that name has been found');
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return empty releases gracefully when GitHub API fails', async () => {
      axios.get.mockRejectedValueOnce(new Error('GitHub API unavailable'));
      const result = await agent.get('/api/home/releases').expect(200);
      expect(result.body.type).toBe('success');
      expect(result.body.message).toBe('releases');
      expect(result.body.data).toEqual([]);
    });

    test('should return empty changelogs gracefully when GitHub API fails', async () => {
      axios.get.mockRejectedValueOnce(new Error('GitHub API unavailable'));
      const result = await agent.get('/api/home/changelogs').expect(200);
      expect(result.body.type).toBe('success');
      expect(result.body.message).toBe('changelogs');
      expect(result.body.data).toEqual([]);
    });

    test('should use Authorization header when a token is configured for releases', async () => {
      const originalRepos = config.repos;
      axios.get.mockClear();
      // Temporarily set a fake token to cover the token-truthy branch in home.service releases()
      config.repos = originalRepos.map((repo) => ({ ...repo, token: 'fake-test-token' }));
      const result = await agent.get('/api/home/releases').expect(200);
      expect(result.body.type).toBe('success');
      const releaseCalls = axios.get.mock.calls.filter(([url]) => url.includes('/releases'));
      expect(releaseCalls.length).toBeGreaterThan(0);
      releaseCalls.forEach(([, options]) => {
        expect(options.headers.Authorization).toBe('token fake-test-token');
      });
      config.repos = originalRepos;
    });

    test('should use Authorization header when a token is configured for changelogs', async () => {
      const originalRepos = config.repos;
      axios.get.mockClear();
      config.repos = originalRepos.map((repo) => ({ ...repo, token: 'fake-test-token' }));
      const result = await agent.get('/api/home/changelogs').expect(200);
      expect(result.body.type).toBe('success');
      const changelogCalls = axios.get.mock.calls.filter(([url]) => url.includes('/contents/'));
      expect(changelogCalls.length).toBeGreaterThan(0);
      changelogCalls.forEach(([, options]) => {
        expect(options.headers.Authorization).toBe('token fake-test-token');
      });
      config.repos = originalRepos;
    });

    test('should return minimal health status without auth', async () => {
      const result = await agent.get('/api/health').expect(200);
      expect(result.body.type).toBe('success');
      expect(result.body.data.status).toBe('ok');
      expect(result.body.data.db).toBeUndefined();
      expect(result.body.data.memory).toBeUndefined();
    });

    test('should return detailed health status for admin', async () => {
      const result = await agent.get('/api/health').set('Cookie', `TOKEN=${adminToken}`).expect(200);
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
      const result = await agent.get('/api/health').expect(503);
      expect(result.body.type).toBe('error');
      expect(result.body.message).toBe('Service Unavailable');
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

  // Mongoose disconnect
  afterAll(async () => {
    jest.restoreAllMocks();
    config.organizations.enabled = originalOrganizationsEnabled;
    try {
      await mongooseService.disconnect();
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });
});
