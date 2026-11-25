/**
 * Module dependencies.
 */
import { jest, describe, it, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.signupGrant.service.js
 */
describe('BillingSignupGrantService unit tests:', () => {
  let BillingSignupGrantService;
  let mockRepository;
  let mockPlanService;
  let mockLogger;
  let mockOrganizationsService;

  const orgId = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    jest.resetModules();

    mockRepository = {
      creditGrant: jest.fn(),
      hasSignupGrantInOrgs: jest.fn().mockResolvedValue(false),
    };

    mockOrganizationsService = {
      listOtherIdsBySameCreator: jest.fn().mockResolvedValue(null),
    };

    jest.unstable_mockModule('../../organizations/services/organizations.crud.service.js', () => ({
      default: mockOrganizationsService,
    }));

    mockPlanService = {
      getActivePlan: jest.fn(),
    };

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
      default: mockRepository,
    }));

    jest.unstable_mockModule('../services/billing.plan.service.js', () => ({
      default: mockPlanService,
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: mockLogger,
    }));

    const mod = await import('../services/billing.signupGrant.service.js');
    BillingSignupGrantService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('grantOnSignup', () => {
    it('credits the configured signupGrant when plan has one', async () => {
      mockPlanService.getActivePlan.mockReturnValue({ planId: 'free', signupGrant: 500, oneShot: true, meterQuota: 0, ratios: {} });
      mockRepository.creditGrant.mockResolvedValue({ doc: {}, applied: true });

      await BillingSignupGrantService.grantOnSignup({ orgId, planId: 'free' });

      expect(mockPlanService.getActivePlan).toHaveBeenCalledWith('free');
      expect(mockRepository.creditGrant).toHaveBeenCalledWith(orgId, 500, 'signup_grant');
    });

    it('does nothing when plan has no signupGrant', async () => {
      mockPlanService.getActivePlan.mockReturnValue({ planId: 'growth', meterQuota: 1600, ratios: {} });

      const result = await BillingSignupGrantService.grantOnSignup({ orgId, planId: 'growth' });

      expect(mockRepository.creditGrant).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('swallows credit errors (best-effort — signup must not fail)', async () => {
      mockPlanService.getActivePlan.mockReturnValue({ planId: 'free', signupGrant: 500, oneShot: true, meterQuota: 0, ratios: {} });
      mockRepository.creditGrant.mockRejectedValue(new Error('db unavailable'));

      await expect(
        BillingSignupGrantService.grantOnSignup({ orgId, planId: 'free' }),
      ).resolves.toBeNull();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('[billing.signupGrant]'),
        expect.objectContaining({ orgId, planId: 'free' }),
      );
    });

    it('defaults planId to "free" when not provided', async () => {
      mockPlanService.getActivePlan.mockReturnValue({ planId: 'free', signupGrant: 500, oneShot: true, meterQuota: 0, ratios: {} });
      mockRepository.creditGrant.mockResolvedValue({ doc: {}, applied: true });

      await BillingSignupGrantService.grantOnSignup({ orgId });

      expect(mockPlanService.getActivePlan).toHaveBeenCalledWith('free');
    });

    it('returns null and logs warn when plan config is not found', async () => {
      mockPlanService.getActivePlan.mockReturnValue(null);

      const result = await BillingSignupGrantService.grantOnSignup({ orgId, planId: 'unknown' });

      expect(mockRepository.creditGrant).not.toHaveBeenCalled();
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[billing.signupGrant]'),
        expect.objectContaining({ orgId, planId: 'unknown' }),
      );
    });

    it('logs warn on duplicate grant (applied: false — idempotent no-op)', async () => {
      mockPlanService.getActivePlan.mockReturnValue({ planId: 'free', signupGrant: 500, oneShot: true, meterQuota: 0, ratios: {} });
      mockRepository.creditGrant.mockResolvedValue({ doc: null, applied: false, reason: 'duplicate_grant' });

      const result = await BillingSignupGrantService.grantOnSignup({ orgId, planId: 'free' });

      expect(result?.applied).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('duplicate grant skipped'),
        expect.objectContaining({ orgId, planId: 'free', reason: 'duplicate_grant' }),
      );
      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it('skips the grant when another org created by the same user already got one', async () => {
      mockPlanService.getActivePlan.mockReturnValue({ planId: 'free', signupGrant: 500, oneShot: true, meterQuota: 0, ratios: {} });
      mockOrganizationsService.listOtherIdsBySameCreator.mockResolvedValue(['507f1f77bcf86cd799439022']);
      mockRepository.hasSignupGrantInOrgs.mockResolvedValue(true);

      const result = await BillingSignupGrantService.grantOnSignup({ orgId, planId: 'free' });

      expect(mockOrganizationsService.listOtherIdsBySameCreator).toHaveBeenCalledWith(orgId);
      expect(mockRepository.hasSignupGrantInOrgs).toHaveBeenCalledWith(['507f1f77bcf86cd799439022']);
      expect(mockRepository.creditGrant).not.toHaveBeenCalled();
      expect(result).toEqual({ doc: null, applied: false, reason: 'creator_already_granted' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('creator already received a signup grant'),
        expect.objectContaining({ orgId, planId: 'free' }),
      );
    });

    it('credits when the creator\'s other orgs hold no signup grant', async () => {
      mockPlanService.getActivePlan.mockReturnValue({ planId: 'free', signupGrant: 500, oneShot: true, meterQuota: 0, ratios: {} });
      mockOrganizationsService.listOtherIdsBySameCreator.mockResolvedValue(['507f1f77bcf86cd799439022']);
      mockRepository.hasSignupGrantInOrgs.mockResolvedValue(false);
      mockRepository.creditGrant.mockResolvedValue({ doc: {}, applied: true });

      await BillingSignupGrantService.grantOnSignup({ orgId, planId: 'free' });

      expect(mockRepository.creditGrant).toHaveBeenCalledWith(orgId, 500, 'signup_grant');
    });

    it('credits without reading the ledger when the org has no known creator or no other org', async () => {
      mockPlanService.getActivePlan.mockReturnValue({ planId: 'free', signupGrant: 500, oneShot: true, meterQuota: 0, ratios: {} });
      mockRepository.creditGrant.mockResolvedValue({ doc: {}, applied: true });

      mockOrganizationsService.listOtherIdsBySameCreator.mockResolvedValueOnce(null);
      await BillingSignupGrantService.grantOnSignup({ orgId, planId: 'free' });
      mockOrganizationsService.listOtherIdsBySameCreator.mockResolvedValueOnce([]);
      await BillingSignupGrantService.grantOnSignup({ orgId, planId: 'free' });

      expect(mockRepository.hasSignupGrantInOrgs).not.toHaveBeenCalled();
      expect(mockRepository.creditGrant).toHaveBeenCalledTimes(2);
    });
  });
});
