/**
 * Test fixture: a real, side-effect-free migration module.
 *
 * Used by `migrations.unit.tests.js` to exercise `runMigration()`'s claim →
 * import → up() → markDone success path against a real (non-mocked) file
 * import, without depending on `modules/billing`'s migration file (module
 * self-containment, #3992 follow-up). Lives under `tests/fixtures/` — NOT
 * `modules/core/migrations/` — so it is never picked up by
 * `discoverMigrationFiles()`'s `modules/&#42;/migrations/&#42;.js` glob and never
 * runs as a real migration; `runMigration()` is called directly with this
 * file's path in the test, bypassing discovery entirely.
 * @returns {Promise<void>}
 */
export async function up() {
  // Intentionally empty — see file doc above.
}
