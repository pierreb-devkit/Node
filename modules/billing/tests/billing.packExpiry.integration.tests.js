/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, beforeEach, afterAll, test, expect } from '@jest/globals';

import mongooseService from '../../../lib/services/mongoose.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Integration tests for the extras expiry sweep (addExpirationEntries) against a real
 * database: an expiring pack removes only its OWN unspent units at its expiry, fully
 * spent packs get a zero marker, and the sweep stays idempotent under concurrency.
 */
describe('BillingExtraBalance pack expiry integration tests:', () => {
  let BillingExtraBalance;
  let Repository;
  let orgId;
  let now;

  /**
   * @param {number} d - Day offset from now (negative = past).
   * @returns {Date} now + d days.
   */
  const day = (d) => new Date(now.getTime() + d * DAY);

  /**
   * Seed an extras doc whose cached balance is the sum of the given entries.
   * @param {Object[]} ledger - Ledger entries.
   * @returns {Promise<void>}
   */
  const seed = async (ledger) => {
    await BillingExtraBalance.create({
      organization: orgId,
      ledger,
      cachedBalance: ledger.reduce((sum, e) => sum + e.amount, 0),
    });
  };

  /**
   * @returns {Promise<{balance: number, expirations: Object[], ledgerSum: number}>}
   */
  const state = async () => {
    const doc = await BillingExtraBalance.findOne({ organization: orgId }).lean();
    return {
      balance: doc.cachedBalance,
      expirations: doc.ledger.filter((e) => e.kind === 'expiration'),
      ledgerSum: doc.ledger.reduce((sum, e) => sum + e.amount, 0),
    };
  };

  beforeAll(async () => {
    await mongooseService.loadModels();
    await mongooseService.connect();
    BillingExtraBalance = mongoose.model('BillingExtraBalance');
    Repository = (await import('../repositories/billing.extraBalance.repository.js')).default;
  });

  beforeEach(async () => {
    orgId = new mongoose.Types.ObjectId().toString();
    now = new Date();
  });

  afterAll(async () => {
    await BillingExtraBalance.deleteMany({});
    await mongooseService.disconnect();
  });

  test('pack 100, 80 used → removes 20, balance 0', async () => {
    const a = new mongoose.Types.ObjectId();
    await seed([
      { _id: a, kind: 'topup', amount: 100, stripeSessionId: 'cs_a', at: day(-10), expiresAt: day(-1) },
      { kind: 'debit', amount: -80, refId: 'run-1', at: day(-5) },
    ]);
    await expect(Repository.addExpirationEntries(orgId, now)).resolves.toBe(1);
    const s = await state();
    expect(s.expirations).toEqual([expect.objectContaining({ refId: `expire-${a}`, amount: -20 })]);
    expect(s.balance).toBe(0);
    expect(s.ledgerSum).toBe(0);
  });

  test('fully used pack → zero marker, a later new pack untouched by it', async () => {
    const a = new mongoose.Types.ObjectId();
    await seed([
      { _id: a, kind: 'topup', amount: 100, stripeSessionId: 'cs_a', at: day(-10), expiresAt: day(-3) },
      { kind: 'debit', amount: -100, refId: 'run-1', at: day(-5) },
    ]);
    await expect(Repository.addExpirationEntries(orgId, now)).resolves.toBe(1);
    expect((await state()).expirations).toEqual([expect.objectContaining({ refId: `expire-${a}`, amount: 0 })]);

    await Repository.creditPack(orgId, 50, 'cs_b', day(30));
    await expect(Repository.addExpirationEntries(orgId, now)).resolves.toBe(0);
    expect(await Repository.findOrgsWithExpiringTopups(now)).not.toContain(orgId);
    expect((await state()).balance).toBe(50);

    // The zero marker is internal: the customer ledger view never shows it.
    const page = await Repository.listLedgerPage(orgId, 0, 10);
    expect(page.total).toBe(3);
    expect(page.ledgerPage.some((e) => e.kind === 'expiration')).toBe(false);
  });

  test('pack A expires after pack B was bought (both live) → only A\'s unspent removed', async () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    await seed([
      { _id: a, kind: 'topup', amount: 100, stripeSessionId: 'cs_a', at: day(-20), expiresAt: day(-1) },
      { _id: b, kind: 'topup', amount: 100, stripeSessionId: 'cs_b', at: day(-10), expiresAt: day(20) },
      // Drawn from A first (earliest expiry).
      { kind: 'debit', amount: -60, refId: 'run-1', at: day(-5) },
    ]);
    await expect(Repository.addExpirationEntries(orgId, now)).resolves.toBe(1);
    const s = await state();
    expect(s.expirations).toEqual([expect.objectContaining({ refId: `expire-${a}`, amount: -40 })]);
    expect(s.balance).toBe(100);
  });

  test('referral grant with a shorter expiry is consumed first', async () => {
    const pack = new mongoose.Types.ObjectId();
    const grant = new mongoose.Types.ObjectId();
    await seed([
      { _id: pack, kind: 'topup', amount: 100, stripeSessionId: 'cs_a', at: day(-20), expiresAt: day(-1) },
      { _id: grant, kind: 'topup', amount: 30, source: 'referral', refId: 'referral:x:referee', at: day(-10), expiresAt: day(-2) },
      { kind: 'debit', amount: -50, refId: 'run-1', at: day(-5) },
    ]);
    await expect(Repository.addExpirationEntries(orgId, now)).resolves.toBe(2);
    const s = await state();
    const byRef = Object.fromEntries(s.expirations.map((e) => [e.refId, e.amount]));
    expect(byRef).toEqual({ [`expire-${grant}`]: 0, [`expire-${pack}`]: -80 });
    expect(s.balance).toBe(0);
  });

  test('refunded pack then expiry → no double removal', async () => {
    const a = new mongoose.Types.ObjectId();
    await seed([{ _id: a, kind: 'topup', amount: 100, stripeSessionId: 'cs_a', at: day(-10), expiresAt: day(-1) }]);
    await Repository.refundPartial(orgId, 'cs_a', 40, 'refund-re_1');
    await expect(Repository.addExpirationEntries(orgId, now)).resolves.toBe(1);
    const s = await state();
    expect(s.expirations).toEqual([expect.objectContaining({ amount: -60 })]);
    expect(s.balance).toBe(0);
  });

  test('units credited after expiresAt but before the sweep are untouched', async () => {
    const a = new mongoose.Types.ObjectId();
    await seed([
      { _id: a, kind: 'topup', amount: 100, stripeSessionId: 'cs_a', at: day(-10), expiresAt: day(-3) },
      { kind: 'debit', amount: -90, refId: 'run-1', at: day(-5) },
    ]);
    // New units arrive after A's expiry, before the daily sweep runs.
    await Repository.creditPack(orgId, 200, 'cs_b', day(30));
    await Repository.creditGrant(orgId, 25, 'referral', { refId: 'referral:y:referrer' });
    await expect(Repository.addExpirationEntries(orgId, now)).resolves.toBe(1);
    const s = await state();
    expect(s.expirations).toEqual([expect.objectContaining({ refId: `expire-${a}`, amount: -10 })]);
    expect(s.balance).toBe(225);
  });

  test('repeated and concurrent sweeps → exactly one entry per pack', async () => {
    const a = new mongoose.Types.ObjectId();
    await seed([
      { _id: a, kind: 'topup', amount: 100, stripeSessionId: 'cs_a', at: day(-10), expiresAt: day(-1) },
      { kind: 'debit', amount: -30, refId: 'run-1', at: day(-5) },
    ]);
    const results = await Promise.all(Array.from({ length: 6 }, () => Repository.addExpirationEntries(orgId, now)));
    expect(results.reduce((sum, n) => sum + n, 0)).toBe(1);
    await expect(Repository.addExpirationEntries(orgId, now)).resolves.toBe(0);
    const s = await state();
    expect(s.expirations).toHaveLength(1);
    expect(s.balance).toBe(0);
    expect(s.ledgerSum).toBe(s.balance);
  });

  test('sweep concurrent with debits → balance stays equal to the ledger sum', async () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    await seed([
      { _id: a, kind: 'topup', amount: 100, stripeSessionId: 'cs_a', at: day(-10), expiresAt: day(-1) },
      { _id: b, kind: 'topup', amount: 100, stripeSessionId: 'cs_b', at: day(-10), expiresAt: day(30) },
      { kind: 'debit', amount: -20, refId: 'run-0', at: day(-5) },
    ]);
    await Promise.all([
      Repository.addExpirationEntries(orgId, now),
      Repository.debit(orgId, 10, 'run-1'),
      Repository.debit(orgId, 10, 'run-2'),
    ]);
    const s = await state();
    // A expired with 80 unspent; the later debits draw from B only.
    expect(s.expirations).toEqual([expect.objectContaining({ refId: `expire-${a}`, amount: -80 })]);
    expect(s.balance).toBe(80);
    expect(s.ledgerSum).toBe(s.balance);
  });
});
