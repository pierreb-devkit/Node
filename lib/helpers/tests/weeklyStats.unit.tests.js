/**
 * Module dependencies.
 */
import { WEEK_MS, weeklyWindowStart, weeklyCountPipeline, fillWeeks } from '../weeklyStats.js';

describe('weeklyStats helper unit tests:', () => {
  test('weeklyWindowStart returns the Monday 00:00 UTC of the first week of the window', () => {
    // Wednesday 2026-11-18 15:30 UTC → current week starts Monday 2026-11-16
    const start = weeklyWindowStart(12, new Date('2026-11-18T15:30:00Z'));
    expect(start.toISOString()).toBe(new Date(Date.UTC(2026, 10, 16) - 11 * WEEK_MS).toISOString());
    expect(start.getUTCDay()).toBe(1);
  });

  test('weeklyWindowStart treats Sunday as the last day of the week', () => {
    const start = weeklyWindowStart(1, new Date('2026-11-22T23:59:00Z'));
    expect(start.toISOString()).toBe('2026-11-16T00:00:00.000Z');
  });

  test('weeklyCountPipeline matches the window and groups by week index', () => {
    const start = new Date('2026-08-31T00:00:00Z');
    const pipeline = weeklyCountPipeline(start);
    expect(pipeline[0]).toEqual({ $match: { createdAt: { $gte: start } } });
    expect(pipeline[1].$group.count).toEqual({ $sum: 1 });
  });

  test('fillWeeks zero-fills missing weeks and labels each week by its Monday', () => {
    const start = new Date('2026-08-31T00:00:00Z');
    const series = fillWeeks([{ _id: 0, count: 2 }, { _id: 2, count: 5 }], start, 3);
    expect(series).toEqual([
      { week: '2026-08-31', count: 2 },
      { week: '2026-09-07', count: 0 },
      { week: '2026-09-14', count: 5 },
    ]);
  });

  test('fillWeeks handles an empty or missing result', () => {
    expect(fillWeeks(undefined, new Date('2026-08-31T00:00:00Z'), 2)).toEqual([
      { week: '2026-08-31', count: 0 },
      { week: '2026-09-07', count: 0 },
    ]);
  });
});
