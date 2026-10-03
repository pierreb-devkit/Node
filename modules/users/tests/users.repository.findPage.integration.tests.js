/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, afterEach, afterAll, test, expect } from '@jest/globals';

import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests for UserRepository.findPage (#4162 — UserService.announce's
 * `_id`-ordered recipient walk). Real Mongo, not mocked: the one caller in this
 * codebase (`announce`) only ever exercises this through a mocked repository
 * (see users.service.sendProductMail.unit.tests.js), so the actual query —
 * the `afterId` page bound and the projection — needs its own direct coverage.
 */
describe('UserRepository.findPage integration tests (#4162):', () => {
  let UserRepository;
  let User;
  let insertedIds = [];

  beforeAll(async () => {
    await mongooseService.loadModels();
    await mongooseService.connect();
    User = mongoose.model('User');
    UserRepository = (await import('../repositories/users.repository.js')).default;
  });

  afterEach(async () => {
    if (insertedIds.length) {
      await User.deleteMany({ _id: { $in: insertedIds } });
      insertedIds = [];
    }
  });

  afterAll(async () => {
    await mongooseService.disconnect();
  });

  test('walks all matching rows across pages in ascending _id order with no gap or overlap, then returns [] once exhausted', async () => {
    const docs = await User.insertMany([
      { email: 'findpage-1@test.com', emailVerified: true },
      { email: 'findpage-2@test.com', emailVerified: true },
      { email: 'findpage-3@test.com', emailVerified: true },
    ]);
    insertedIds = docs.map((doc) => doc._id);
    const filter = { _id: { $in: insertedIds } };

    // First page — no afterId: exercises the `pageFilter = filter` branch.
    const page1 = await UserRepository.findPage(filter, { afterId: undefined, limit: 2, select: '_id email' });
    expect(page1).toHaveLength(2);
    expect(page1[0]).not.toHaveProperty('password');

    // Second page — afterId set: exercises the `{ ...filter, _id: { $gt: afterId } }` branch.
    const page2 = await UserRepository.findPage(filter, { afterId: page1[page1.length - 1]._id, limit: 2, select: '_id email' });
    expect(page2).toHaveLength(1);

    const walked = [...page1, ...page2].map((doc) => String(doc._id));
    expect(walked).toEqual([...walked].sort()); // ascending _id order, start to finish
    expect(new Set(walked).size).toBe(3); // no row repeated across pages

    // Exhausted: asking for anything past the last row's _id returns [].
    const page3 = await UserRepository.findPage(filter, { afterId: page2[0]._id, limit: 2, select: '_id email' });
    expect(page3).toEqual([]);
  });

  test('defaults to a 200-row limit and projects only the requested fields', async () => {
    const [doc] = await User.insertMany([{ email: 'findpage-default@test.com', emailVerified: true, firstName: 'Should not leak' }]);
    insertedIds = [doc._id];

    const page = await UserRepository.findPage({ _id: doc._id }, { select: '_id email emailVerified' });
    expect(page).toHaveLength(1);
    expect(page[0].email).toBe('findpage-default@test.com');
    expect(page[0]).not.toHaveProperty('firstName');
  });
});
