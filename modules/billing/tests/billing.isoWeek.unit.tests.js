/**
 * Module dependencies.
 */
import { describe, test, expect } from '@jest/globals';
import { currentWeekKey, isoWeekKey } from '../lib/billing.isoWeek.js';

/**
 * @function referenceIsoWeekKey
 * @description Independent ISO week implementation used for randomized regression checks.
 * @param {Date} date - Date to compute.
 * @returns {string} ISO week key.
 */
const referenceIsoWeekKey = (date) => {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const year = utc.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDay = firstThursday.getUTCDay() || 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstDay);
  const week = 1 + Math.round((utc - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${year}-W${String(week).padStart(2, '0')}`;
};

describe('billing.isoWeek unit tests:', () => {
  test('handles year rollover and leap-year edge cases', () => {
    expect(isoWeekKey(new Date('2020-12-31T12:00:00.000Z'))).toBe('2020-W53');
    expect(isoWeekKey(new Date('2021-01-01T12:00:00.000Z'))).toBe('2020-W53');
    expect(isoWeekKey(new Date('2021-01-04T12:00:00.000Z'))).toBe('2021-W01');
    expect(isoWeekKey(new Date('2024-02-29T12:00:00.000Z'))).toBe('2024-W09');
  });

  test('handles Europe/Paris DST transition dates', () => {
    expect(isoWeekKey(new Date('2026-03-29T12:00:00+02:00'))).toBe('2026-W13');
    expect(isoWeekKey(new Date('2026-10-25T12:00:00+01:00'))).toBe('2026-W43');
  });

  test('matches reference implementation for 100 deterministic random dates', () => {
    let seed = 1777791760;
    for (let i = 0; i < 100; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const timestamp = Date.UTC(1995, 0, 1) + (seed % (45 * 366 * 24 * 60 * 60 * 1000));
      const date = new Date(timestamp);
      expect(isoWeekKey(date)).toBe(referenceIsoWeekKey(date));
    }
  });

  test('currentWeekKey returns an ISO week key', () => {
    expect(currentWeekKey()).toMatch(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/);
  });
});
