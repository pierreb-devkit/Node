/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import mongoose from 'mongoose';

/**
 * Unit tests proving the org-creation seam (`../lib/events.js`, the generic
 * organizationEvents singleton) stays isolated from whatever a consumer
 * registers on it (rule 2, Node#4020/#4138).
 *
 * Every other test file covering this seam (organizations.emailVerification,
 * organizations.service.signup, organizations.service.silent.catch) mocks
 * `../lib/events.js` as a bare double (`{ emit: jest.fn(), on: jest.fn() }`) —
 * a spy that never runs a registered listener. That is the right choice for
 * those files (they isolate the seam FROM their own assertions), but it also
 * means nothing today exercises the REAL EventEmitter, so nothing proves that
 * a hook a consumer actually registers — generically, via `.on()`, never a
 * consumer module imported by name — leaves the outcome of the two
 * org-creation call sites unchanged. This file uses the real singleton
 * (deliberately does NOT mock `../lib/events.js`) to close that gap, mirroring
 * the same real-EventEmitter pattern already used by billing.events.unit.tests.js.
 */
describe('organizations event-seam isolation (extra registered hook):', () => {
  let OrganizationsService;
  let OrganizationsCrudService;
  let organizationEvents;
  let fakeOrg;
  let fakeMembership;

  const buildUser = () => ({
    id: new mongoose.Types.ObjectId().toString(),
    email: 'owner@example.com',
    firstName: 'Owner',
    lastName: 'User',
    emailVerified: true,
  });

  beforeEach(async () => {
    jest.resetModules();

    fakeOrg = { _id: new mongoose.Types.ObjectId(), name: 'Test', toJSON: () => ({ name: 'Test' }) };
    fakeMembership = { _id: new mongoose.Types.ObjectId(), role: 'owner' };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { organizations: { enabled: false }, app: { title: 'Test' } },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    }));

    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
      default: { isConfigured: jest.fn().mockReturnValue(false), sendMail: jest.fn().mockResolvedValue(null) },
    }));

    jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
      default: { defineAbilityFor: jest.fn().mockResolvedValue({ rules: [] }) },
    }));

    jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
      default: jest.fn().mockReturnValue([]),
    }));

    jest.unstable_mockModule('../helpers/organizations.slug.js', () => ({
      slugify: (str) => str.toLowerCase().replace(/\s+/g, '-'),
      generateOrganizationSlug: jest.fn().mockResolvedValue('test-slug'),
    }));

    jest.unstable_mockModule('../../users/services/users.service.js', () => ({
      default: { updateById: jest.fn().mockResolvedValue({}) },
    }));

    jest.unstable_mockModule('../repositories/organizations.repository.js', () => ({
      default: {
        create: jest.fn().mockResolvedValue(fakeOrg),
        exists: jest.fn().mockResolvedValue(false),
        findOne: jest.fn().mockResolvedValue(null),
        list: jest.fn().mockResolvedValue([]),
        get: jest.fn(),
        remove: jest.fn().mockResolvedValue({}),
      },
    }));

    jest.unstable_mockModule('../repositories/organizations.membership.repository.js', () => ({
      default: {
        create: jest.fn().mockResolvedValue(fakeMembership),
        findOne: jest.fn().mockResolvedValue(null),
        list: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({}),
      },
    }));

    // Deliberately NOT mocking ../lib/events.js — see file docblock.
    ({ default: OrganizationsService } = await import('../services/organizations.service.js'));
    ({ default: OrganizationsCrudService } = await import('../services/organizations.crud.service.js'));
    ({ default: organizationEvents } = await import('../lib/events.js'));
  });

  afterEach(() => {
    organizationEvents.removeAllListeners('organization.created');
    organizationEvents.removeAllListeners('organization.provisioned');
    jest.restoreAllMocks();
  });

  test("an extra listener on organization.provisioned observes handleSignupOrganization without changing its result", async () => {
    const extraHook = jest.fn();
    organizationEvents.on('organization.provisioned', extraHook);

    const user = buildUser();
    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(result.organization).toBe(fakeOrg);
    expect(result.membership).toBe(fakeMembership);
    expect(extraHook).toHaveBeenCalledTimes(1);
    expect(extraHook).toHaveBeenCalledWith({
      userId: String(user.id),
      organizationId: String(fakeOrg._id),
    });
  });

  test('a synchronously-throwing extra listener on organization.created does not break OrganizationsCrudService.create', async () => {
    const throwingHook = jest.fn(() => {
      throw new Error('a mis-behaved consumer hook blew up');
    });
    organizationEvents.on('organization.created', throwingHook);

    const user = buildUser();
    const result = await OrganizationsCrudService.create({ name: 'Acme' }, user);

    expect(result).toBe(fakeOrg);
    expect(throwingHook).toHaveBeenCalledTimes(1);
  });

  test('a synchronously-throwing extra listener on organization.provisioned does not break handleSignupOrganization', async () => {
    const throwingHook = jest.fn(() => {
      throw new Error('a mis-behaved consumer hook blew up');
    });
    organizationEvents.on('organization.provisioned', throwingHook);

    const user = buildUser();
    const result = await OrganizationsService.handleSignupOrganization(user);

    expect(result.organization).toBe(fakeOrg);
    expect(result.membership).toBe(fakeMembership);
    expect(throwingHook).toHaveBeenCalledTimes(1);
  });
});
