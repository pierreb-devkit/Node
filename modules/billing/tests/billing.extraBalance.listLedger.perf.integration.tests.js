/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, beforeEach, afterAll, test, expect } from '@jest/globals';

import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Performance integration tests for BillingExtraBalanceRepository.listLedgerPage.
 *
 * Asserts that fetching page 1 of a large ledger does not scale with ledger size —
 * confirming that only the requested page is transferred over the wire, not the full
 * document. The guard is a relative bound (large-ledger fetch vs small-ledger fetch),
 * not a hardcoded wall-clock number: an absolute `< 50ms` assertion flakes on shared
 * CI runners under load, where every query gets slower but the *ratio* between a
 * large-ledger fetch and a small-ledger fetch stays roughly constant.
 */
describe('BillingExtraBalanceRepository.listLedgerPage performance integration tests:', () => {
  let BillingExtraBalanceRepository;
  let BillingExtraBalance;

  const orgId = new mongoose.Types.ObjectId();
  const smallOrgId = new mongoose.Types.ObjectId();

  // Sort ascending and pick the middle value(s) — resilient to a single slow/fast outlier run.
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };

  beforeAll(async () => {
    await mongooseService.loadModels();
    await mongooseService.connect();
    BillingExtraBalance = mongoose.model('BillingExtraBalance');
    BillingExtraBalanceRepository = (await import('../repositories/billing.extraBalance.repository.js')).default;
  });

  beforeEach(async () => {
    await BillingExtraBalance.deleteMany({ organization: { $in: [orgId, smallOrgId] } });
  });

  afterAll(async () => {
    await mongooseService.disconnect();
  });

  test('listLedgerPage: fetching page 1 of a large ledger does not scale with ledger size (relative bound)', async () => {
    const PAGE_SIZE = 20;
    const LARGE_LEDGER_SIZE = 1000;
    const RUNS = 5;

    const buildLedger = (size) =>
      Array.from({ length: size }, (_, i) => ({
        kind: 'topup',
        amount: 1000,
        stripeSessionId: `cs_perf_${size}_${i}`,
        at: new Date(Date.now() - i * 1000),
      }));

    // Large ledger under test, plus a same-page-size baseline ledger (one page's worth of
    // entries) so the only variable between the two fetches is ledger size, not page size.
    await BillingExtraBalance.create({
      organization: orgId,
      ledger: buildLedger(LARGE_LEDGER_SIZE),
      cachedBalance: 1000000,
      cachedBalanceAt: new Date(),
    });
    await BillingExtraBalance.create({
      organization: smallOrgId,
      ledger: buildLedger(PAGE_SIZE),
      cachedBalance: 1000000,
      cachedBalanceAt: new Date(),
    });

    const timeFetch = async (id) => {
      const start = performance.now();
      const result = await BillingExtraBalanceRepository.listLedgerPage(String(id), 0, PAGE_SIZE);
      return { elapsed: performance.now() - start, result };
    };

    // Warm up each connection/query plan once before measuring — the first aggregate on a
    // fresh connection is not representative and would skew the first timed run.
    await timeFetch(orgId);
    await timeFetch(smallOrgId);

    const largeTimes = [];
    const smallTimes = [];
    let sample;
    for (let i = 0; i < RUNS; i += 1) {
      const large = await timeFetch(orgId);
      largeTimes.push(large.elapsed);
      sample = large.result;
      const small = await timeFetch(smallOrgId);
      smallTimes.push(small.elapsed);
    }

    // Correctness (kept from the original assertion, checked on one of the large-ledger runs)
    expect(sample).not.toBeNull();
    expect(sample.total).toBe(LARGE_LEDGER_SIZE);
    expect(sample.ledgerPage).toHaveLength(PAGE_SIZE);
    expect(sample.cachedBalance).toBe(1000000);

    // Entries should be sorted descending by `at` (newest first)
    const firstAt = new Date(sample.ledgerPage[0].at).getTime();
    const secondAt = new Date(sample.ledgerPage[1].at).getTime();
    expect(firstAt).toBeGreaterThanOrEqual(secondAt);

    // Performance gate: page 1 of a 1000-entry ledger must not scale with ledger size.
    // Compared against the median of several page-1 fetches from a ledger that is exactly
    // one page long, rather than a hardcoded wall-clock number, so the guard survives a busy
    // shared runner (both fetches slow down together, but their ratio stays roughly constant).
    // RATIO_MARGIN is deliberately generous — the aggregation does sort the full ledger
    // server-side before slicing, so some growth with ledger size is expected; this only
    // needs to catch a real regression (e.g. reverting to fetching the whole document and
    // slicing in JS), not runner jitter. Math.max(..., 1) floors the denominator so a
    // sub-millisecond baseline on a fast local Mongo can't blow up the ratio.
    const RATIO_MARGIN = 10;
    const largeMedian = median(largeTimes);
    const smallMedian = median(smallTimes);
    expect(largeMedian / Math.max(smallMedian, 1)).toBeLessThan(RATIO_MARGIN);
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
