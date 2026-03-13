/**
 * Module dependencies
 */
import _ from 'lodash';
import bcrypt from 'bcrypt';
import generatePassword from 'generate-password';
import zxcvbn from 'zxcvbn';

import config from '../../../config/index.js';
import AppError from '../../../lib/helpers/AppError.js';
import UserService from '../../users/services/users.service.js';

const saltRounds = 10;

/**
 * @desc Local function to removeSensitive data from user
 * @param {Object} user
 * @return {Object} user
 */
const removeSensitive = (user, conf) => {
  if (!user || typeof user !== 'object') return null;
  const keys = conf || config.whitelists.users.default;
  const plain = typeof user.toJSON === 'function' ? user.toJSON() : user;
  return _.pick(plain, keys);
};

/**
 * @desc Function to compare passwords
 * @param {String} userPassword
 * @param {String} storedPassword
 * @return {Boolean} true/false
 */
const comparePassword = async (userPassword, storedPassword) => bcrypt.compare(String(userPassword), String(storedPassword));

/**
 * @desc Check whether the user account is currently locked and throw if so
 * @param {Object} user - Mongoose user document
 * @returns {Promise<Object>} user with lock state reset when an expired lock is detected
 */
const checkLockout = async (user) => {
  if (user.lockUntil && user.lockUntil > new Date()) {
    const remainingMs = user.lockUntil.getTime() - Date.now();
    const remainingMin = Math.ceil(remainingMs / 60000);
    throw new AppError('Account is locked. Try again later.', {
      code: 'ACCOUNT_LOCKED',
      status: 423,
      details: { message: `Account is locked. Try again in ${remainingMin} minute(s).`, remainingMs },
    });
  }
  // If lock has expired, reset attempts so the user can try again
  if (user.lockUntil && user.lockUntil <= new Date()) {
    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    await user.save();
  }
  return user;
};

/**
 * @desc Record a failed login attempt and lock the account when the threshold is reached
 * @param {Object} user - Mongoose user document
 * @returns {Promise<void>} resolves after persisting the updated attempt counter
 */
const recordFailedAttempt = async (user) => {
  const maxAttempts = config.auth?.lockout?.maxAttempts ?? 5;
  const lockMinutes = config.auth?.lockout?.lockDuration ?? 30;
  user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
  if (user.failedLoginAttempts >= maxAttempts) {
    user.lockUntil = new Date(Date.now() + lockMinutes * 60 * 1000);
  }
  await user.save();
};

/**
 * @desc Record a successful login by resetting failed attempts and stamping lastLoginAt
 * @param {Object} user - Mongoose user document
 * @returns {Promise<void>} resolves after persisting the login timestamp
 */
const recordSuccessfulLogin = async (user) => {
  user.failedLoginAttempts = 0;
  user.lockUntil = null;
  user.lastLoginAt = new Date();
  await user.save();
};

/**
 * @desc Function to authenticate user
 * @param {String} email
 * @param {String} password
 * @returns {Promise<Object>} sanitized user object on success
 */
const authenticate = async (email, password) => {
  const user = await UserService.getBrut({ email });
  if (!user) throw new AppError('invalid user or password.', { code: 'SERVICE_ERROR' });

  // Check lockout before attempting password comparison
  await checkLockout(user);

  if (await comparePassword(password, user.password)) {
    await recordSuccessfulLogin(user);
    return removeSensitive(user);
  }

  // Wrong password — record the failure
  await recordFailedAttempt(user);
  throw new AppError('invalid user or password.', { code: 'SERVICE_ERROR' });
};

/**
 * @desc Function to hash passwords
 * @param {String} password
 * @return {String} password hashed
 */
const hashPassword = (password) => bcrypt.hash(String(password), saltRounds);

/**
 * @desc Function to check password strength using zxcvbn
 * @param {String} password
 * @return {String} password if it passes
 */
const checkPassword = (password) => {
  const result = zxcvbn(password);
  if (result.score < config.zxcvbn.minimumScore) {
    throw new AppError('Password too weak.', {
      code: 'SERVICE_ERROR',
      details: result.feedback.suggestions.map((s) => ({ message: s })),
    });
  } else {
    return password;
  }
};

/**
 * @desc Seed : Function to generateRandomPassphrase
 * Generates a random passphrase that passes the zxcvbn test
 * Returns a promise that resolves with the generated passphrase, or rejects with an error if something goes wrong.
 * NOTE: Passphrases are only tested against the required zxcvbn strength tests, and not the optional tests.
 * @return {Promise} user
 */
const generateRandomPassphrase = () => {
  let password = '';
  const repeatingCharacters = /(.)\1{2,}/g;
  // iterate until the we have a valid passphrase
  // NOTE: Should rarely iterate more than once, but we need this to ensure no repeating characters are present
  while (password.length < 20 || repeatingCharacters.test(password)) {
    // build the random password
    password = generatePassword.generate({
      length: Math.floor(Math.random() * 20) + 20, // randomize length between 20 and 40 characters
      numbers: true,
      symbols: false,
      uppercase: true,
      excludeSimilarCharacters: true,
    });

    // check if we need to remove any repeating characters
    password = password.replace(repeatingCharacters, '');
  }
  // Send the rejection back if the passphrase fails to pass the strength test
  return checkPassword(password);
};

export default {
  removeSensitive,
  authenticate,
  comparePassword,
  hashPassword,
  checkPassword,
  generateRandomPassphrase,
  checkLockout,
  recordFailedAttempt,
  recordSuccessfulLogin,
};
