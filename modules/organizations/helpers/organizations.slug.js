/**
 * Module dependencies
 */
import OrganizationRepository from '../repositories/organizations.repository.js';

/**
 * Normalize a string into a URL-safe slug.
 * Strips diacritics, replaces non-alphanumeric characters with hyphens,
 * and lowercases the result.
 * @param {string} input - The raw string to slugify.
 * @returns {string} The normalized slug.
 */
const slugify = (input) =>
  input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Generate a unique organization slug from a user's first and last name.
 * Format: "{firstName}s-organization", with a numeric suffix if the base slug
 * already exists in the database.
 * @param {string} firstName - The user's first name.
 * @param {string} lastName - The user's last name (used as fallback).
 * @returns {Promise<string>} A unique slug string.
 */
const generateOrganizationSlug = async (firstName, lastName) => {
  const base = firstName ? slugify(`${firstName}s organization`) : slugify(`${lastName}s organization`);

  let candidate = base;
  let counter = 1;
  while (await OrganizationRepository.exists({ slug: candidate })) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
};

export { slugify, generateOrganizationSlug };
export default { slugify, generateOrganizationSlug };
