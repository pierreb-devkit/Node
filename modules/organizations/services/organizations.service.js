/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import mailer from '../../../lib/helpers/mailer/index.js';
import policy from '../../../lib/middlewares/policy.js';
import serializeAbilities from '../../../lib/helpers/abilities.js';
import OrganizationsRepository from '../repositories/organizations.repository.js';
import MembershipRepository from '../repositories/organizations.membership.repository.js';
import MembershipService from './organizations.membership.service.js';
import UserService from '../../users/services/users.service.js';
import { slugify, generateOrganizationSlug } from '../helpers/organizations.slug.js';

/**
 * @desc Strip sensitive fields from an organization document before returning to public flows.
 * @param {Object} org - Organization document (Mongoose or plain).
 * @returns {Object} Safe projection without createdBy or plan.
 */
const sanitizeOrg = (org) => {
  const obj = org.toJSON ? org.toJSON() : { ...org };
  delete obj.createdBy;
  delete obj.plan;
  return obj;
};

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
  const base = slugify(domain.split('.')[0]);
  let candidate = base;
  let counter = 1;
  while (await OrganizationsRepository.exists({ slug: candidate })) {
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
 * @param {Function} [params.slugGenerator] - Optional custom slug generator function. Defaults to internal slug generation.
 * @returns {Promise<{organization: Object, membership: Object}>} The created org and membership.
 */
const createOrganizationForUser = async ({ name, slug, domain, user, slugGenerator }) => {
  const userId = user.id || user._id;
  const maxRetries = 5;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    let organization;
    let membership;
    const currentSlug = attempt === 0 ? slug : `${slug}-${attempt}`;

    try {
      organization = await OrganizationsRepository.create({
        name,
        slug: currentSlug,
        domain: domain || '',
        plan: 'free',
        createdBy: userId,
      });

      membership = await MembershipRepository.create({
        userId,
        organizationId: organization._id,
        role: 'owner',
      });

      await UserService.updateById(userId, { currentOrganization: organization._id });

      return { organization, membership };
    } catch (err) {
      // Clean up any partially created artifacts to avoid orphaned records
      if (membership) {
        await MembershipRepository.deleteMany({ _id: membership._id }).catch(() => {});
      }
      if (organization) {
        await OrganizationsRepository.remove(organization).catch(() => {});
      }
      // Retry on MongoDB duplicate key error for slug collisions (TOCTOU race)
      if (err.code === 11000 && err.message?.includes('slug') && attempt < maxRetries - 1) {
        continue;
      }
      throw err;
    }
  }

  // Fallback: re-generate slug from scratch if all retries exhausted
  if (slugGenerator) {
    const freshSlug = await slugGenerator();
    return createOrganizationForUser({ name, slug: freshSlug, domain, user });
  }
  throw new Error('Failed to create organization: slug conflict after maximum retries');
};

/**
 * Handle organization provisioning during the signup flow.
 *
 * Behaviour depends on the organizations configuration flags:
 * - **!enabled**: Creates a silent/default org named "{firstName}'s organization".
 * - **enabled**: Never auto-creates or auto-joins. Returns information for the
 *   frontend to handle organization setup as step 2. If domainMatching is on and
 *   the user's email domain is not in the publicDomains blocklist, a matching
 *   existing org is returned as `suggestedOrganization`.
 *
 * @param {Object} user - The user object returned by UserService.create (with id, email, firstName, lastName).
 * @returns {Promise<{organization: Object|null, membership: Object|null, abilities: Array, organizationSetupRequired: boolean, emailVerificationRequired: boolean|undefined, suggestedOrganization: Object|null}>}
 *   An object containing the organization context for the signup response.
 */
const handleSignupOrganization = async (user) => {
  const orgConfig = config.organizations || {};

  // When mailer is configured, require email verification before any org provisioning
  if (mailer.isConfigured() && !user.emailVerified) {
    return {
      organization: null,
      membership: null,
      abilities: [],
      organizationSetupRequired: true,
      emailVerificationRequired: true,
      pendingJoin: false,
    };
  }

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
      abilities: serializeAbilities(ability),
      organizationSetupRequired: false,
    };
  }

  // Case 2: Organizations enabled
  const domain = extractDomain(user.email);
  const publicDomains = orgConfig.publicDomains || [];
  const isPublic = publicDomains.includes(domain.toLowerCase());

  // Case 2a: autoCreate enabled — automatically provision or join an organization
  if (orgConfig.autoCreate) {
    // Try domain matching first if enabled and domain is not public
    if (orgConfig.domainMatching && !isPublic) {
      const existingOrgs = await OrganizationsRepository.list({ domain });
      if (existingOrgs.length > 0) {
        // Create a pending join request — admin must approve
        const organization = sanitizeOrg(existingOrgs[0]);
        await MembershipService.createJoinRequest(user.id || user._id, existingOrgs[0]._id);
        const ability = await policy.defineAbilityFor(user, null);
        return {
          organization,
          membership: null,
          abilities: serializeAbilities(ability),
          organizationSetupRequired: false,
          pendingJoin: true,
        };
      }
      // No existing org — create a new one with the domain
      const name = nameFromDomain(domain);
      const slug = await generateSlugFromDomain(domain);
      const { organization, membership } = await createOrganizationForUser({ name, slug, domain, user });
      const ability = await policy.defineAbilityFor(user, membership);
      return {
        organization,
        membership,
        abilities: serializeAbilities(ability),
        organizationSetupRequired: false,
      };
    }
    // No domain matching — create a personal organization
    const firstName = user.firstName || 'User';
    const name = `${firstName}'s organization`;
    const slug = await generateOrganizationSlug(firstName, user.lastName || '');
    const { organization, membership } = await createOrganizationForUser({ name, slug, domain: '', user });
    const ability = await policy.defineAbilityFor(user, membership);
    return {
      organization,
      membership,
      abilities: serializeAbilities(ability),
      organizationSetupRequired: false,
    };
  }

  // Case 2b: autoCreate disabled — require step 2
  let suggestedOrganization = null;

  // If domain matching enabled and domain is NOT public, suggest existing org
  if (orgConfig.domainMatching && !isPublic) {
    const existingOrgs = await OrganizationsRepository.list({ domain });
    if (existingOrgs.length > 0) {
      suggestedOrganization = sanitizeOrg(existingOrgs[0]);
    }
  }

  // Compute abilities without org context (user has no org yet)
  const ability = await policy.defineAbilityFor(user, null);

  return {
    organization: null,
    membership: null,
    abilities: serializeAbilities(ability),
    organizationSetupRequired: true,
    suggestedOrganization, // null or { _id, name, slug, domain }
  };
};

export default {
  handleSignupOrganization,
  extractDomain,
  nameFromDomain,
  generateSlugFromDomain,
  createOrganizationForUser,
};
