/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import { jest } from '@jest/globals';

import { bootstrap } from '../../../lib/app.js';
import AnalyticsService from '../../../lib/services/analytics.js';

/**
 * Integration tests — signup attribution (epic #4002/#4003), end-to-end through
 * the real Express app + Mongo. Mirrors the structure of auth.integration.tests.js.
 *
 * Unlike auth.signup.attribution.unit.tests.js (fully module-mocked, no real
 * app/DB), this suite proves the wiring through the ACTUAL route → Zod schema
 * validation → controller → UserService → Mongo persistence path, plus the real
 * shape of the `user_signed_up` capture event.
 *
 * AnalyticsService.isConfigured/capture/identify are SPIED (jest.spyOn on the
 * real singleton, not jest.unstable_mockModule) — the module is a plain object
 * of functions (see lib/services/analytics.js), so spying its properties is
 * visible to auth.controller.js's own `AnalyticsService.<method>(...)` calls.
 * The real PostHog client never initializes in the test env (no
 * DEVKIT_NODE_analytics_posthog_key), so `isConfigured()` would naturally read
 * false; spying it forces both branches of the gate on demand, while stubbing
 * capture/identify guarantees no attempt is ever made to reach a real client.
 */
describe('Auth signup attribution integration tests:', () => {
  let UserService = null;
  let app;
  let agent;

  const password = 'W@os.jsI$Aw3$0m3';

  const baseAttribution = {
    referrer: 'https://google.com',
    landingPath: '/pricing',
    utmSource: 'google',
    utmMedium: 'cpc',
    utmCampaign: 'launch',
  };

  const emails = {
    configured: 'attribution-configured@test.com',
    unconfigured: 'attribution-unconfigured@test.com',
    bogus: 'attribution-bogus@test.com',
  };

  /**
   * Remove any leftover test users (by email) from a previous run.
   * @returns {Promise<void>}
   */
  const cleanupUsers = async () => {
    for (const email of Object.values(emails)) {
      try {
        const existing = await UserService.getBrut({ email });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup – ignore errors */ }
    }
  };

  beforeAll(async () => {
    try {
      const init = await bootstrap();
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      app = init.app;
      agent = request.agent(app);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
    // clean up stale users from previous runs on shared databases
    await cleanupUsers();
  });

  afterEach(async () => {
    // restores isConfigured/capture/identify spies to the real implementation
    // between tests — jest.config.js only sets clearMocks (resets call history,
    // not mock implementations), so a stale mockReturnValue would otherwise leak
    // into the next test (mirrors auth.integration.tests.js's OAuth block).
    jest.restoreAllMocks();
    await cleanupUsers();
  });

  test('persists the exact attribution subdoc and flattens it onto the user_signed_up capture event when analytics is configured', async () => {
    jest.spyOn(AnalyticsService, 'isConfigured').mockReturnValue(true);
    const captureSpy = jest.spyOn(AnalyticsService, 'capture').mockImplementation(() => {});
    jest.spyOn(AnalyticsService, 'identify').mockImplementation(() => {});

    let result;
    try {
      result = await agent.post('/api/auth/signup').send({
        firstName: 'Attr',
        lastName: 'Bution',
        email: emails.configured,
        password,
        provider: 'local',
        attribution: baseAttribution,
      }).expect(200);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }

    expect(result.body.user.email).toBe(emails.configured);

    const brut = await UserService.getBrut({ email: emails.configured });
    expect(brut.toObject().attribution).toEqual(baseAttribution);

    expect(captureSpy).toHaveBeenCalledWith(expect.objectContaining({
      event: 'user_signed_up',
      properties: expect.objectContaining({
        referrer: baseAttribution.referrer,
        landing_path: baseAttribution.landingPath,
        utm_source: baseAttribution.utmSource,
        utm_medium: baseAttribution.utmMedium,
        utm_campaign: baseAttribution.utmCampaign,
      }),
    }));
  });

  test('strips attribution before persistence when analytics is not configured (feature inert)', async () => {
    jest.spyOn(AnalyticsService, 'isConfigured').mockReturnValue(false);
    const captureSpy = jest.spyOn(AnalyticsService, 'capture').mockImplementation(() => {});
    jest.spyOn(AnalyticsService, 'identify').mockImplementation(() => {});

    let result;
    try {
      result = await agent.post('/api/auth/signup').send({
        firstName: 'Attr',
        lastName: 'Bution',
        email: emails.unconfigured,
        password,
        provider: 'local',
        attribution: baseAttribution,
      }).expect(200);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }

    expect(result.body.user.email).toBe(emails.unconfigured);

    const brut = await UserService.getBrut({ email: emails.unconfigured });
    expect(Object.prototype.hasOwnProperty.call(brut.toObject(), 'attribution')).toBe(false);

    // capture() still fires (invite/referral tracking is independent of
    // attribution) but carries none of the flattened attribution keys.
    expect(captureSpy).toHaveBeenCalledTimes(1);
    const capturedProperties = captureSpy.mock.calls[0][0].properties;
    for (const key of ['referrer', 'landing_path', 'utm_source', 'utm_medium', 'utm_campaign']) {
      expect(Object.prototype.hasOwnProperty.call(capturedProperties, key)).toBe(false);
    }
  });

  test('rejects signup carrying an unknown attribution key with 422 (strict Attribution schema)', async () => {
    let result;
    try {
      result = await agent.post('/api/auth/signup').send({
        firstName: 'Attr',
        lastName: 'Bution',
        email: emails.bogus,
        password,
        provider: 'local',
        attribution: { bogusKey: 'x' },
      }).expect(422);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }

    expect(result.body.type).toBe('error');
    expect(result.body.message).toBe('Schema validation error');

    const persisted = await UserService.getBrut({ email: emails.bogus });
    expect(persisted == null).toBe(true);
  });
});
