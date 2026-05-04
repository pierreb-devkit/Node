/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for BillingExtraService.refundPartial integer-cents math (Item 7 of billing
 * webhook hardening). Kept in a dedicated file to avoid Jest ESM mock cross-contamination:
 * other describe blocks that mock '../services/billing.extra.service.js' as a stub would
 * prevent this file from loading the real implementation.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Item 7 — Integer-cents refund math (no floating-point drift)
// ─────────────────────────────────────────────────────────────────────────────
describe('BillingExtraService.refundPartial — integer-cents math:', () => {
  let BillingExtraService;
  let mockRepository;
  let mockConfig;

  const orgId = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        meterMode: true,
        packs: [
          { packId: 'pack_500k', meterUnits: 500000, priceUsd: 49 },
        ],
      },
    };

    mockRepository = {
      getOrCreate: jest.fn(),
      refundPartial: jest.fn().mockResolvedValue({ doc: {}, applied: true }),
      getBalance: jest.fn(),
      creditPack: jest.fn(),
      debit: jest.fn(),
      addExpirationEntries: jest.fn(),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({ default: mockRepository }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: { info: jest.fn(), error: jest.fn() } }));
    jest.unstable_mockModule('../lib/events.js', () => ({ default: { emit: jest.fn() } }));

    const mod = await import('../services/billing.extra.service.js');
    BillingExtraService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Full refund: 4900 cents / 4900 cents * 500000 units = 500000 units
   * Integer-cents: round((4900 * 500000) / round(49 * 100)) = round(2450000000 / 4900) = 500000
   */
  test('full refund 4900 cents → 500000 units (no fp drift)', async () => {
    mockRepository.getOrCreate.mockResolvedValue({
      _id: 'doc1',
      ledger: [{ kind: 'topup', stripeSessionId: 'cs_test', amount: 500000, _id: 'le1' }],
    });

    await BillingExtraService.refundPartial(orgId, 'cs_test', 4900, 'pack_500k', 'rf_test');

    const refundUnitsArg = mockRepository.refundPartial.mock.calls[0][2];
    expect(refundUnitsArg).toBe(500000);
  });

  /**
   * Partial refund: 2450 cents / 4900 cents * 500000 units = 250000 units
   * Integer-cents: round((2450 * 500000) / round(49 * 100)) = round(1225000000 / 4900) = 250000
   */
  test('50% refund 2450 cents → 250000 units (exact half)', async () => {
    mockRepository.getOrCreate.mockResolvedValue({
      _id: 'doc1',
      ledger: [{ kind: 'topup', stripeSessionId: 'cs_test', amount: 500000, _id: 'le1' }],
    });

    await BillingExtraService.refundPartial(orgId, 'cs_test', 2450, 'pack_500k', 'rf_partial');

    const refundUnitsArg = mockRepository.refundPartial.mock.calls[0][2];
    expect(refundUnitsArg).toBe(250000);
  });

  /**
   * Test floating-point correctness: 4900 / 100 / 49 = 0.9999999999999998 in float
   * Integer-cents formula avoids this: (4900 * 500000) / (49 * 100) = exactly 500000
   */
  test('avoids floating-point drift: 4900 cents / $49.00 → exactly 500000 (not 499999)', async () => {
    mockRepository.getOrCreate.mockResolvedValue({
      _id: 'doc1',
      ledger: [{ kind: 'topup', stripeSessionId: 'cs_full', amount: 500000, _id: 'le2' }],
    });

    await BillingExtraService.refundPartial(orgId, 'cs_full', 4900, 'pack_500k', 'rf_fp_test');

    const refundUnitsArg = mockRepository.refundPartial.mock.calls[0][2];
    // Floating-point formula: Math.round((4900 / 100 / 49) * 500000) may give 499999 on some engines
    // Integer-cents formula must give exactly 500000
    expect(refundUnitsArg).toBe(500000);
  });
});
