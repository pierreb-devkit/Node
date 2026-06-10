/**
 * Module dependencies.
 */
import path from 'path';
import mongoose from 'mongoose';

import { beforeAll, afterAll, afterEach, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';

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
});
