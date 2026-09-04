/**
 * Property names that must never be used as an object key when the value is
 * about to be merged onto / assigned onto another object, or serialized:
 * assigning `picked['__proto__'] = x` on a plain object reassigns its
 * PROTOTYPE (via the inherited accessor on `Object.prototype`) instead of
 * creating an own property, and `constructor`/`prototype` are the classic
 * adjacent prototype-pollution vectors.
 *
 * Single source of truth, imported by BOTH `config/index.js#deepMerge` (the
 * config-merge guard) and `lib/helpers/responses.js#sanitizeConfigList` (the
 * details-whitelist config guard) — never re-declared at either call site, so
 * the two guards cannot silently drift apart. Deliberately its own module
 * rather than a named export of `config/index.js`: that module is mocked
 * down to `{ default: {...} }` (no named exports) across ~100 test files via
 * `jest.unstable_mockModule`, so any shared helper adding a required named
 * import from it breaks every one of those mocks at module-link time,
 * regardless of whether the mocked test path exercises the new export.
 * @readonly
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export default UNSAFE_KEYS;
