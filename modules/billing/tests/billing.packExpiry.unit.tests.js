/**
 * Module dependencies.
 */
import { describe, test, expect } from '@jest/globals';

import { replayCredits, computeExpiryRemovals } from '../lib/billing.packExpiry.js';

const T0 = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;
/**
 * @param {number} d - Day offset from T0.
 * @returns {Date} T0 + d days.
 */
const day = (d) => new Date(T0 + d * DAY);

/**
 * Unit tests for the pack expiry ledger replay (per-pack attribution, earliest expiry first).
 */
describe('billing.packExpiry unit tests:', () => {
  const now = day(100);

  test('pack 100, 80 used → expiry removes 20', () => {
    const ledger = [
      { _id: 'a', kind: 'topup', amount: 100, stripeSessionId: 's-a', at: day(0), expiresAt: day(10) },
      { kind: 'debit', amount: -80, at: day(1) },
    ];
    expect(computeExpiryRemovals(ledger, now)).toEqual([{ topupId: 'a', amount: 20 }]);
  });

  test('not yet expired → nothing to remove', () => {
    const ledger = [{ _id: 'a', kind: 'topup', amount: 100, at: day(0), expiresAt: day(200) }];
    expect(computeExpiryRemovals(ledger, now)).toEqual([]);
  });

  test('earliest expiry drawn first; credits without expiry last', () => {
    const ledger = [
      { _id: 'adj', kind: 'adjustment', amount: 50, at: day(0) },
      { _id: 'late', kind: 'topup', amount: 100, at: day(0), expiresAt: day(30) },
      { _id: 'soon', kind: 'topup', amount: 40, source: 'referral', at: day(0), expiresAt: day(5) },
      { kind: 'debit', amount: -60, at: day(1) },
    ];
    const { credits, uncoveredDebt } = replayCredits(ledger);
    expect(Object.fromEntries(credits.map((c) => [c.id, c.remaining]))).toEqual({ adj: 50, soon: 0, late: 80 });
    expect(uncoveredDebt).toBe(0);
  });

  test('a debit after a pack expired does not draw from it', () => {
    const ledger = [
      { _id: 'a', kind: 'topup', amount: 100, at: day(0), expiresAt: day(10) },
      { kind: 'debit', amount: -30, at: day(11) },
    ];
    const { uncoveredDebt } = replayCredits(ledger);
    expect(uncoveredDebt).toBe(30);
    expect(computeExpiryRemovals(ledger, now)).toEqual([{ topupId: 'a', amount: 100 }]);
  });

  test('uncovered debt is repaid by the next credit before it becomes spendable', () => {
    const ledger = [
      { kind: 'debit', amount: -80, at: day(0) },
      { _id: 'a', kind: 'topup', amount: 100, stripeSessionId: 's-a', at: day(1), expiresAt: day(10) },
    ];
    expect(computeExpiryRemovals(ledger, now)).toEqual([{ topupId: 'a', amount: 20 }]);
  });

  test('refund of a pack draws from that pack first, excess drawn like a debit', () => {
    const ledger = [
      { _id: 'a', kind: 'topup', amount: 100, stripeSessionId: 's-a', at: day(0), expiresAt: day(10) },
      { _id: 'b', kind: 'topup', amount: 50, stripeSessionId: 's-b', at: day(0), expiresAt: day(20) },
      { kind: 'debit', amount: -80, at: day(1) },
      { kind: 'refund', amount: -100, stripeSessionId: 's-a', refId: 'r1', at: day(2) },
    ];
    const { credits, uncoveredDebt } = replayCredits(ledger);
    expect(Object.fromEntries(credits.map((c) => [c.id, c.remaining]))).toEqual({ a: 0, b: 0 });
    expect(uncoveredDebt).toBe(30);
  });

  test('refund without a matching pack is drawn like a debit', () => {
    const ledger = [
      { _id: 'a', kind: 'topup', amount: 100, at: day(0), expiresAt: day(10) },
      { kind: 'refund', amount: -30, at: day(1) },
    ];
    expect(computeExpiryRemovals(ledger, now)).toEqual([{ topupId: 'a', amount: 70 }]);
  });

  test('handled packs (zero marker or legacy full amount) are never listed again', () => {
    const ledger = [
      { _id: 'a', kind: 'topup', amount: 100, at: day(0), expiresAt: day(10) },
      { kind: 'debit', amount: -100, at: day(1) },
      { kind: 'expiration', amount: 0, refId: 'expire-a', at: day(11) },
      { _id: 'b', kind: 'topup', amount: 100, at: day(12), expiresAt: day(20) },
      { kind: 'expiration', amount: -100, refId: 'expire-b', at: day(21) },
    ];
    expect(computeExpiryRemovals(ledger, now)).toEqual([]);
  });

  test('legacy full-amount expiration: the part beyond the pack remainder is drawn like a debit', () => {
    const ledger = [
      { _id: 'a', kind: 'topup', amount: 100, at: day(0), expiresAt: day(10) },
      { kind: 'debit', amount: -80, at: day(1) },
      { kind: 'expiration', amount: -100, refId: 'expire-a', at: day(11) },
      { _id: 'b', kind: 'topup', amount: 100, at: day(12), expiresAt: day(20) },
    ];
    // Balance after: 100 − 80 − 100 + 100 = 20 → the new pack keeps 20 of its own units.
    expect(computeExpiryRemovals(ledger, now)).toEqual([{ topupId: 'b', amount: 20 }]);
  });

  test('tolerates entries without at/amount and unknown expiration refs', () => {
    const ledger = [
      { _id: 'a', kind: 'topup', amount: 10, expiresAt: day(10) },
      { kind: 'debit' },
      { kind: 'expiration', amount: -5, refId: 'other' },
    ];
    expect(computeExpiryRemovals(ledger, now)).toEqual([{ topupId: 'a', amount: 5 }]);
  });
});
