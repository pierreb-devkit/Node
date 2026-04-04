/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for developers policy registration
 */
describe('Developers policy unit tests:', () => {
  let policy;

  beforeEach(async () => {
    jest.resetModules();

    const mod = await import('../../../lib/middlewares/policy.js');
    policy = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('deriveSubjectType', () => {
    test('should map /api/developers/keys to DeveloperKey', () => {
      expect(policy.deriveSubjectType('/api/developers/keys')).toBe('DeveloperKey');
    });

    test('should map /api/developers/keys/:keyId to DeveloperKey', () => {
      expect(policy.deriveSubjectType('/api/developers/keys/:keyId')).toBe('DeveloperKey');
    });

    test('should map /api/developers/webhooks to DeveloperWebhook', () => {
      expect(policy.deriveSubjectType('/api/developers/webhooks')).toBe('DeveloperWebhook');
    });

    test('should map /api/developers/webhooks/:webhookId to DeveloperWebhook', () => {
      expect(policy.deriveSubjectType('/api/developers/webhooks/:webhookId')).toBe('DeveloperWebhook');
    });

    test('should map /api/developers/webhooks/:webhookId/deliveries to DeveloperWebhook', () => {
      expect(policy.deriveSubjectType('/api/developers/webhooks/:webhookId/deliveries')).toBe('DeveloperWebhook');
    });

    test('should map /api/developers/webhooks/:webhookId/test to DeveloperWebhook', () => {
      expect(policy.deriveSubjectType('/api/developers/webhooks/:webhookId/test')).toBe('DeveloperWebhook');
    });
  });
});
