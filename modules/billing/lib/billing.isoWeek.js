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

export default {
  currentWeekKey,
  isoWeekKey,
};
