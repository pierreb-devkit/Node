/**
 * Module dependencies
 */
import config from '../../../config/index.js';
import mailer from '../../../lib/helpers/mailer/index.js';
import logger from '../../../lib/services/logger.js';
import policy from '../../../lib/middlewares/policy.js';
import serializeAbilities from '../../../lib/helpers/abilities.js';
import OrganizationsRepository from '../repositories/organizations.repository.js';
import MembershipRepository from '../repositories/organizations.membership.repository.js';
import UserService from '../../users/services/users.service.js';
import { slugify, generateOrganizationSlug } from '../helpers/organizations.slug.js';
import { MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES } from '../lib/constants.js';
import organizationEvents from '../lib/events.js';
import { isPublicDomain, normalizeEmailDomain } from './organizations.domain.js';

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

    let created = false;
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
        role: MEMBERSHIP_ROLES.OWNER,
      });

      await UserService.updateById(userId, { currentOrganization: organization._id });
      created = true;
    } catch (err) {
      // Clean up any partially created artifacts to avoid orphaned records
      if (membership) {
        await MembershipRepository.deleteMany({ _id: membership._id }).catch((e) => logger.error('organizations.service.createOrganizationForUser: rollback membership failed', { message: e?.message, stack: e?.stack }));
      }
      if (organization) {
        await OrganizationsRepository.remove(organization).catch((e) => logger.error('organizations.service.createOrganizationForUser: rollback organization failed', { message: e?.message, stack: e?.stack }));
      }
      // Retry on MongoDB duplicate key error for slug collisions (TOCTOU race)
      if (err.code === 11000 && err.message?.includes('slug') && attempt < maxRetries - 1) {
        continue;
      }
      throw err;
    }

    if (created) {
      // organization.created (#3952) — N2 signup grant moved off a direct billing import onto
      // this event; billing subscribes from billing.init.js and credits the one-shot signupGrant.
      // Emitted outside the try/catch above so billing failure never triggers org/membership
      // rollback; the listener owns its own guard (never throws/rejects out). Fire-and-forget,
      // synchronous emit — this try/catch only guards a SYNCHRONOUS listener throw (mirrors
      // emitProvisioned below / see ../lib/events.js).
      try {
        organizationEvents.emit('organization.created', { orgId: organization._id.toString(), planId: 'free' });
      } catch (err) {
        logger.warn('organizations: organization.created listener threw', { message: err?.message });
      }
      return { organization, membership };
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
 * Spec D5 — always-create: every successful signup provisions a workspace for the user.
 * The `autoCreate` config flag is a deprecated no-op (spec D5): signup always provisions
 * a workspace regardless of its value. Domain-matching is a hint mechanism only.
 *
 * Behaviour:
 * - **!enabled**: Creates a silent/default org named "{firstName}'s organization".
 * - **enabled**: Always calls createOrganizationForUser — user always gets an active workspace.
 *   If domainMatching is on, the user's email domain is not public, and an existing org matches,
 *   a `suggestedJoin: { orgId, orgName }` hint (name-only) is returned alongside the new org.
 *
 * signupGrant: createOrganizationForUser emits `organization.created` (#3952) exactly once per
 * real new org — no double-credit possible; billing's subscriber (billing.init.js) credits the
 * grant asynchronously, best-effort, never throwing back into this flow.
 *
 * @param {Object} user - The user object returned by UserService.create (with id, email, firstName, lastName).
 * @returns {Promise<{organization: Object|null, membership: Object|null, abilities: Array, emailVerificationRequired?: boolean, suggestedJoin?: {orgId: string, orgName: string}}>}
 *   An object containing the organization context for the signup response.
 *   `organization` and `membership` are null when `emailVerificationRequired` is true (mailer path).
 *   NEVER returns `organizationSetupRequired` or `pendingJoin`.
 */
const handleSignupOrganization = async (user) => {
  const orgConfig = config.organizations || {};

  // Email-verification policy gate (config.organizations.emailVerification.mode).
  // FAIL CLOSED: verification is bypassed ONLY for the explicit, permissive value
  // 'off'. Any other value — the default, a typo ('stict'), or wrong casing
  // ('STRICT') — keeps the strict gate, so a misconfiguration can never silently
  // auto-provision unverified users. 'off' → always auto-provision (same effective
  // path as a mailer-not-configured env). See module base config.
  const emailVerificationOff = (orgConfig.emailVerification?.mode ?? 'strict') === 'off';

  // When the policy is NOT 'off' and the mailer is configured, require email
  // verification before any org provisioning.
  if (!emailVerificationOff && mailer.isConfigured() && !user.emailVerified) {
    return {
      organization: null,
      membership: null,
      abilities: [],
      emailVerificationRequired: true,
    };
  }

  // A4: Idempotent convergence guard — retry-safe provisioning.
  // If the user already has an active membership (e.g. partial failure on a previous signup
  // attempt that succeeded at the DB layer but threw before returning), converge to that
  // existing workspace WITHOUT calling createOrganizationForUser again. This prevents:
  //   - Duplicate workspaces on retried signups
  //   - Double-crediting signupGrant (which lives inside createOrganizationForUser)
  // Canonical lookup: MembershipRepository.findOne with userId + ACTIVE status —
  // same pattern as autoSetCurrentOrganization and membership service active checks.
  // MembershipRepository.defaultPopulate includes organizationId, so membership.organizationId
  // is the full org document after the query.
  // Shared result builder — all three signup exit-paths return the same {organization,membership,abilities} shape.
  /**
   * Build the signup organization payload with serialized abilities.
   * @param {Object} organization - Organization document.
   * @param {Object} membership - Membership document.
   * @returns {Promise<{organization: Object, membership: Object, abilities: Array}>}
   */
  const buildResult = async (organization, membership) => ({
    organization,
    membership,
    abilities: serializeAbilities(await policy.defineAbilityFor(user, membership)),
  });

  /**
   * Fire-and-forget `organization.provisioned` notification (#3844) — called on every
   * exit path that returns a real organization (fresh create AND the A4 convergence
   * retry; consumers must be idempotent, so a double-fire is harmless by design).
   * The try/catch only guards SYNCHRONOUS listener throws — `EventEmitter.emit` is
   * synchronous; async listeners own their own guards (see ../lib/events.js).
   * @param {Object} organization - The provisioned (or converged-to) organization document.
   * @returns {void}
   */
  const emitProvisioned = (organization) => {
    if (!organization) return;
    try {
      organizationEvents.emit('organization.provisioned', {
        userId: String(user.id || user._id),
        organizationId: String(organization._id || organization.id),
      });
    } catch (err) {
      logger.warn('organizations: organization.provisioned listener threw', { message: err?.message });
    }
  };

  const userId = user.id || user._id;
  const existingMembership = await MembershipRepository.findOne({ userId, status: MEMBERSHIP_STATUSES.ACTIVE });
  if (existingMembership) {
    // organizationId is populated (name+slug+_id) via MembershipRepository.findOne defaultPopulate — trusted shape, same contract as autoSetCurrentOrganization
    const existingOrg = existingMembership.organizationId;
    emitProvisioned(existingOrg);
    return buildResult(existingOrg, existingMembership);
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

    emitProvisioned(organization);
    return buildResult(organization, membership);
  }

  // Case 2: Organizations enabled — always provision a workspace for the user.
  // config.organizations.autoCreate is a deprecated no-op (spec D5): signup always provisions
  // a workspace regardless of its value.
  //
  // normalizeEmailDomain (A1): single canonical path — lowercased/trimmed, null-safe.
  // Returns null on malformed email; the isCorporateDomain Boolean guard below excludes null.
  const domain = normalizeEmailDomain(user.email);
  const publicDomains = orgConfig.publicDomains || [];
  // isPublicDomain covers the hardcoded public-provider list; publicDomains covers project-level overrides.
  // domain is either a lowercased non-empty string or null — no defensive ?. needed here.
  const domainIsPublic = isPublicDomain(domain) || publicDomains.includes(domain ?? '');
  // True when domain-matching is active AND the domain belongs to a corporate (non-public) email.
  // domain is null only on malformed email (normalizeEmailDomain returns null) — treat as non-corporate.
  const isCorporateDomain = Boolean(domain) && orgConfig.domainMatching && !domainIsPublic;

  // Domain matching: when on, non-public domain, and an existing org matches → suggestedJoin hint.
  // The user still always gets their own new workspace (no join-request, no pendingJoin).
  let suggestedJoin;
  if (isCorporateDomain) {
    const existingOrgs = await OrganizationsRepository.list({ domain });
    if (existingOrgs.length > 0) {
      // Return name-only hint — no size/domain/membership/plan disclosure
      const matched = existingOrgs[0];
      suggestedJoin = {
        orgId: (matched._id || matched.id).toString(),
        orgName: matched.name,
      };
    }
  }

  // Derive org name/slug: use domain-based name only when domainMatching is on AND
  // the domain is corporate (non-public). Otherwise fall back to a personal workspace name.
  // This preserves the original naming convention from the autoCreate:true/domainMatching paths.
  let name;
  let slug;
  if (isCorporateDomain) {
    name = nameFromDomain(domain);
    slug = await generateSlugFromDomain(domain);
  } else {
    const firstName = user.firstName || 'User';
    name = `${firstName}'s organization`;
    slug = await generateOrganizationSlug(firstName, user.lastName || '');
  }

  const { organization, membership } = await createOrganizationForUser({
    name,
    slug,
    domain: isCorporateDomain ? domain : '',
    user,
  });

  emitProvisioned(organization);
  return {
    ...(await buildResult(organization, membership)),
    ...(suggestedJoin ? { suggestedJoin } : {}),
  };
};

export default {
  handleSignupOrganization,
  nameFromDomain,
  generateSlugFromDomain,
  createOrganizationForUser,
};
