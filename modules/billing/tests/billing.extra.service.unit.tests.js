/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.extra.service.js
 */
describe('BillingExtraService unit tests:', () => {
  let BillingExtraService;
  let mockRepository;
  let mockConfig;

  const orgId = '507f1f77bcf86cd799439011';

  /**
   * @param {Object} [overrides={}] - Fields to override on the stub document.
   * @returns {Object} A stub ExtraBalance document.
   */
  const makeDoc = (overrides = {}) => ({
    _id: '507f1f77bcf86cd799439099',
    organization: orgId,
    ledger: [],
    cachedBalance: 0,
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        meterMode: true,
        plans: ['pro'],
        packs: [
          { packId: 'pack_500k', meterUnits: 500000, priceUsd: 49, stripePriceId: 'price_abc' },
          { packId: 'pack_2m', meterUnits: 2000000, priceUsd: 149, stripePriceId: 'price_def', expiryDays: 365 },
        ],
      },
    };

    mockRepository = {
      creditPack: jest.fn(),
      debit: jest.fn(),
      addExpirationEntries: jest.fn(),
      getOrCreate: jest.fn(),
      getBalance: jest.fn(),
      refundPartial: jest.fn(),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
      default: mockRepository,
    }));

    // billing.extra.service.js imports logger and billingEvents at module load time —
    // mock them to prevent logger from trying to read config files during test setup.
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));
    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: jest.fn() },
    }));

    const mod = await import('../services/billing.extra.service.js');
    BillingExtraService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('creditPack', () => {
    test('should delegate to repository with correct amount', async () => {
      const doc = makeDoc({ cachedBalance: 500000 });
      mockRepository.creditPack.mockResolvedValue({ doc, applied: true });

      const result = await BillingExtraService.creditPack(orgId, 'pack_500k', 'cs_abc');

      expect(mockRepository.creditPack).toHaveBeenCalledWith(orgId, 500000, 'cs_abc', null);
      expect(result.applied).toBe(true);
    });

    test('should compute expiresAt when pack has expiryDays', async () => {
      const doc = makeDoc({ cachedBalance: 2000000 });
      mockRepository.creditPack.mockResolvedValue({ doc, applied: true });

      const before = Date.now();
      await BillingExtraService.creditPack(orgId, 'pack_2m', 'cs_def');
      const after = Date.now();

      const [, , , expiresAt] = mockRepository.creditPack.mock.calls[0];
      expect(expiresAt).toBeInstanceOf(Date);
      const ms = expiresAt.getTime();
      expect(ms).toBeGreaterThanOrEqual(before + 365 * 24 * 60 * 60 * 1000 - 100);
      expect(ms).toBeLessThanOrEqual(after + 365 * 24 * 60 * 60 * 1000 + 100);
    });

    test('should return applied=false on idempotent re-call (same stripeSessionId)', async () => {
      const doc = makeDoc({ cachedBalance: 500000 });
      mockRepository.creditPack.mockResolvedValue({ doc, applied: false });

      const result = await BillingExtraService.creditPack(orgId, 'pack_500k', 'cs_abc_duplicate');
      expect(result.applied).toBe(false);
    });

    test('should throw when packId is unknown', async () => {
      await expect(BillingExtraService.creditPack(orgId, 'pack_unknown', 'cs_abc')).rejects.toThrow('Pack not found');
    });
  });

  describe('debit', () => {
    test('should delegate to repository', async () => {
      const doc = makeDoc({ cachedBalance: 400000 });
      mockRepository.debit.mockResolvedValue({ doc, applied: true });

      const result = await BillingExtraService.debit(orgId, 100000, 'ref_hist_123');

      expect(mockRepository.debit).toHaveBeenCalledWith(orgId, 100000, 'ref_hist_123');
      expect(result.applied).toBe(true);
    });

    test('should return applied=false when balance is insufficient', async () => {
      mockRepository.debit.mockResolvedValue({ doc: null, applied: false });

      const result = await BillingExtraService.debit(orgId, 999999999, 'ref_overflow');
      expect(result.applied).toBe(false);
    });

    test('debit same refId twice → second is no-op', async () => {
      const doc = makeDoc({ cachedBalance: 400000 });
      mockRepository.debit
        .mockResolvedValueOnce({ doc, applied: true })
        .mockResolvedValueOnce({ doc: null, applied: false });

      const r1 = await BillingExtraService.debit(orgId, 100, 'ref_same');
      const r2 = await BillingExtraService.debit(orgId, 100, 'ref_same');

      expect(r1.applied).toBe(true);
      expect(r2.applied).toBe(false);
    });
  });

  describe('getOrgBalanceContext', () => {
    test('should delegate balance lookup to repository', async () => {
      mockRepository.getBalance.mockResolvedValue(150000);

      const result = await BillingExtraService.getOrgBalanceContext(orgId);

      expect(mockRepository.getBalance).toHaveBeenCalledWith(orgId);
      expect(result).toBe(150000);
    });
  });

  describe('expireOldEntries', () => {
    test('should delegate to repository with current date', async () => {
      mockRepository.addExpirationEntries.mockResolvedValue(2);

      const result = await BillingExtraService.expireOldEntries(orgId);

      expect(mockRepository.addExpirationEntries).toHaveBeenCalledWith(orgId, expect.any(Date));
      expect(result).toBe(2);
    });

    test('should return 0 when nothing expired', async () => {
      mockRepository.addExpirationEntries.mockResolvedValue(0);

      const result = await BillingExtraService.expireOldEntries(orgId);
      expect(result).toBe(0);
    });

    test('expireOldEntries is idempotent — re-run returns 0 the second time', async () => {
      mockRepository.addExpirationEntries
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      const r1 = await BillingExtraService.expireOldEntries(orgId);
      const r2 = await BillingExtraService.expireOldEntries(orgId);

      expect(r1).toBe(1);
      expect(r2).toBe(0); // idempotent
    });
  });

  describe('listLedger', () => {
    test('should return empty result when getOrCreate returns null (malformed orgId)', async () => {
      mockRepository.getOrCreate.mockResolvedValue(null);

      const result = await BillingExtraService.listLedger('bad-org-id');
      expect(result).toEqual({ entries: [], total: 0, balance: 0 });
    });

    test('should return paginated ledger entries in reverse chronological order', async () => {
      const t1 = new Date('2026-05-01T10:00:00Z');
      const t2 = new Date('2026-05-02T10:00:00Z');
      const doc = makeDoc({
        cachedBalance: 900000,
        ledger: [
          { kind: 'topup', amount: 500000, at: t1 },
          { kind: 'topup', amount: 500000, at: t2 },
          { kind: 'debit', amount: -100000, at: new Date('2026-05-03T10:00:00Z') },
        ],
      });
      mockRepository.getOrCreate.mockResolvedValue(doc);

      const result = await BillingExtraService.listLedger(orgId, { page: 1, limit: 2 });

      expect(result.total).toBe(3);
      expect(result.balance).toBe(900000);
      expect(result.entries).toHaveLength(2);
      // Newest first
      expect(result.entries[0].kind).toBe('debit');
    });

    test('should return second page correctly', async () => {
      const doc = makeDoc({
        cachedBalance: 0,
        ledger: [
          { kind: 'topup', amount: 100, at: new Date('2026-01-01') },
          { kind: 'topup', amount: 100, at: new Date('2026-02-01') },
          { kind: 'topup', amount: 100, at: new Date('2026-03-01') },
        ],
      });
      mockRepository.getOrCreate.mockResolvedValue(doc);

      const result = await BillingExtraService.listLedger(orgId, { page: 2, limit: 2 });

      expect(result.entries).toHaveLength(1);
    });
  });

  describe('refundPartial', () => {
    test('should return applied=false when no matching topup entry found', async () => {
      const doc = makeDoc({ ledger: [] });
      mockRepository.getOrCreate.mockResolvedValue(doc);

      const result = await BillingExtraService.refundPartial(orgId, 'cs_notfound', 4900);
      expect(result.applied).toBe(false);
      expect(result.refundUnits).toBe(0);
    });

    test('should compute proportional refund units when pack is found', async () => {
      // pack_500k: 500000 units, $49 price — full refund of $49 = 500000 units back
      const topupEntry = {
        _id: '507f1f77bcf86cd799439aaa',
        kind: 'topup',
        amount: 500000,
        stripeSessionId: 'cs_refund_test',
      };
      const doc = makeDoc({ ledger: [topupEntry], cachedBalance: 500000 });
      mockRepository.getOrCreate.mockResolvedValue(doc);
      const updatedDoc = makeDoc({ cachedBalance: 0 });
      mockRepository.refundPartial.mockResolvedValue({ doc: updatedDoc, applied: true });

      const result = await BillingExtraService.refundPartial(orgId, 'cs_refund_test', 4900, 'pack_500k', 'rf_abc001');

      // $49 / $49 * 500000 = 500000 units
      expect(result.refundUnits).toBe(500000);
      expect(result.applied).toBe(true);
      // Key uses Stripe refund ID (globally unique) — prevents collision between two partial refunds of same amount
      expect(mockRepository.refundPartial).toHaveBeenCalledWith(
        orgId,
        'cs_refund_test',
        500000,
        'refund-rf_abc001-507f1f77bcf86cd799439aaa',
      );
    });

    test('two partial refunds of identical amount on same topup → distinct ledger keys', async () => {
      // Bug scenario: before fix, both refunds would share key refund-cs-4900-topupId
      // and only the first would be applied. After fix: rf_ IDs make them distinct.
      const topupEntry = {
        _id: '507f1f77bcf86cd799439aaa',
        kind: 'topup',
        amount: 500000,
        stripeSessionId: 'cs_two_partials',
      };
      const doc = makeDoc({ ledger: [topupEntry], cachedBalance: 500000 });
      mockRepository.getOrCreate.mockResolvedValue(doc);
      mockRepository.refundPartial
        .mockResolvedValueOnce({ doc: makeDoc({ cachedBalance: 250000 }), applied: true })
        .mockResolvedValueOnce({ doc: makeDoc({ cachedBalance: 0 }), applied: true });

      const r1 = await BillingExtraService.refundPartial(orgId, 'cs_two_partials', 2450, 'pack_500k', 'rf_first');
      const r2 = await BillingExtraService.refundPartial(orgId, 'cs_two_partials', 2450, 'pack_500k', 'rf_second');

      expect(r1.applied).toBe(true);
      expect(r2.applied).toBe(true);

      const [, , , key1] = mockRepository.refundPartial.mock.calls[0];
      const [, , , key2] = mockRepository.refundPartial.mock.calls[1];
      expect(key1).toBe('refund-rf_first-507f1f77bcf86cd799439aaa');
      expect(key2).toBe('refund-rf_second-507f1f77bcf86cd799439aaa');
      expect(key1).not.toBe(key2);
    });

    test('refundPartial with already-consumed balance still applies (economic reflection)', async () => {
      // The balance is 0 (units already consumed) but a refund should still be recorded
      const topupEntry = {
        _id: '507f1f77bcf86cd799439bbb',
        kind: 'topup',
        amount: 500000,
        stripeSessionId: 'cs_consumed',
      };
      const doc = makeDoc({ ledger: [topupEntry], cachedBalance: 0 });
      mockRepository.getOrCreate.mockResolvedValue(doc);
      mockRepository.refundPartial.mockResolvedValue({ doc: makeDoc({ cachedBalance: -500000 }), applied: true });

      const result = await BillingExtraService.refundPartial(orgId, 'cs_consumed', 4900, 'pack_500k');
      // Applied (even with negative resulting balance — correct economic reflection)
      expect(result.applied).toBe(true);
    });

    test('should return invalid_org when getOrCreate returns null (malformed orgId)', async () => {
      mockRepository.getOrCreate.mockResolvedValue(null);

      const result = await BillingExtraService.refundPartial('bad-org-id', 'cs_test', 4900);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('invalid_org');
      expect(result.refundUnits).toBe(0);
    });

    test('should resolve duplicate meterUnits correctly when packId is provided', async () => {
      mockConfig.billing.packs = [
        { packId: 'pack_a', meterUnits: 500000, priceUsd: 49 },
        { packId: 'pack_b', meterUnits: 500000, priceUsd: 39 }, // promo duplicate
      ];
      const topupEntry = {
        _id: '507f1f77bcf86cd799439ccc',
        kind: 'topup',
        amount: 500000,
        stripeSessionId: 'cs_ambiguous',
      };
      const doc = makeDoc({ ledger: [topupEntry], cachedBalance: 500000 });
      mockRepository.getOrCreate.mockResolvedValue(doc);
      mockRepository.refundPartial.mockResolvedValue({ doc: makeDoc({ cachedBalance: 374359 }), applied: true });

      const result = await BillingExtraService.refundPartial(orgId, 'cs_ambiguous', 4900, 'pack_a');
      expect(result.applied).toBe(true);
      expect(result.refundUnits).toBe(500000);
      expect(mockRepository.refundPartial).toHaveBeenCalled();
    });

    test('should return applied=false with reason ambiguous_pack_match when multiple packs have same meterUnits and no packId', async () => {
      mockConfig.billing.packs = [
        { packId: 'pack_a', meterUnits: 500000, priceUsd: 49 },
        { packId: 'pack_b', meterUnits: 500000, priceUsd: 39 },
      ];
      const topupEntry = {
        _id: '507f1f77bcf86cd799439ccc',
        kind: 'topup',
        amount: 500000,
        stripeSessionId: 'cs_ambiguous',
      };
      const doc = makeDoc({ ledger: [topupEntry], cachedBalance: 500000 });
      mockRepository.getOrCreate.mockResolvedValue(doc);

      const result = await BillingExtraService.refundPartial(orgId, 'cs_ambiguous', 4900);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('ambiguous_pack_match');
      expect(result.refundUnits).toBe(0);
      expect(mockRepository.refundPartial).not.toHaveBeenCalled();
    });

    test('should return pack_not_found when packId metadata is unknown', async () => {
      const topupEntry = {
        _id: '507f1f77bcf86cd799439ddd',
        kind: 'topup',
        amount: 500000,
        stripeSessionId: 'cs_unknown_pack',
      };
      const doc = makeDoc({ ledger: [topupEntry], cachedBalance: 500000 });
      mockRepository.getOrCreate.mockResolvedValue(doc);

      const result = await BillingExtraService.refundPartial(orgId, 'cs_unknown_pack', 4900, 'pack_missing');

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('pack_not_found');
      expect(result.refundUnits).toBe(0);
      expect(mockRepository.refundPartial).not.toHaveBeenCalled();
    });

    test('legacy topup with no packId still falls back to meterUnits heuristic', async () => {
      const topupEntry = {
        _id: '507f1f77bcf86cd799439eee',
        kind: 'topup',
        amount: 2000000,
        stripeSessionId: 'cs_legacy',
      };
      const doc = makeDoc({ ledger: [topupEntry], cachedBalance: 2000000 });
      mockRepository.getOrCreate.mockResolvedValue(doc);
      mockRepository.refundPartial.mockResolvedValue({ doc: makeDoc({ cachedBalance: 1000000 }), applied: true });

      const result = await BillingExtraService.refundPartial(orgId, 'cs_legacy', 7450);

      expect(result.applied).toBe(true);
      expect(result.refundUnits).toBe(1000000);
      expect(mockRepository.refundPartial).toHaveBeenCalledWith(
        orgId,
        'cs_legacy',
        1000000,
        'refund-cs_legacy-7450-507f1f77bcf86cd799439eee',
      );
    });

    test('legacy fallback key is stable across retries (no Date.now() jitter)', async () => {
      // Without stripeRefundId, the key must be deterministic so webhook retries are idempotent
      const topupEntry = {
        _id: '507f1f77bcf86cd799439fff',
        kind: 'topup',
        amount: 500000,
        stripeSessionId: 'cs_retry',
      };
      const doc = makeDoc({ ledger: [topupEntry], cachedBalance: 500000 });
      mockRepository.getOrCreate.mockResolvedValue(doc);
      mockRepository.refundPartial
        .mockResolvedValueOnce({ doc: makeDoc({ cachedBalance: 0 }), applied: true })
        .mockResolvedValueOnce({ doc: null, applied: false }); // second call: $ne filter blocks it

      await BillingExtraService.refundPartial(orgId, 'cs_retry', 4900, 'pack_500k');
      await BillingExtraService.refundPartial(orgId, 'cs_retry', 4900, 'pack_500k');

      const [, , , key1] = mockRepository.refundPartial.mock.calls[0];
      const [, , , key2] = mockRepository.refundPartial.mock.calls[1];
      expect(key1).toBe('refund-cs_retry-4900-507f1f77bcf86cd799439fff');
      expect(key2).toBe('refund-cs_retry-4900-507f1f77bcf86cd799439fff');
      expect(key1).toBe(key2); // same key → idempotent
    });
  });
});
