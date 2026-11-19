/**
 * Pure helpers for `modules/users/crons/users.emailSequences.js` (#4163).
 *
 * No DB/network access in this file on purpose: `users.emailSequences.js` is a
 * top-level-await CLI entry point (same shape as `modules/billing/crons/*`)
 * that cannot be imported from a test without actually connecting to MongoDB
 * and calling `process.exit`. The day-boundary math and the Mongo filter it
 * drives are therefore split out here, exactly the way billing's cron scripts
 * push their own math into a plain function instead of testing the script
 * file directly (see `modules/billing/tests/billing.cron.dunningSweep.unit.tests.js`'s
 * doc comment).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @function utcMidnight
 * @description Truncate a Date to UTC midnight of its own calendar day.
 * @param {Date} date
 * @returns {Date}
 */
const utcMidnight = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/**
 * @function stepCreatedAtRange
 * @description The `createdAt` `[gte, lt)` range — a single UTC calendar day —
 * whose account age is exactly `day` whole days as of `now`. A user's account
 * age is measured in UTC calendar days (midnight to midnight), not elapsed
 * milliseconds, so the step fires once per day regardless of what time of day
 * the user originally signed up.
 *
 * The range is clamped to not start before `startAt` (the sequence's cutoff —
 * "users with createdAt >= startAt", #4163). When the whole day's range falls
 * before `startAt`, no user can ever match it — `null` tells the caller to
 * skip the DB query entirely for this step.
 * @param {object} opts
 * @param {Date} opts.now - current time
 * @param {number} opts.day - non-negative integer account age in days
 * @param {Date} opts.startAt - sequence cutoff; users created before this never match
 * @returns {{gte: Date, lt: Date}|null}
 */
const stepCreatedAtRange = ({ now, day, startAt }) => {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('stepCreatedAtRange: now must be a valid Date');
  }
  if (!Number.isInteger(day) || day < 0) {
    throw new TypeError(`stepCreatedAtRange: day must be a non-negative integer, received ${day}`);
  }
  if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime())) {
    throw new TypeError('stepCreatedAtRange: startAt must be a valid Date');
  }

  const today = utcMidnight(now);
  const gte = new Date(today.getTime() - day * MS_PER_DAY);
  const lt = new Date(today.getTime() - (day - 1) * MS_PER_DAY);

  const clampedGte = startAt > gte ? startAt : gte;
  if (clampedGte >= lt) return null; // entire day range predates startAt

  return { gte: clampedGte, lt };
};

/**
 * @function buildStepFilter
 * @description The Mongo filter for one sequence step's recipient page query —
 * the same opted-out/unverified exclusion `UserService.announce` already
 * applies (`emailVerified: true`, `emailPreferences.<kind>` not explicitly
 * `false`), narrowed to the step's `createdAt` range so the DB, not the
 * process, excludes everyone who can't possibly match.
 * @param {object} opts
 * @param {string} opts.kind - parsed EmailKind ('onboarding' | 'news')
 * @param {Date} opts.gte
 * @param {Date} opts.lt
 * @returns {Object} Mongo filter
 */
const buildStepFilter = ({ kind, gte, lt }) => ({
  createdAt: { $gte: gte, $lt: lt },
  emailVerified: true,
  [`emailPreferences.${kind}`]: { $ne: false },
});

export { utcMidnight, stepCreatedAtRange, buildStepFilter };
export default { utcMidnight, stepCreatedAtRange, buildStepFilter };
