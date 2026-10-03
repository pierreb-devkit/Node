/**
 * Module dependencies.
 */
import { describe, test, expect } from '@jest/globals';

import { utcMidnight, stepCreatedAtRange, buildStepFilter } from '../utils/emailSequencesCron.js';

/**
 * Unit tests — modules/users/utils/emailSequencesCron.js (#4163).
 *
 * The cron script itself (users.emailSequences.js) is a top-level-await CLI
 * entry point that connects to MongoDB and calls process.exit — same as
 * billing's cron scripts — so the day-boundary math and the Mongo filter it
 * drives are tested here as plain functions instead.
 */
describe('utcMidnight:', () => {
  test('truncates to UTC midnight of the same calendar day', () => {
    const result = utcMidnight(new Date('2026-10-10T15:42:07.123Z'));
    expect(result.toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });

  test('is idempotent on an already-midnight Date', () => {
    const result = utcMidnight(new Date('2026-01-01T00:00:00.000Z'));
    expect(result.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('stepCreatedAtRange — day matching (UTC boundaries):', () => {
  const startAt = new Date('2020-01-01T00:00:00.000Z'); // far in the past — never the binding constraint here

  test('day 7: range is the single UTC calendar day exactly 7 days before "now", any time of day', () => {
    const now = new Date('2026-10-10T23:59:59.999Z');
    const range = stepCreatedAtRange({ now, day: 7, startAt });
    expect(range.gte.toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(range.lt.toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });

  test('day 0: range is "now"\'s own UTC calendar day', () => {
    const now = new Date('2026-10-10T08:00:00.000Z');
    const range = stepCreatedAtRange({ now, day: 0, startAt });
    expect(range.gte.toISOString()).toBe('2026-10-10T00:00:00.000Z');
    expect(range.lt.toISOString()).toBe('2026-10-11T00:00:00.000Z');
  });

  test('createdAt at the exact gte boundary falls inside the range (matches)', () => {
    const now = new Date('2026-10-10T12:00:00.000Z');
    const { gte, lt } = stepCreatedAtRange({ now, day: 7, startAt });
    const createdAt = gte;
    expect(createdAt >= gte && createdAt < lt).toBe(true);
  });

  test('createdAt at the exact lt boundary falls OUTSIDE the range (one day too young — that is day 6, not day 7)', () => {
    const now = new Date('2026-10-10T12:00:00.000Z');
    const { gte, lt } = stepCreatedAtRange({ now, day: 7, startAt });
    const createdAt = lt;
    expect(createdAt >= gte && createdAt < lt).toBe(false);
  });

  test('a user created one millisecond before "now"\'s midnight, checked right after midnight, is day 0 (not day 1)', () => {
    // Guards against elapsed-ms math: 23:59:59.999 to 00:00:00.000 is 1ms elapsed,
    // but both timestamps are within the same UTC calendar day's range for day:0
    // only if "now" is still on the signup day — here "now" has rolled to the next
    // day, so day:0's range no longer covers it; day:1 is the correct match instead.
    const createdAt = new Date('2026-10-10T23:59:59.999Z');
    const now = new Date('2026-10-11T00:00:00.000Z');
    const day0 = stepCreatedAtRange({ now, day: 0, startAt });
    const day1 = stepCreatedAtRange({ now, day: 1, startAt });
    expect(createdAt >= day0.gte && createdAt < day0.lt).toBe(false);
    expect(createdAt >= day1.gte && createdAt < day1.lt).toBe(true);
  });

  test('throws TypeError for a non-integer day', () => {
    expect(() => stepCreatedAtRange({ now: new Date(), day: 7.5, startAt })).toThrow(TypeError);
    expect(() => stepCreatedAtRange({ now: new Date(), day: -1, startAt })).toThrow(TypeError);
    expect(() => stepCreatedAtRange({ now: new Date(), day: undefined, startAt })).toThrow(TypeError);
    expect(() => stepCreatedAtRange({ now: new Date(), day: NaN, startAt })).toThrow(TypeError);
  });

  test('throws TypeError for an invalid now/startAt', () => {
    expect(() => stepCreatedAtRange({ now: new Date('not-a-date'), day: 7, startAt })).toThrow(TypeError);
    expect(() => stepCreatedAtRange({ now: new Date(), day: 7, startAt: new Date('not-a-date') })).toThrow(TypeError);
  });
});

describe('stepCreatedAtRange — startAt cutoff:', () => {
  test('clamps gte to startAt when the day range would otherwise start earlier', () => {
    const now = new Date('2026-10-10T00:00:00.000Z');
    // day:7's unclamped range is [Oct 3 00:00, Oct 4 00:00) — startAt lands mid-day, inside it.
    const startAt = new Date('2026-10-03T12:00:00.000Z');
    const range = stepCreatedAtRange({ now, day: 7, startAt });
    expect(range.gte).toEqual(startAt);
    expect(range.lt.toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });

  test('returns null when the whole day range predates startAt — no one can ever match', () => {
    const now = new Date('2026-10-10T00:00:00.000Z');
    const startAt = new Date('2026-10-09T00:00:00.000Z'); // sequence declared well after day:7's calendar day
    const range = stepCreatedAtRange({ now, day: 7, startAt });
    expect(range).toBeNull();
  });

  test('returns null when startAt falls exactly on the range\'s lt boundary (clampedGte == lt, no overlap left)', () => {
    const now = new Date('2026-10-10T00:00:00.000Z');
    // day:7 range is [Oct 3, Oct 4). startAt == Oct 4 (the range's lt) means clampedGte (Oct4) >= lt (Oct4) -> null.
    const startAt = new Date('2026-10-04T00:00:00.000Z');
    const range = stepCreatedAtRange({ now, day: 7, startAt });
    expect(range).toBeNull();
  });
});

describe('buildStepFilter — opted-out / unverified exclusion:', () => {
  test('builds a filter requiring emailVerified true and the kind not explicitly opted out', () => {
    const gte = new Date('2026-10-03T00:00:00.000Z');
    const lt = new Date('2026-10-04T00:00:00.000Z');
    const filter = buildStepFilter({ kind: 'onboarding', gte, lt });

    expect(filter).toEqual({
      createdAt: { $gte: gte, $lt: lt },
      emailVerified: true,
      'emailPreferences.onboarding': { $ne: false },
    });
  });

  test('keys the opt-out field on the given kind, not a hardcoded one', () => {
    const gte = new Date('2026-10-03T00:00:00.000Z');
    const lt = new Date('2026-10-04T00:00:00.000Z');
    const filter = buildStepFilter({ kind: 'news', gte, lt });

    expect(filter['emailPreferences.news']).toEqual({ $ne: false });
    expect(filter['emailPreferences.onboarding']).toBeUndefined();
  });
});
