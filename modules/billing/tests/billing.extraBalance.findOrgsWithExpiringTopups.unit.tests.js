/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for BillingExtraBalanceRepository.findOrgsWithExpiringTopups (PR-N5)
 */
describe('BillingExtraBalanceRepository.findOrgsWithExpiringTopups:', () => {
  let BillingExtraBalanceRepository;
  let mockModel;

  const orgId1 = '507f1f77bcf86cd799439011';
  const orgId2 = '507f1f77bcf86cd799439022';

  /**
   * @param {string} topupId - Fake ObjectId for the topup entry.
   * @param {Date} expiresAt - Expiry date for the topup.
   * @param {boolean} [withExpiration=false] - Whether to include a matching expiration entry.
   * @returns {Array} Ledger array.
   */
  const makeLedger = (topupId, expiresAt, withExpiration = false) => {
    const ledger = [
      { _id: topupId, kind: 'topup', amount: 1000, expiresAt },
    ];
    if (withExpiration) {
      ledger.push({ kind: 'expiration', amount: -1000, refId: `expire-${topupId}` });
    }
    return ledger;
  };

  beforeEach(async () => {
    jest.resetModules();

    mockModel = {
      find: jest.fn(),
    };

    jest.unstable_mockModule('mongoose', () => ({
      default: {
        Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(id) } },
        model: jest.fn(() => mockModel),
      },
    }));

    const mod = await import('../repositories/billing.extraBalance.repository.js');
    BillingExtraBalanceRepository = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns empty array when no docs match', async () => {
    mockModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });

    const result = await BillingExtraBalanceRepository.findOrgsWithExpiringTopups(new Date());
    expect(result).toEqual([]);
  });

  test('throws TypeError when now is not a Date', async () => {
    await expect(BillingExtraBalanceRepository.findOrgsWithExpiringTopups('2026-01-01')).rejects.toThrow(TypeError);
    await expect(BillingExtraBalanceRepository.findOrgsWithExpiringTopups(null)).rejects.toThrow(TypeError);
    await expect(BillingExtraBalanceRepository.findOrgsWithExpiringTopups(undefined)).rejects.toThrow(TypeError);
    await expect(BillingExtraBalanceRepository.findOrgsWithExpiringTopups(Date.now())).rejects.toThrow(TypeError);
  });

  test('returns orgId when unhandled expired topup exists', async () => {
    const now = new Date();
    const pastDate = new Date(now.getTime() - 1000);
    const topupId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const docs = [
      { organization: orgId1, ledger: makeLedger(topupId, pastDate, false) },
    ];
    mockModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) });

    const result = await BillingExtraBalanceRepository.findOrgsWithExpiringTopups(now);
    expect(result).toContain(orgId1);
  });

  test('excludes org when all expired topups already have expiration entries', async () => {
    const now = new Date();
    const pastDate = new Date(now.getTime() - 1000);
    const topupId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const docs = [
      { organization: orgId1, ledger: makeLedger(topupId, pastDate, true) },
    ];
    mockModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) });

    const result = await BillingExtraBalanceRepository.findOrgsWithExpiringTopups(now);
    expect(result).not.toContain(orgId1);
  });

  test('excludes org when topup is not yet expired (expiresAt in the future)', async () => {
    const now = new Date();
    const futureDate = new Date(now.getTime() + 10000);
    const topupId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const docs = [
      { organization: orgId1, ledger: makeLedger(topupId, futureDate, false) },
    ];
    mockModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) });

    const result = await BillingExtraBalanceRepository.findOrgsWithExpiringTopups(now);
    expect(result).not.toContain(orgId1);
  });

  test('returns multiple orgIds when multiple orgs have unhandled expirations', async () => {
    const now = new Date();
    const pastDate = new Date(now.getTime() - 1000);
    const topupId1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const topupId2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const docs = [
      { organization: orgId1, ledger: makeLedger(topupId1, pastDate, false) },
      { organization: orgId2, ledger: makeLedger(topupId2, pastDate, false) },
    ];
    mockModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) });

    const result = await BillingExtraBalanceRepository.findOrgsWithExpiringTopups(now);
    expect(result).toHaveLength(2);
    expect(result).toContain(orgId1);
    expect(result).toContain(orgId2);
  });

  test('handles org with mixed expired (handled) and unhandled topups — returns org', async () => {
    const now = new Date();
    const pastDate = new Date(now.getTime() - 1000);
    const topupId1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const topupId2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    // topupId1 already has expiration, topupId2 does not
    const ledger = [
      { _id: topupId1, kind: 'topup', amount: 1000, expiresAt: pastDate },
      { kind: 'expiration', amount: -1000, refId: `expire-${topupId1}` },
      { _id: topupId2, kind: 'topup', amount: 500, expiresAt: pastDate },
    ];
    const docs = [{ organization: orgId1, ledger }];
    mockModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) });

    const result = await BillingExtraBalanceRepository.findOrgsWithExpiringTopups(now);
    expect(result).toContain(orgId1);
  });
});
