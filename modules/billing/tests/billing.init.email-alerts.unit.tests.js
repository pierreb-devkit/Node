/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.email — setupBillingEmails() listener wiring.
 * Covers: meter.threshold_crossed (80 & 100) and payment.failed.
 */
describe('billing.email setupBillingEmails listeners:', () => {
  let setupBillingEmails;
  let mockMailer;
  let mockMembershipRepository;
  let mockBillingEvents;
  let mockConfig;
  let mockLogger;

  const orgId = '507f1f77bcf86cd799439011';

  // Captured listener callbacks per event name
  const listeners = {};

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      app: {
        title: 'MyApp',
        url: 'https://myapp.example.com',
        contact: 'support@myapp.example.com',
      },
      billing: {
        meterMode: false,
        packs: [],
      },
    };

    mockMailer = {
      isConfigured: jest.fn().mockReturnValue(true),
      sendMail: jest.fn().mockResolvedValue({ accepted: ['owner@test.com'], rejected: [] }),
    };

    mockMembershipRepository = {
      list: jest.fn().mockResolvedValue([
        { userId: { email: 'owner@test.com' } },
      ]),
    };

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    // Capture registered listeners so we can invoke them directly
    mockBillingEvents = {
      on: jest.fn((event, handler) => {
        listeners[event] = handler;
      }),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
      default: mockMailer,
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: mockLogger,
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: mockBillingEvents,
    }));

    // Relative path matches the import in billing.email.js
    jest.unstable_mockModule('../../organizations/repositories/organizations.membership.repository.js', () => ({
      default: mockMembershipRepository,
    }));

    jest.unstable_mockModule('../../organizations/lib/constants.js', () => ({
      MEMBERSHIP_ROLES: { OWNER: 'owner', ADMIN: 'admin', MEMBER: 'member' },
      MEMBERSHIP_STATUSES: { ACTIVE: 'active', PENDING: 'pending' },
    }));

    const mod = await import('../billing.email.js');
    setupBillingEmails = mod.setupBillingEmails;

    // Register listeners
    setupBillingEmails();
  });

  afterEach(() => {
    // Clear captured listeners
    for (const key of Object.keys(listeners)) delete listeners[key];
    jest.restoreAllMocks();
  });

  // ── meter.threshold_crossed ───────────────────────────────────────────────

  describe('meter.threshold_crossed listener', () => {
    test('sends 80% warning email when threshold=80 and mailer configured', async () => {
      expect(typeof listeners['meter.threshold_crossed']).toBe('function');
      listeners['meter.threshold_crossed']({
        organizationId: orgId,
        threshold: 80,
        meterUsed: 800,
        meterQuota: 1000,
        weekKey: '2026-W18',
      });

      // Promise resolution: allow microtasks to settle
      await new Promise((r) => setImmediate(r));

      expect(mockMembershipRepository.list).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: orgId }),
      );
      expect(mockMailer.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'owner@test.com',
          subject: expect.stringContaining('80%'),
          template: 'billing-quota-warning-80',
        }),
      );
    });

    test('sends 100% quota reached email when threshold=100', async () => {
      listeners['meter.threshold_crossed']({
        organizationId: orgId,
        threshold: 100,
        meterUsed: 1000,
        meterQuota: 1000,
        weekKey: '2026-W18',
      });

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'owner@test.com',
          subject: expect.stringContaining('weekly quota reached'),
          template: 'billing-quota-reached-100',
        }),
      );
    });

    test('subject includes appName from config.app.title', async () => {
      listeners['meter.threshold_crossed']({
        organizationId: orgId,
        threshold: 100,
        meterUsed: 1000,
        meterQuota: 1000,
        weekKey: '2026-W18',
      });

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('MyApp'),
        }),
      );
    });

    test('skips email when threshold is neither 80 nor 100', async () => {
      listeners['meter.threshold_crossed']({
        organizationId: orgId,
        threshold: 60,
        meterUsed: 600,
        meterQuota: 1000,
        weekKey: '2026-W18',
      });

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).not.toHaveBeenCalled();
    });

    test('skips email when mailer is not configured', async () => {
      mockMailer.isConfigured.mockReturnValue(false);

      listeners['meter.threshold_crossed']({
        organizationId: orgId,
        threshold: 80,
        meterUsed: 800,
        meterQuota: 1000,
        weekKey: '2026-W18',
      });

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).not.toHaveBeenCalled();
    });

    test('skips email when no owner/admin emails found', async () => {
      mockMembershipRepository.list.mockResolvedValue([]);

      listeners['meter.threshold_crossed']({
        organizationId: orgId,
        threshold: 80,
        meterUsed: 800,
        meterQuota: 1000,
        weekKey: '2026-W18',
      });

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).not.toHaveBeenCalled();
    });

    test('logs warn and skips email when membership lookup fails', async () => {
      mockMembershipRepository.list.mockRejectedValue(new Error('DB error'));

      // Should not throw
      expect(() =>
        listeners['meter.threshold_crossed']({
          organizationId: orgId,
          threshold: 80,
          meterUsed: 800,
          meterQuota: 1000,
          weekKey: '2026-W18',
        }),
      ).not.toThrow();

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).not.toHaveBeenCalled();
      // resolveOrgAdminEmails catches internally and logs warn
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('resolveOrgAdminEmails failed'),
        expect.objectContaining({ organizationId: orgId }),
      );
    });

    test('logs error but does not throw when sendMail rejects', async () => {
      mockMailer.sendMail.mockRejectedValue(new Error('SMTP error'));

      listeners['meter.threshold_crossed']({
        organizationId: orgId,
        threshold: 80,
        meterUsed: 800,
        meterQuota: 1000,
        weekKey: '2026-W18',
      });

      await new Promise((r) => setImmediate(r));

      // Give the Promise microtask queue one more tick for the sendMail rejection
      await new Promise((r) => setImmediate(r));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('email failed'),
        expect.objectContaining({ error: 'SMTP error' }),
      );
    });

    test('sends email to multiple owner/admin addresses', async () => {
      mockMembershipRepository.list.mockResolvedValue([
        { userId: { email: 'owner@test.com' } },
        { userId: { email: 'admin@test.com' } },
      ]);

      listeners['meter.threshold_crossed']({
        organizationId: orgId,
        threshold: 80,
        meterUsed: 800,
        meterQuota: 1000,
        weekKey: '2026-W18',
      });

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).toHaveBeenCalledTimes(2);
    });

    test('skips memberships with missing email', async () => {
      mockMembershipRepository.list.mockResolvedValue([
        { userId: null },
        { userId: { email: null } },
        { userId: { email: 'valid@test.com' } },
      ]);

      listeners['meter.threshold_crossed']({
        organizationId: orgId,
        threshold: 80,
        meterUsed: 800,
        meterQuota: 1000,
        weekKey: '2026-W18',
      });

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).toHaveBeenCalledTimes(1);
      expect(mockMailer.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'valid@test.com' }),
      );
    });
  });

  // ── payment.failed ────────────────────────────────────────────────────────

  describe('payment.failed listener', () => {
    test('sends payment failed email when mailer configured', async () => {
      expect(typeof listeners['payment.failed']).toBe('function');
      listeners['payment.failed']({ organizationId: orgId });

      await new Promise((r) => setImmediate(r));

      expect(mockMembershipRepository.list).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: orgId }),
      );
      expect(mockMailer.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'owner@test.com',
          subject: expect.stringContaining('billing'),
          template: 'billing-payment-failed',
        }),
      );
    });

    test('subject includes appName from config.app.title', async () => {
      listeners['payment.failed']({ organizationId: orgId });

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('MyApp'),
        }),
      );
    });

    test('skips email when mailer is not configured', async () => {
      mockMailer.isConfigured.mockReturnValue(false);

      listeners['payment.failed']({ organizationId: orgId });

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).not.toHaveBeenCalled();
    });

    test('skips email when no owner/admin emails found', async () => {
      mockMembershipRepository.list.mockResolvedValue([]);

      listeners['payment.failed']({ organizationId: orgId });

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).not.toHaveBeenCalled();
    });

    test('logs warn and skips email when membership lookup fails', async () => {
      mockMembershipRepository.list.mockRejectedValue(new Error('DB error'));

      expect(() => listeners['payment.failed']({ organizationId: orgId })).not.toThrow();

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).not.toHaveBeenCalled();
      // resolveOrgAdminEmails catches internally and logs warn
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('resolveOrgAdminEmails failed'),
        expect.objectContaining({ organizationId: orgId }),
      );
    });

    test('logs error but does not throw when sendMail rejects', async () => {
      mockMailer.sendMail.mockRejectedValue(new Error('SMTP error'));

      listeners['payment.failed']({ organizationId: orgId });

      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('email failed'),
        expect.objectContaining({ error: 'SMTP error' }),
      );
    });

    test('includes billingPortalUrl built from config.app.url', async () => {
      listeners['payment.failed']({ organizationId: orgId });

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            billingPortalUrl: 'https://myapp.example.com/billing',
          }),
        }),
      );
    });

    test('sets billingPortalUrl to empty string when config.app.url is missing', async () => {
      mockConfig.app = {};

      listeners['payment.failed']({ organizationId: orgId });

      await new Promise((r) => setImmediate(r));

      expect(mockMailer.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ billingPortalUrl: '' }),
        }),
      );
    });
  });
});
