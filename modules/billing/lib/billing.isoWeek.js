/**
 * @function isoWeekKey
 * @description Compute the ISO 8601 week key in YYYY-Www format.
 * @param {Date} date - Date to compute.
 * @returns {string} ISO week key.
 */
const MS_PER_DAY = 86_400_000;

export const isoWeekKey = (date) => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / MS_PER_DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
};

/**
 * @function currentWeekKey
 * @description Compute the current ISO 8601 week key in YYYY-Www format.
 * @returns {string} Current ISO week key.
 */
export const currentWeekKey = () => isoWeekKey(new Date());

/**
 * @function weekStartDate
 * @description Compute the UTC start of the ISO week from a YYYY-Www key.
 *              Returns the Monday 00:00:00 UTC of that ISO week.
 * @param {string} weekKey - ISO week key in YYYY-Www format.
 * @returns {Date} Start of the ISO week (Monday 00:00:00 UTC).
 */
export const weekStartDate = (weekKey) => {
  const [yearStr, weekStr] = weekKey.split('-W');
  const year = Number(yearStr);
  const week = Number(weekStr);
  // Jan 4 is always in ISO week 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  // Go back to Monday of week 1
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1));
  // Add (week - 1) * 7 days to reach the target week's Monday
  const targetMonday = new Date(week1Monday);
  targetMonday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return targetMonday;
};

export default {
  currentWeekKey,
  isoWeekKey,
  weekStartDate,
};
