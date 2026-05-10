/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for HomeService.getReadinessStatus().
 * Verifies the readiness check rows: drop monitoring/Sentry row,
 * add errorTracking/PostHog row.
 */
describe('HomeService.getReadinessStatus unit tests:', () => {
  let mockMailerIsConfigured;

  beforeEach(() => {
    jest.resetModules();
    mockMailerIsConfigured = jest.fn().mockReturnValue(false);

    // Mock mailer to avoid real SMTP config
    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
      default: { isConfigured: mockMailerIsConfigured },
    }));

    // Mock repository to avoid Mongoose schema registration requirement
    jest.unstable_mockModule('../repositories/home.repository.js', () => ({
      default: { team: jest.fn().mockResolvedValue([]) },
    }));

    // Mock axios to avoid real network calls
    jest.unstable_mockModule('axios', () => ({
      default: { get: jest.fn().mockResolvedValue({ data: [] }), all: jest.fn().mockResolvedValue([]) },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const withConfig = async (configOverride) => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        domain: '',
        jwt: { secret: 'WaosSecretKeyExampleToChnageAbsolutely' },
        oAuth: {},
        stripe: {},
        posthog: {},
        ...configOverride,
      },
    }));
    const { default: HomeService } = await import('../services/home.service.js');
    return HomeService;
  };

  test('returns expected category list (no monitoring row, has errorTracking row)', async () => {
    const HomeService = await withConfig({});
    const checks = HomeService.getReadinessStatus();
    const categories = checks.map((c) => c.category);
    expect(categories).toEqual(['config', 'security', 'auth', 'mail', 'billing', 'analytics', 'errorTracking']);
    expect(categories).not.toContain('monitoring');
  });

  describe('errorTracking row', () => {
    test('ok when posthog.apiKey is set AND errorTracking=true', async () => {
      const HomeService = await withConfig({
        posthog: { apiKey: 'ph_test_key', errorTracking: true },
      });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'errorTracking');
      expect(row.status).toBe('ok');
      expect(row.message).toBe('PostHog $exception capture enabled');
    });

    test('warning when posthog.apiKey is set but errorTracking=false', async () => {
      const HomeService = await withConfig({
        posthog: { apiKey: 'ph_test_key', errorTracking: false },
      });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'errorTracking');
      expect(row.status).toBe('warning');
      expect(row.message).toContain('posthog.errorTracking=true');
    });

    test('warning when posthog.apiKey is missing (even if errorTracking=true)', async () => {
      const HomeService = await withConfig({
        posthog: { errorTracking: true },
      });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'errorTracking');
      expect(row.status).toBe('warning');
    });

    test('warning when posthog is not configured at all', async () => {
      const HomeService = await withConfig({ posthog: {} });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'errorTracking');
      expect(row.status).toBe('warning');
    });
  });

  describe('analytics row', () => {
    test('ok when posthog.apiKey is set', async () => {
      const HomeService = await withConfig({
        posthog: { apiKey: 'ph_test_key' },
      });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'analytics');
      expect(row.status).toBe('ok');
      expect(row.message).toContain('PostHog configured');
    });

    test('warning when posthog.apiKey is missing', async () => {
      const HomeService = await withConfig({ posthog: {} });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'analytics');
      expect(row.status).toBe('warning');
    });
  });
});
