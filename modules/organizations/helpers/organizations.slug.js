/**
 * Module dependencies
 */
import OrganizationRepository from '../repositories/organizations.repository.js';
import { slugify, uniqueSlug } from '../../../lib/helpers/slug.js';

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
  return uniqueSlug(base, (slug) => OrganizationRepository.exists({ slug }));
};

export { slugify, generateOrganizationSlug };
export default { slugify, generateOrganizationSlug };
