/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import config from '../../../config/index.js';
import policy from '../../../lib/middlewares/policy.js';
import OrganizationsRepository from '../../organizations/repositories/organizations.repository.js';
import MembershipRepository from '../../organizations/repositories/organizations.membership.repository.js';
import { slugify, generateOrganizationSlug } from '../../organizations/helpers/slug.js';

/**
 * Extract the domain part from an email address.
 * @param {string} email - A valid email address.
 * @returns {string} The domain portion (e.g. "acme.com").
 */
const extractDomain = (email) => email.split('@')[1].toLowerCase();

/**
 * Derive a human-readable organization name from an email domain.
 * Strips the TLD and capitalizes the first letter (e.g. "acme.com" → "Acme").
 * @param {string} domain - The email domain.
 * @returns {string} A display name for the organization.
 */
const nameFromDomain = (domain) => {
  const base = domain.split('.')[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
};

/**
 * Generate a unique slug from an email domain.
 * Appends a numeric suffix if the base slug already exists.
 * @param {string} domain - The email domain to derive the slug from.
 * @returns {Promise<string>} A unique slug string.
 */
const generateSlugFromDomain = async (domain) => {
  const Organization = mongoose.model('Organization');
  const base = slugify(domain.split('.')[0]);
  let candidate = base;
  let counter = 1;
  while (await Organization.exists({ slug: candidate })) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
};

/**
 * Create a new organization, an owner membership, and set currentOrganization on the user.
 * @param {Object} params - Parameters for org creation.
 * @param {string} params.name - Display name for the organization.
 * @param {string} params.slug - URL-safe slug for the organization.
 * @param {string} params.domain - Email domain associated with the org (can be empty).
 * @param {Object} params.user - The newly created user object (must have id/firstName/lastName).
 * @returns {Promise<{organization: Object, membership: Object}>} The created org and membership.
 */
const createOrganizationForUser = async ({ name, slug, domain, user }) => {
  const User = mongoose.model('User');
  const userId = user.id || user._id;

  const organization = await OrganizationsRepository.create({
    name,
    slug,
    domain: domain || '',
    plan: 'free',
    createdBy: userId,
  });

  const membership = await MembershipRepository.create({
    userId,
    organizationId: organization._id,
    role: 'owner',
  });

  await User.updateOne({ _id: userId }, { currentOrganization: organization._id });

  return { organization, membership };
};

/**
 * Handle organization provisioning during the signup flow.
 *
 * Behaviour depends on the organizations configuration flags:
 * - **!enabled**: Creates a silent/default org named "{firstName}'s organization".
 * - **enabled + autoCreate + domainMatching**: Joins existing org by email domain or creates a new one.
 * - **enabled + autoCreate + !domainMatching**: Always creates a personal org.
 * - **enabled + !autoCreate**: Returns null (user will set up manually later).
 *
 * @param {Object} user - The user object returned by UserService.create (with id, email, firstName, lastName).
 * @returns {Promise<{organization: Object|null, membership: Object|null, abilities: Array, organizationSetupRequired: boolean}>}
 *   An object containing the organization context for the signup response.
 */
const handleSignupOrganization = async (user) => {
  const orgConfig = config.organizations || {};
  const userId = user.id || user._id;
  const User = mongoose.model('User');

  // Case 1: Organizations disabled — create a silent default org
  if (!orgConfig.enabled) {
    const firstName = user.firstName || 'User';
    const name = `${firstName}'s organization`;
    const slug = await generateOrganizationSlug(firstName, user.lastName || '');

    const { organization, membership } = await createOrganizationForUser({
      name,
      slug,
      domain: '',
      user,
    });

    const ability = await policy.defineAbilityFor(user, membership);

    return {
      organization,
      membership,
      abilities: ability.rules,
      organizationSetupRequired: false,
    };
  }

  // Case 2: Organizations enabled but autoCreate is off — manual setup later
  if (!orgConfig.autoCreate) {
    const ability = await policy.defineAbilityFor(user, null);
    return {
      organization: null,
      membership: null,
      abilities: ability.rules,
      organizationSetupRequired: true,
    };
  }

  // Case 3: Organizations enabled + autoCreate
  const domain = extractDomain(user.email);

  // Case 3a: domainMatching enabled — try to find an existing org
  if (orgConfig.domainMatching) {
    const existingOrgs = await OrganizationsRepository.list({ domain });

    if (existingOrgs.length > 0) {
      // Join the first matching org as a member
      const organization = existingOrgs[0];

      const membership = await MembershipRepository.create({
        userId,
        organizationId: organization._id,
        role: 'member',
      });

      await User.updateOne({ _id: userId }, { currentOrganization: organization._id });

      const ability = await policy.defineAbilityFor(user, membership);

      return {
        organization,
        membership,
        abilities: ability.rules,
        organizationSetupRequired: false,
      };
    }

    // No matching org found — create a new one with the domain set
    const name = nameFromDomain(domain);
    const slug = await generateSlugFromDomain(domain);

    const { organization, membership } = await createOrganizationForUser({
      name,
      slug,
      domain,
      user,
    });

    const ability = await policy.defineAbilityFor(user, membership);

    return {
      organization,
      membership,
      abilities: ability.rules,
      organizationSetupRequired: false,
    };
  }

  // Case 3b: domainMatching disabled — always create a personal org
  const firstName = user.firstName || 'User';
  const name = `${firstName}'s organization`;
  const slug = await generateOrganizationSlug(firstName, user.lastName || '');

  const { organization, membership } = await createOrganizationForUser({
    name,
    slug,
    domain: '',
    user,
  });

  const ability = await policy.defineAbilityFor(user, membership);

  return {
    organization,
    membership,
    abilities: ability.rules,
    organizationSetupRequired: false,
  };
};

export default {
  handleSignupOrganization,
  extractDomain,
  nameFromDomain,
  generateSlugFromDomain,
  createOrganizationForUser,
};
