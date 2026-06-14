/**
 * Password hashing helpers (bcrypt). Dependency-free leaf — breaks the auth↔users service cycle.
 * Source of truth for hashPassword / comparePassword; both auth.service and users.service import from here.
 */
import bcrypt from 'bcrypt';

const saltRounds = 10;

const hashPassword = (password) => bcrypt.hash(String(password), saltRounds);

const comparePassword = async (userPassword, storedPassword) => bcrypt.compare(String(userPassword), String(storedPassword));

export { hashPassword, comparePassword };
export default { hashPassword, comparePassword };
