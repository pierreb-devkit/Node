/**
 * Password hashing helpers (bcrypt). Dependency-free leaf — breaks the auth↔users service cycle.
 * Source of truth for hashPassword / comparePassword; both auth.service and users.service import from here.
 */
import bcrypt from 'bcrypt';

const saltRounds = 10;

/**
 * @desc Hash a plaintext password using bcrypt.
 * @param {string|number} password - The plaintext password to hash.
 * @returns {Promise<string>} The bcrypt hash.
 */
const hashPassword = (password) => bcrypt.hash(String(password), saltRounds);

/**
 * @desc Compare a plaintext password against a stored bcrypt hash.
 * @param {string|number} userPassword - The plaintext candidate password.
 * @param {string} storedPassword - The stored bcrypt hash.
 * @returns {Promise<boolean>} True if the password matches the hash.
 */
const comparePassword = async (userPassword, storedPassword) => bcrypt.compare(String(userPassword), String(storedPassword));

export { hashPassword, comparePassword };
export default { hashPassword, comparePassword };
