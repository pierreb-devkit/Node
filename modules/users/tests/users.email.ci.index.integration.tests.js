/**
 * Module dependencies.
 */
import path from 'path';
import mongoose from 'mongoose';

import { beforeAll, afterAll, afterEach, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';

import { up } from '../migrations/20260610120000-users-email-ci-unique-index.js';

/**
 * E3 — case-insensitive unique email index integration tests.
 *
 * Asserts the END STATE the schema declaration + migration converge on:
 *   - exactly ONE unique index on { email:1 } with a collation, and NO stray plain
 *     `email_1` after syncIndexes();
 *   - `User@x.com` and `user@x.com` collide (cannot coexist) under that index.
 *
 * Uses the REAL bootstrapped app (migrations + autoIndex already ran) and the real
 * User model against the test Mongo.
 */
describe('E3 case-insensitive unique email index:', () => {
  let UserService;
  let User;

  beforeAll(async () => {
    await bootstrap();
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    User = mongoose.model('User');
    // Make sure indexes are reconciled to the schema declaration (idempotent vs the
    // migration + autoIndex — this is the assertion's whole point).
    await User.syncIndexes();
  });

  afterEach(async () => {
    for (const email of ['ci-base@example.com', 'ci-variant@example.com']) {
      try {
        const existing = await UserService.getBrut({ email });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup */ }
    }
  });

  afterAll(async () => {
    // Belt: drop any leftover rows by lowercased match (mirrors afterEach targets).
    try {
      await User.deleteMany({ email: { $in: ['ci-base@example.com', 'ci-variant@example.com'] } }).exec();
    } catch (_) { /* cleanup */ }
  });

  test('after syncIndexes the users collection has the collation unique email index and NO stray plain email_1', async () => {
    const indexes = await User.collection.listIndexes().toArray();
    const emailIndexes = indexes.filter((ix) => ix.key && ix.key.email === 1);

    // Exactly one index keyed on { email:1 }.
    expect(emailIndexes.length).toBe(1);
    const emailIx = emailIndexes[0];
    // It is unique AND carries a collation (case-insensitive).
    expect(emailIx.unique).toBe(true);
    expect(emailIx.collation).toBeDefined();
    expect(emailIx.collation.strength).toBe(2);
    // No stray PLAIN (collation-less) email_1 left behind.
    const strayPlain = indexes.find((ix) => ix.name === 'email_1' && !ix.collation);
    expect(strayPlain).toBeUndefined();
  });

  test('User@x.com and user@x.com collide — the case-variant cannot create a 2nd account', async () => {
    // First account (mixed case input — stored lowercased by the schema setter).
    const first = await UserService.create({ email: 'CI-Base@Example.com', password: 'Sup3rStr0ng!', provider: 'local' });
    expect(first).toBeDefined();

    // A different-case variant of the SAME address must be rejected by the unique
    // collation index (duplicate key), not silently create a 2nd account.
    await expect(
      UserService.create({ email: 'ci-base@example.com', password: 'Sup3rStr0ng!', provider: 'local' }),
    ).rejects.toMatchObject({ code: 11000 });

    // And only one row exists for the address.
    const count = await User.countDocuments({ email: 'ci-base@example.com' }).exec();
    expect(count).toBe(1);
  });

  test('emails are stored lowercased and resolvable case-insensitively via the repository', async () => {
    await UserService.create({ email: 'CI-Variant@Example.com', password: 'Sup3rStr0ng!', provider: 'local' });
    // Stored lowercased.
    const stored = await User.findOne({ email: 'ci-variant@example.com' }).exec();
    expect(stored).not.toBeNull();
    // Repository findByEmail lowercases the query term, so a mixed-case lookup hits.
    const found = await UserService.getBrut({ email: 'CI-Variant@Example.com' });
    expect(found).not.toBeNull();
    expect(found.email).toBe('ci-variant@example.com');
  });

  test('lowercases legacy mixed-case emails so post-chain binary lookups can find them', async () => {
    const col = mongoose.connection.db.collection('users');
    try {
      // Bypass the schema (lowercase:true) — simulate a PRE-chain legacy row.
      await col.insertOne({
        email: 'Legacy.MixedCase@Example.COM',
        firstName: 'Legacy',
        lastName: 'Row',
        provider: 'local',
        roles: ['user'],
      });
      await up();
      // Raw read (binary): the stored value itself must now be lowercase.
      const raw = await col.findOne({ email: 'legacy.mixedcase@example.com' });
      expect(raw).not.toBeNull();
      const mixed = await col.findOne({ email: 'Legacy.MixedCase@Example.COM' });
      expect(mixed).toBeNull();
    } finally {
      // Binary deletes — target BOTH forms so a failing (pre-fix) run cannot leak the row.
      await col.deleteMany({ email: { $in: ['legacy.mixedcase@example.com', 'Legacy.MixedCase@Example.COM'] } });
    }
  });

  test('still ABORTS on case-variant duplicates BEFORE normalizing anything', async () => {
    const col = mongoose.connection.db.collection('users');
    try {
      // The bootstrapped DB already carries the CI unique index, which would reject the
      // 2nd case-variant insert below — drop it to simulate the PRE-migration state the
      // dup pre-check exists for (the finally re-runs up() to restore the end state).
      try { await col.dropIndex('email_ci_unique'); } catch (_) { /* already absent */ }
      await col.insertOne({ email: 'Dupe@x.com', firstName: 'A', lastName: 'A', provider: 'local', roles: ['user'] });
      await col.insertOne({ email: 'dupe@x.com', firstName: 'B', lastName: 'B', provider: 'local', roles: ['user'] });
      await expect(up()).rejects.toThrow(/case-variant duplicate/);
      // Neither row was modified (abort happens before the normalization pass).
      expect(await col.findOne({ email: 'Dupe@x.com' })).not.toBeNull();
      expect(await col.findOne({ email: 'dupe@x.com' })).not.toBeNull();
    } finally {
      await col.deleteMany({ email: { $in: ['Dupe@x.com', 'dupe@x.com'] } });
      // Restore the migrated end state (idempotent — the dup rows are gone).
      await up();
    }
  });
});
