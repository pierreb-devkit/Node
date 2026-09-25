/**
 * Pack expiry attribution — pure ledger replay, no I/O.
 *
 * An expiring pack (or grant) must remove only its OWN unspent units, never units
 * already consumed, refunded, or belonging to another credit. The ledger does not store
 * per-pack remainders, so they are derived by replaying it in ARRAY order (the commit
 * order: every writer appends with an atomic `$push`):
 *
 *   - credits: 'topup' (pack or grant) and positive 'adjustment' entries. A new credit
 *     first repays any uncovered debt (units spent when no credit was live), then its
 *     remainder is spendable.
 *   - 'debit': drawn from the live credits, earliest `expiresAt` first (ties: oldest
 *     entry first), credits without expiry last. What no live credit covers becomes
 *     uncovered debt.
 *   - 'refund' carrying a `stripeSessionId`: drawn from the pack bought in that session
 *     first; the excess (units of that pack already spent) is drawn like a debit.
 *   - 'expiration' (`refId: expire-<topupId>`): the pack is handled; any part of the
 *     entry beyond the pack's remainder (legacy full-amount entries) is drawn like a debit.
 *   - a credit stops being live at its `expiresAt`: entries at or after that instant never
 *     draw from it, and credits added after it are never removed by it.
 *
 * Invariant: sum(remainders of unhandled credits) − uncovered debt === sum(ledger amounts).
 */

/**
 * Convert a date-like value to epoch milliseconds.
 * @param {Date|string|number|null|undefined} value - A date-like value.|string|number|null|undefined} value - A date-like value.
 * @returns {number|null} Epoch milliseconds, or null when absent or invalid.
 */
const toMs = (value) => {
  if (value === null || value === undefined) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * @function replayCredits
 * @description Replay a ledger and return every credit with its unspent remainder.
 *              A credit whose `expiresAt` has passed keeps the remainder it had at that
 *              instant (minus any refund of that same pack), which is exactly what its
 *              expiry may remove.
 * @param {Object[]} ledger - Ledger entries in array (commit) order.
 * @returns {{credits: Array<{id: string, kind: string, remaining: number, expiresAtMs: number|null, handled: boolean}>, uncoveredDebt: number}}
 */
export const replayCredits = (ledger) => {
  const credits = [];
  const byId = new Map();
  const bySession = new Map();
  let uncoveredDebt = 0;

  /**
   * Draw units from live credits, earliest expiry first; the rest becomes uncovered debt.
   * @param {number} units - Units to draw (>= 0).
   * @param {number|null} atMs - Entry timestamp; credits expired at that instant are skipped.
   * @returns {void}
   */
  const draw = (units, atMs) => {
    let left = units;
    const live = credits
      .filter((c) => !c.handled && c.remaining > 0 && (c.expiresAtMs === null || atMs === null || c.expiresAtMs > atMs))
      .sort((a, b) => (a.expiresAtMs ?? Infinity) - (b.expiresAtMs ?? Infinity) || a.order - b.order);
    for (const c of live) {
      if (left <= 0) break;
      const take = Math.min(c.remaining, left);
      c.remaining -= take;
      left -= take;
    }
    uncoveredDebt += left;
  };

  ledger.forEach((e, order) => {
    const amount = e.amount ?? 0;
    const atMs = toMs(e.at);

    if ((e.kind === 'topup' || e.kind === 'adjustment') && amount > 0) {
      const repay = Math.min(uncoveredDebt, amount);
      uncoveredDebt -= repay;
      const credit = {
        id: String(e._id),
        kind: e.kind,
        remaining: amount - repay,
        expiresAtMs: toMs(e.expiresAt),
        handled: false,
        order,
      };
      credits.push(credit);
      byId.set(credit.id, credit);
      if (e.kind === 'topup' && e.stripeSessionId && !bySession.has(e.stripeSessionId)) bySession.set(e.stripeSessionId, credit);
      return;
    }

    const units = Math.max(0, -amount); // zero-amount expiration markers remove nothing
    let own = null;
    if (e.kind === 'refund' && e.stripeSessionId) own = bySession.get(e.stripeSessionId) ?? null;
    else if (e.kind === 'expiration' && typeof e.refId === 'string' && e.refId.startsWith('expire-')) own = byId.get(e.refId.slice('expire-'.length)) ?? null;

    let rest = units;
    if (own && !own.handled) {
      const take = Math.min(own.remaining, units);
      own.remaining -= take;
      rest -= take;
    }
    if (e.kind === 'expiration' && own) {
      own.handled = true;
      own.remaining = 0;
    }
    if (rest > 0) draw(rest, atMs);
  });

  return { credits, uncoveredDebt };
};

/**
 * @function computeExpiryRemovals
 * @description List the topups whose `expiresAt` is before `now` and that no expiration
 *              entry has handled yet, each with the units its expiry must remove: its own
 *              remainder at expiry (0 when fully spent or refunded — the sweep still records
 *              a zero marker so the pack is never expired again).
 * @param {Object[]} ledger - Ledger entries in array (commit) order.
 * @param {Date} now - Sweep cutoff.
 * @returns {Array<{topupId: string, amount: number}>} amount >= 0.
 */
export const computeExpiryRemovals = (ledger, now) => {
  const nowMs = now.getTime();
  return replayCredits(ledger)
    .credits.filter((c) => c.kind === 'topup' && !c.handled && c.expiresAtMs !== null && c.expiresAtMs < nowMs)
    .map((c) => ({ topupId: c.id, amount: c.remaining }));
};
