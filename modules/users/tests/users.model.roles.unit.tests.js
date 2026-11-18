/**
 * Module dependencies.
 */
import { describe, test, expect } from '@jest/globals';
import mongoose from 'mongoose';

import '../models/users.model.mongoose.js';

/**
 * The stored `roles` array only accepts `config.whitelists.users.roles`.
 */
describe('User model roles enum:', () => {
  const User = mongoose.model('User');

  test('accepts whitelisted roles', () => {
    const err = new User({ email: 'roles-ok@test.com', roles: ['user', 'admin'] }).validateSync();
    expect(err?.errors?.['roles.0']).toBeUndefined();
    expect(err?.errors?.['roles.1']).toBeUndefined();
  });

  test('rejects a role outside the whitelist', () => {
    const err = new User({ email: 'roles-ko@test.com', roles: ['user', 'root'] }).validateSync();
    expect(err.errors['roles.1'].kind).toBe('enum');
  });
});
