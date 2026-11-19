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

  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const withConfig = async (configOverride) => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        domain: '',
        jwt: { secret: 'DevkitSecretKeyExampleToChangeAbsolutely' },
        oAuth: {},
        stripe: {},
        analytics: { posthog: {} },
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

  describe('billing row', () => {
    test('warning when Stripe is not configured', async () => {
      const HomeService = await withConfig({});
      const row = HomeService.getReadinessStatus().find((c) => c.category === 'billing');
      expect(row).toEqual({ category: 'billing', status: 'warning', message: 'Stripe not configured' });
    });

    test('ok when Stripe is configured and billing is on', async () => {
      const HomeService = await withConfig({ stripe: { secretKey: 'sk_test_123' }, billing: { enabled: true } });
      const row = HomeService.getReadinessStatus().find((c) => c.category === 'billing');
      expect(row.status).toBe('ok');
      expect(row.message).toBe('Stripe configured');
    });

    test('never ok when billing is switched off, even with a Stripe key (no Stripe probe at boot)', async () => {
      const HomeService = await withConfig({ stripe: { secretKey: 'sk_test_123' }, billing: { activated: false, enabled: false } });
      const row = HomeService.getReadinessStatus().find((c) => c.category === 'billing');
      expect(row.status).toBe('warning');
      expect(row.message).toBe('Billing is switched off');
    });
  });

  describe('mail row', () => {
    test('warning message states the consequence when no mail provider is configured', async () => {
      const HomeService = await withConfig({});
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'mail');
      expect(row.status).toBe('warning');
      expect(row.message).toBe('No mail provider configured — users register without email verification');
    });

    test('ok message is unchanged when a mail provider is configured', async () => {
      mockMailerIsConfigured.mockReturnValue(true);
      const HomeService = await withConfig({});
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'mail');
      expect(row.status).toBe('ok');
      expect(row.message).toBe('Mail provider configured');
    });
  });

  describe('errorTracking row', () => {
    test('ok when analytics.posthog.key is set AND errorTracking=true', async () => {
      const HomeService = await withConfig({
        analytics: { posthog: { key: 'ph_test_key', errorTracking: true } },
      });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'errorTracking');
      expect(row.status).toBe('ok');
      expect(row.message).toBe('PostHog $exception capture enabled');
    });

    test('warning when analytics.posthog.key is set but errorTracking=false', async () => {
      const HomeService = await withConfig({
        analytics: { posthog: { key: 'ph_test_key', errorTracking: false } },
      });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'errorTracking');
      expect(row.status).toBe('warning');
      expect(row.message).toContain('analytics.posthog.errorTracking=true');
    });

    test('warning when analytics.posthog.key is missing (even if errorTracking=true)', async () => {
      const HomeService = await withConfig({
        analytics: { posthog: { errorTracking: true } },
      });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'errorTracking');
      expect(row.status).toBe('warning');
    });

    test('warning when posthog is not configured at all', async () => {
      const HomeService = await withConfig({ analytics: { posthog: {} } });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'errorTracking');
      expect(row.status).toBe('warning');
    });
  });

  describe('analytics row', () => {
    test('ok when analytics.posthog.key is set', async () => {
      const HomeService = await withConfig({
        analytics: { posthog: { key: 'ph_test_key' } },
      });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'analytics');
      expect(row.status).toBe('ok');
      expect(row.message).toContain('PostHog configured');
    });

    test('warning when analytics.posthog.key is missing', async () => {
      const HomeService = await withConfig({ analytics: { posthog: {} } });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'analytics');
      expect(row.status).toBe('warning');
    });
  });

  describe('security (JWT) row — uses shared isJwtSecretWeak', () => {
    test('warning when jwt.secret is a known default placeholder', async () => {
      const HomeService = await withConfig({ jwt: { secret: 'DevkitSecretKeyExampleToChangeAbsolutely' } });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'security');
      expect(row.status).toBe('warning');
      expect(row.message).toContain('known default');
    });

    test('warning when jwt.secret is too short', async () => {
      const HomeService = await withConfig({ jwt: { secret: 'tooshort' } });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'security');
      expect(row.status).toBe('warning');
    });

    test('ok when jwt.secret is a strong (≥32-char, non-default) secret', async () => {
      const HomeService = await withConfig({ jwt: { secret: 'a'.repeat(32) } });
      const checks = HomeService.getReadinessStatus();
      const row = checks.find((c) => c.category === 'security');
      expect(row.status).toBe('ok');
      expect(row.message).toBe('JWT secret is custom');
    });
  });
});

/**
 * Unit tests for HomeService.page(): the file read stays inside config/markdown.
 */
describe('HomeService.page unit tests:', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
      default: { isConfigured: jest.fn().mockReturnValue(false) },
    }));
    jest.unstable_mockModule('../repositories/home.repository.js', () => ({
      default: { team: jest.fn().mockResolvedValue([]) },
    }));
  });

  test('should read a page from config/markdown', async () => {
    const { default: HomeService } = await import('../services/home.service.js');
    const result = await HomeService.page('terms');
    expect(result[0].title).toBe('Terms');
    expect(typeof result[0].markdown).toBe('string');
  });

  test('should not read a file outside config/markdown', async () => {
    const { default: HomeService } = await import('../services/home.service.js');
    // README.md exists at the repo root; the name must resolve to config/markdown/README.md instead.
    await expect(HomeService.page('../../README')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
