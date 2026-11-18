/**
 * Weekly count helpers for admin stats endpoints.
 *
 * A series covers the last `weeks` calendar weeks (Monday 00:00 UTC), the
 * current week included. Records are bucketed by `createdAt`, so a series only
 * counts records that still exist (a deleted record leaves its week).
 */

/** One week in milliseconds. */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Default number of weeks in an admin series. */
export const DEFAULT_WEEKS = 12;

/**
 * @desc Start of the series window: Monday 00:00 UTC, `weeks - 1` weeks before the current week.
 * @param {number} [weeks] - number of weeks in the series
 * @param {Date} [now] - reference date (defaults to now)
 * @returns {Date} window start
 */
export const weeklyWindowStart = (weeks = DEFAULT_WEEKS, now = new Date()) => {
  const day = (now.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day);
  return new Date(monday - (weeks - 1) * WEEK_MS);
};

/**
 * @desc Aggregation pipeline counting documents per week since `start` (bucket 0 = first week).
 *       Uses plain arithmetic operators so it runs on every supported MongoDB version.
 * @param {Date} start - window start from weeklyWindowStart
 * @returns {Array<Object>} pipeline producing `{ _id: weekIndex, count }`
 */
export const weeklyCountPipeline = (start) => [
  { $match: { createdAt: { $gte: start } } },
  {
    $group: {
      _id: { $floor: { $divide: [{ $subtract: ['$createdAt', start] }, WEEK_MS] } },
      count: { $sum: 1 },
    },
  },
];

/**
 * @desc Turn sparse aggregation rows into a full series, one entry per week, zero-filled.
 * @param {Array<{_id: number, count: number}>} rows - weeklyCountPipeline output
 * @param {Date} start - window start used for the pipeline
 * @param {number} [weeks] - number of weeks in the series
 * @returns {Array<{week: string, count: number}>} series, `week` = Monday as YYYY-MM-DD
 */
export const fillWeeks = (rows, start, weeks = DEFAULT_WEEKS) => {
  const byIndex = new Map((rows || []).map((r) => [Number(r._id), r.count]));
  return Array.from({ length: weeks }, (_, i) => ({
    week: new Date(start.getTime() + i * WEEK_MS).toISOString().slice(0, 10),
    count: byIndex.get(i) || 0,
  }));
};
