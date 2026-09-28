/**
 * Module dependencies.
 */
import path from 'path';
import mongoose from 'mongoose';
import { beforeAll, afterEach, afterAll, describe, test, expect } from '@jest/globals';

import { bootstrap } from '../../../lib/app.js';

/**
 * #4151 — verifyEmail used to read the user (getBrut) then write it (update) in two
 * separate steps. Two concurrent requests for the SAME token both passed the read
 * check before either write landed, so both provisioned an organization/grant for the
 * same signup. UserService.consumeEmailVerificationToken closes the race with one
 * atomic findOneAndUpdate on the still-unexpired token: only the first concurrent
 * caller can match it, the second gets null.
 *
 * Uses the real bootstrapped app + real User model against the test Mongo — the
 * atomicity guarantee this test proves cannot be faked with mocks (see
 * feedback_stale_evidence_worse_than_none).
 */
describe('UserService.consumeEmailVerificationToken — concurrent verification race (#4151):', () => {
  let UserService;
  let User;

  beforeAll(async () => {
    await bootstrap();
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    User = mongoose.model('User');
  });

  afterEach(async () => {
    await User.deleteMany({ email: { $regex: /^verify-race-/ } }).exec();
  });

  afterAll(async () => {
    await User.deleteMany({ email: { $regex: /^verify-race-/ } }).exec();
  });

  test('two concurrent requests for the same token: exactly one succeeds, the other gets null', async () => {
    const token = `tok_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const created = await User.create({
      firstName: 'Race',
      lastName: 'Condition',
      email: 'verify-race-1@example.com',
      provider: 'local',
      emailVerified: false,
      emailVerificationToken: token,
      emailVerificationExpires: Date.now() + 3600000,
    });

    const [r1, r2] = await Promise.all([
      UserService.consumeEmailVerificationToken(token),
      UserService.consumeEmailVerificationToken(token),
    ]);

    const results = [r1, r2];
    const succeeded = results.filter(Boolean);
    const failed = results.filter((r) => r === null);

    // Exactly ONE of the two concurrent requests may consume the token — the atomic
    // findOneAndUpdate's filter (unexpired token) can only ever match once, so the
    // second concurrent caller cannot re-provision a second workspace for this user.
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(String(succeeded[0]._id)).toBe(String(created._id));
    expect(succeeded[0].emailVerified).toBe(true);

    const dbUser = await User.findById(created._id).lean();
    expect(dbUser.emailVerified).toBe(true);
    expect(dbUser.emailVerificationToken).toBeNull();
    expect(dbUser.emailVerificationExpires).toBeNull();
  });

  test('an expired token is never consumed', async () => {
    const token = `tok_expired_${Date.now()}`;
    await User.create({
      firstName: 'Expired',
      lastName: 'Token',
      email: 'verify-race-2@example.com',
      provider: 'local',
      emailVerified: false,
      emailVerificationToken: token,
      emailVerificationExpires: Date.now() - 1000,
    });

    const result = await UserService.consumeEmailVerificationToken(token);
    expect(result).toBeNull();
  });

  test('a replay after the token was already consumed returns null (single-use)', async () => {
    const token = `tok_replay_${Date.now()}`;
    await User.create({
      firstName: 'Replay',
      lastName: 'Guard',
      email: 'verify-race-3@example.com',
      provider: 'local',
      emailVerified: false,
      emailVerificationToken: token,
      emailVerificationExpires: Date.now() + 3600000,
    });

    const first = await UserService.consumeEmailVerificationToken(token);
    const second = await UserService.consumeEmailVerificationToken(token);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
