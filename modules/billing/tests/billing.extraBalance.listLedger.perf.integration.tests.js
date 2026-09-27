/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { jest, describe, beforeAll, beforeEach, afterAll, afterEach, test, expect } from '@jest/globals';

import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests for BillingExtraBalanceRepository.listLedgerPage on a large ledger.
 *
 * Guards the paging design: page 1 of a 1000-entry ledger must come from a single
 * aggregation that slices server-side, never from reading the whole document. This used
 * to be a wall-clock bound (`< 50ms`), which flaked on shared CI runners and could not
 * tell the two designs apart at this ledger size anyway.
 */
describe('BillingExtraBalanceRepository.listLedgerPage performance integration tests:', () => {
  let BillingExtraBalanceRepository;
  let BillingExtraBalance;

  const orgId = new mongoose.Types.ObjectId();


  beforeAll(async () => {
    await mongooseService.loadModels();
    await mongooseService.connect();
    BillingExtraBalance = mongoose.model('BillingExtraBalance');
    BillingExtraBalanceRepository = (await import('../repositories/billing.extraBalance.repository.js')).default;
  });

  beforeEach(async () => {
    await BillingExtraBalance.deleteMany({ organization: orgId });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await mongooseService.disconnect();
  });

  test('listLedgerPage: pages a large ledger server-side (one aggregate, no full-document read)', async () => {
    const PAGE_SIZE = 20;
    const LARGE_LEDGER_SIZE = 1000;

    await BillingExtraBalance.create({
      organization: orgId,
      ledger: Array.from({ length: LARGE_LEDGER_SIZE }, (_, i) => ({
        kind: 'topup',
        amount: 1000,
        stripeSessionId: `cs_perf_${i}`,
        at: new Date(Date.now() - i * 1000),
      })),
      cachedBalance: 1000000,
      cachedBalanceAt: new Date(),
    });

    // Design guard, not a stopwatch: at this ledger size a full-document read costs about
    // the same wall-clock time as the aggregation, so a timing bound cannot tell the two
    // apart (and flakes on shared runners). Assert the paging path directly instead.
    const aggregateSpy = jest.spyOn(BillingExtraBalance, 'aggregate');
    const findOneSpy = jest.spyOn(BillingExtraBalance, 'findOne');
    const findSpy = jest.spyOn(BillingExtraBalance, 'find');

    const result = await BillingExtraBalanceRepository.listLedgerPage(String(orgId), 0, PAGE_SIZE);

    expect(aggregateSpy).toHaveBeenCalledTimes(1);
    expect(findOneSpy).not.toHaveBeenCalled();
    expect(findSpy).not.toHaveBeenCalled();
    // The page is cut inside the pipeline: its last stage slices the sorted ledger.
    const pipeline = aggregateSpy.mock.calls[0][0];
    expect(JSON.stringify(pipeline[pipeline.length - 1])).toContain('$slice');

    // Correctness
    expect(result.total).toBe(LARGE_LEDGER_SIZE);
    expect(result.ledgerPage).toHaveLength(PAGE_SIZE);
    expect(result.cachedBalance).toBe(1000000);
    const firstAt = new Date(result.ledgerPage[0].at).getTime();
    const secondAt = new Date(result.ledgerPage[1].at).getTime();
    expect(firstAt).toBeGreaterThanOrEqual(secondAt);
  });

  test('listLedgerPage: returns null for a valid but non-existent org', async () => {
    const unknownOrgId = new mongoose.Types.ObjectId();
    const result = await BillingExtraBalanceRepository.listLedgerPage(String(unknownOrgId), 0, 20);
    expect(result).toBeNull();
  });

  test('listLedgerPage: returns null for an invalid orgId', async () => {
    const result = await BillingExtraBalanceRepository.listLedgerPage('not-an-object-id', 0, 20);
    expect(result).toBeNull();
  });

  test('listLedgerPage: returns empty ledgerPage (not [null]) for org with empty ledger', async () => {
    // Regression guard: $unwind preserveNullAndEmptyArrays emits a null sentinel when the
    // ledger array is empty. Without the $filter guard, ledgerPage would be [null] instead of [].
    await BillingExtraBalance.create({
      organization: orgId,
      ledger: [],
      cachedBalance: 0,
      cachedBalanceAt: new Date(),
    });

    const result = await BillingExtraBalanceRepository.listLedgerPage(String(orgId), 0, 20);

    expect(result).not.toBeNull();
    expect(result.total).toBe(0);
    expect(result.ledgerPage).toEqual([]);
  });

  test('listLedgerPage: page 2 returns the correct slice (skip=20, limit=20)', async () => {
    const now = Date.now();
    const ledger = Array.from({ length: 50 }, (_, i) => ({
      kind: 'topup',
      amount: i + 1,
      stripeSessionId: `cs_page_${i}`,
      at: new Date(now - i * 1000),
    }));

    await BillingExtraBalance.create({
      organization: orgId,
      ledger,
      cachedBalance: 0,
      cachedBalanceAt: new Date(),
    });

    const result = await BillingExtraBalanceRepository.listLedgerPage(String(orgId), 20, 20);

    expect(result).not.toBeNull();
    expect(result.total).toBe(50);
    expect(result.ledgerPage).toHaveLength(20);
    // Page 2 entries should be older than page 1 entries (entries 20-39 by descending date)
    const pageFirstAt = new Date(result.ledgerPage[0].at).getTime();
    expect(pageFirstAt).toBeLessThanOrEqual(now - 20 * 1000 + 100); // within tolerance
  });
});
