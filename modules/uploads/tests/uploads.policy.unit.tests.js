/**
 * Module dependencies.
 */
import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';

/**
 * Upload read rules by kind: guests read only kinds with `guestRead: true`,
 * logged-in users read those plus their own / their organization's uploads.
 */
describe('Uploads policy unit tests:', () => {
  let config;
  let uploadAbilities;
  let uploadGuestAbilities;
  let createMongoAbility;
  let AbilityBuilder;
  let subject;
  let originalUploads;

  beforeAll(async () => {
    config = (await import('../../../config/index.js')).default;
    ({ uploadAbilities, uploadGuestAbilities } = await import('../policies/uploads.policy.js'));
    ({ createMongoAbility, AbilityBuilder, subject } = await import('@casl/ability'));
    originalUploads = config.uploads;
  });

  afterEach(() => {
    config.uploads = originalUploads;
  });

  const build = (define) => {
    const { can, cannot, build: done } = new AbilityBuilder(createMongoAbility);
    define({ can, cannot });
    return done();
  };
  const guest = () => build((b) => uploadGuestAbilities(b));
  const logged = (user, membership = null) => build((b) => uploadAbilities(user, membership, b));
  const upload = (metadata) => subject('Upload', { metadata });

  test('a guest reads a guestRead kind only', () => {
    const ability = guest();
    expect(ability.can('read', upload({ kind: 'avatar' }))).toBe(true);
    expect(ability.can('read', upload({ kind: 'privateTestKind' }))).toBe(false);
    expect(ability.can('read', upload({}))).toBe(false);
    expect(ability.can('delete', upload({ kind: 'avatar' }))).toBe(false);
  });

  test('guest kinds come only from object entries with guestRead === true', () => {
    config.uploads = {
      activated: true,
      sharp: { blur: 8 },
      open: { kind: 'open', guestRead: true },
      truthy: { kind: 'truthy', guestRead: 'yes' },
      closed: { kind: 'closed' },
    };
    const ability = guest();
    expect(ability.can('read', upload({ kind: 'open' }))).toBe(true);
    expect(ability.can('read', upload({ kind: 'truthy' }))).toBe(false);
    expect(ability.can('read', upload({ kind: 'closed' }))).toBe(false);
    expect(ability.can('read', upload({ kind: 'sharp' }))).toBe(false);
  });

  test('both the config key and the entry kind are guest-readable', () => {
    config.uploads = { profilePicture: { kind: 'picture', guestRead: true } };
    const ability = guest();
    expect(ability.can('read', upload({ kind: 'profilePicture' }))).toBe(true);
    expect(ability.can('read', upload({ kind: 'picture' }))).toBe(true);
  });

  test('a guestRead entry never exposes a kind a private entry also uses', () => {
    config.uploads = {
      invoice: { kind: 'invoice' },
      publicPhoto: { kind: 'invoice', guestRead: true },
      photo: { kind: 'photo', guestRead: true },
    };
    const ability = guest();
    expect(ability.can('read', upload({ kind: 'invoice' }))).toBe(false);
    expect(ability.can('read', upload({ kind: 'photo' }))).toBe(true);
  });

  test('a logged-in user reads guest kinds of others and only its own private kinds', () => {
    const ability = logged({ _id: 'u1', roles: ['user'] });
    expect(ability.can('read', upload({ kind: 'avatar', user: 'u2' }))).toBe(true);
    expect(ability.can('read', upload({ kind: 'privateTestKind', user: 'u1' }))).toBe(true);
    expect(ability.can('read', upload({ kind: 'privateTestKind', user: 'u2' }))).toBe(false);
  });

  test('an organization member reads its organization private kinds, not another organization ones', () => {
    const ability = logged({ _id: 'u1', roles: ['user'] }, { organizationId: 'orgA' });
    expect(ability.can('read', upload({ kind: 'privateTestKind', organizationId: 'orgA' }))).toBe(true);
    expect(ability.can('read', upload({ kind: 'privateTestKind', organizationId: 'orgB' }))).toBe(false);
    expect(ability.can('read', upload({ kind: 'avatar', organizationId: 'orgB' }))).toBe(true);
  });
});
