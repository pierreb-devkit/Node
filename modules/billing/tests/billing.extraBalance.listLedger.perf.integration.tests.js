/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, beforeEach, afterAll, test, expect } from '@jest/globals';

import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Performance integration tests for BillingExtraBalanceRepository.listLedgerPage.
 *
 * Asserts that `listLedger` fetches a page from a 1000-entry ledger in < 50ms
 * when using the aggregation $slice path — confirming that only the requested
 * page is transferred over the wire, not the full document.
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

  afterAll(async () => {
    await mongooseService.disconnect();
  });

  test('listLedgerPage: fetching page 1 of a 1000-entry ledger takes < 50ms', async () => {
    // Seed a document with 1000 ledger entries
    const ledger = Array.from({ length: 1000 }, (_, i) => ({
      kind: 'topup',
      amount: 1000,
      stripeSessionId: `cs_perf_${i}`,
      at: new Date(Date.now() - i * 1000),
    }));

    await BillingExtraBalance.create({
      organization: orgId,
      ledger,
      cachedBalance: 1000000,
      cachedBalanceAt: new Date(),
    });

    const start = performance.now();
    const result = await BillingExtraBalanceRepository.listLedgerPage(String(orgId), 0, 20);
    const elapsed = performance.now() - start;

    expect(result).not.toBeNull();
    expect(result.total).toBe(1000);
    expect(result.ledgerPage).toHaveLength(20);
    expect(result.cachedBalance).toBe(1000000);

    // Entries should be sorted descending by `at` (newest first)
    const firstAt = new Date(result.ledgerPage[0].at).getTime();
    const secondAt = new Date(result.ledgerPage[1].at).getTime();
    expect(firstAt).toBeGreaterThanOrEqual(secondAt);

    // Performance gate: < 50ms for a 1000-entry ledger page fetch
    expect(elapsed).toBeLessThan(50);
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
