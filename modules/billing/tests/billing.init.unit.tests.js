/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.init — boot validators.
 */
describe('billing.init unit tests:', () => {
  let billingInit;
  let mockBillingUsageRepository;
  let mockConfig;
  let mockDistinct;
  let mockMongoose;
  let mockLogger;
  let mockInvitationEvents;
  let mockReferralService;

  const mockApp = {};

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        meterMode: false,
        packs: [],
      },
    };

    mockBillingUsageRepository = {
      countLegacyConsumedHistoryIds: jest.fn().mockResolvedValue(0),
    };

    mockDistinct = jest.fn().mockResolvedValue([]);
    mockMongoose = {
      model: jest.fn().mockReturnValue({ distinct: mockDistinct }),
    };

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../repositories/billing.usage.repository.js', () => ({
      default: mockBillingUsageRepository,
    }));

    // Stub analytics, logger and events to avoid side effects
    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { groupIdentify: jest.fn() },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: mockLogger,
    }));

    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { on: jest.fn(), emit: jest.fn() },
    }));

    // P8a: billing is an optional consumer of the invitations `invitation.accepted`
    // event — stub the singleton so the unit test asserts the listener wiring in isolation.
    mockInvitationEvents = { on: jest.fn(), emit: jest.fn() };
    jest.unstable_mockModule('../../invitations/lib/events.js', () => ({
      default: mockInvitationEvents,
    }));

    // #3842: the listener lazy-imports the referral service — stub it so the wiring
    // tests stay isolated from users/organizations resolution.
    mockReferralService = { grantForInvitation: jest.fn().mockResolvedValue({}) };
    jest.unstable_mockModule('../services/billing.referral.service.js', () => ({
      default: mockReferralService,
    }));

    // Stub billing.email so boot validator tests don't wire real email listeners
    jest.unstable_mockModule('../billing.email.js', () => ({
      setupBillingEmails: jest.fn(),
    }));

    jest.unstable_mockModule('mongoose', () => ({
      default: mockMongoose,
    }));

    const mod = await import('../billing.init.js');
    billingInit = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('resolves without error when meterMode=false', async () => {
    await expect(billingInit(mockApp)).resolves.toBeUndefined();
  });

  describe('#3842 referral grant listener (invitation.accepted):', () => {
    const payload = { invitationId: 'i1', email: 'a@b.co', invitedBy: 'x', acceptedUserId: 'u1' };

    /**
     * Boot the module and return the registered invitation.accepted handler.
     * @returns {Promise<Function>} The wired listener.
     */
    const getHandler = async () => {
      await billingInit(mockApp);
      const acceptedCall = mockInvitationEvents.on.mock.calls.find(([evt]) => evt === 'invitation.accepted');
      expect(acceptedCall).toBeDefined();
      return acceptedCall[1];
    };

    test('wires the listener on the invitations emitter', async () => {
      const handler = await getHandler();
      expect(typeof handler).toBe('function');
    });

    test('config-gated: disabled (default) → returns immediately, the service is never imported/called', async () => {
      // mockConfig.billing has NO referral block — existing deployments unaffected.
      const handler = await getHandler();
      await handler(payload);
      expect(mockReferralService.grantForInvitation).not.toHaveBeenCalled();
    });

    test('config-gated: enabled:false explicitly → no-op', async () => {
      mockConfig.billing.referral = { enabled: false, referrerUnits: 1000, refereeUnits: 500 };
      const handler = await getHandler();
      await handler(payload);
      expect(mockReferralService.grantForInvitation).not.toHaveBeenCalled();
    });

    test('enabled → delegates the payload to BillingReferralService.grantForInvitation', async () => {
      mockConfig.billing.referral = { enabled: true, referrerUnits: 1000, refereeUnits: 500 };
      const handler = await getHandler();
      await handler(payload);
      expect(mockReferralService.grantForInvitation).toHaveBeenCalledTimes(1);
      expect(mockReferralService.grantForInvitation).toHaveBeenCalledWith(payload);
    });

    test('self-guard: a grant REJECTION is swallowed + logged, never escapes the listener', async () => {
      mockConfig.billing.referral = { enabled: true, referrerUnits: 1000, refereeUnits: 500 };
      mockReferralService.grantForInvitation.mockRejectedValue(new Error('mongo down'));
      const handler = await getHandler();
      // The emit-site catch is sync-only — the async listener must resolve, not reject.
      await expect(handler(payload)).resolves.toBeUndefined();
      const errCall = mockLogger.error.mock.calls.find(([msg]) => msg.includes('referral grant failed'));
      expect(errCall).toBeDefined();
      expect(errCall[1]).toMatchObject({ invitationId: 'i1', err: 'mongo down' });
    });

    test('self-guard: even a malformed payload cannot make the listener throw/reject', async () => {
      mockConfig.billing.referral = { enabled: true, referrerUnits: 1000, refereeUnits: 500 };
      mockReferralService.grantForInvitation.mockRejectedValue(new Error('boom'));
      const handler = await getHandler();
      await expect(handler(undefined)).resolves.toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  test('resolves without error when meterMode=true and no legacy docs', async () => {
    mockConfig.billing.meterMode = true;
    mockConfig.billing.plans = ['free', 'growth', 'pro'];

    await expect(billingInit(mockApp)).resolves.toBeUndefined();
  });

  test('boot validator warns on orphaned Subscription.plan values when meterMode=true', async () => {
    mockConfig.billing.meterMode = true;
    mockConfig.billing.plans = ['free', 'starter', 'pro'];

    mockDistinct.mockResolvedValue(['free', 'legacy_plan']);

    await billingInit(mockApp);

    expect(mockDistinct).toHaveBeenCalledWith('plan');
    // After Batch 4 item 6: uses logger.warn instead of console.warn
    const warnCalls = mockLogger.warn.mock.calls.map((c) => c[0]);
    expect(warnCalls.some((w) => w.includes('"legacy_plan" not in planDefinitions'))).toBe(true);
    expect(warnCalls.some((w) => w.includes('"free"'))).toBe(false);
  });

  test('meterMode=true aborts boot when legacy consumedHistoryIds fields remain', async () => {
    mockConfig.billing.meterMode = true;
    mockBillingUsageRepository.countLegacyConsumedHistoryIds.mockResolvedValue(2);

    await expect(billingInit(mockApp)).rejects.toThrow('legacy consumedHistoryIds field still present');
  });

  test('warns at boot when thresholdPercents contains unsupported value (not 80/100)', async () => {
    mockConfig.billing.meterMode = true;
    mockConfig.billing.alerts = { thresholdPercents: [75] };
    mockConfig.billing.plans = ['free'];

    await billingInit(mockApp);

    // After Batch 4 item 6: uses logger.warn instead of console.warn
    const warnCalls = mockLogger.warn.mock.calls.map((c) => c[0]);
    expect(warnCalls.some((w) => w.includes('75%') && w.includes('silently skipped'))).toBe(true);
  });

  test('does not warn at boot when thresholdPercents contains only supported values', async () => {
    mockConfig.billing.meterMode = true;
    mockConfig.billing.alerts = { thresholdPercents: [80, 100] };
    mockConfig.billing.plans = ['free'];

    await billingInit(mockApp);

    const warnCalls = mockLogger.warn.mock.calls.map((c) => c[0]);
    expect(warnCalls.some((w) => typeof w === 'string' && w.includes('silently skipped'))).toBe(false);
  });

  test('does not warn at boot for threshold validation when meterMode=false', async () => {
    mockConfig.billing.meterMode = false;
    mockConfig.billing.alerts = { thresholdPercents: [75] };

    await billingInit(mockApp);

    const warnCalls = mockLogger.warn.mock.calls.map((c) => c[0]);
    expect(warnCalls.some((w) => typeof w === 'string' && w.includes('silently skipped'))).toBe(false);
  });

  test('boot validator failure does not crash boot', async () => {
    mockConfig.billing.meterMode = true;
    mockConfig.billing.plans = ['free'];

    mockMongoose.model.mockImplementation(() => {
      throw new Error('model not registered');
    });

    await expect(billingInit(mockApp)).resolves.toBeUndefined();
  });
});
