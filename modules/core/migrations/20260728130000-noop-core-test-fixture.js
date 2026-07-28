/**
 * Migration: no-op core test fixture.
 *
 * Purely a stable, side-effect-free migration file OWNED by `modules/core`
 * (unlike every other real migration, which lives inside the module it
 * changes). The `modules/core` migration test suite (`migrations.integration.tests.js`
 * / `migrations.unit.tests.js`) needs a real, safe-to-inspect/re-run
 * migration record to exercise claim/status/resume behavior against — before
 * this fixture it borrowed `modules/billing/migrations/20260501000000-add-meter-fields.js`,
 * coupling core's own test suite to an unrelated (optional, downstream-may-not-ship-it)
 * module. "Each module is self-contained" (MIGRATIONS.md / stack coding
 * guidelines) applies to test fixtures too (#3992 follow-up).
 *
 * Safe on every project: does nothing, touches no collection, no index.
 * @returns {Promise<void>}
 */
export async function up() {
  // Intentionally empty — see file doc above.
}

/**
 * Down: no-op, mirrors up().
 * @returns {void}
 */
export function down() {}
