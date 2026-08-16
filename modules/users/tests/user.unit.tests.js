/**
 * Module dependencies.
 */
import schema from '../models/users.schema.js';

/**
 * Unit tests
 */
describe('User unit tests:', () => {
  let user;

  beforeEach(() => {
    user = {
      firstName: 'Full',
      lastName: 'Name',
      email: 'test@test.com',
      password: 'M3@n.jsI$Aw3$0m3',
      provider: 'local',
    };
  });

  describe('Schema', () => {
    test('should be valid a user example without problems', (done) => {
      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should accept an empty optional firstName', (done) => {
      user.firstName = '';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      expect(result.data.firstName).toBe('');
      done();
    });

    test('should accept an undefined firstName and default it to an empty string', (done) => {
      delete user.firstName;

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      expect(result.data.firstName).toBe('');
      done();
    });

    test('should reject a firstName containing digits via the names refinement', (done) => {
      user.firstName = 'Invalid1';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should be able to accept a user with valid roles without problems', (done) => {
      user.roles = ['user', 'admin'];

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should be able to show an error when trying a user without a role', (done) => {
      user.roles = [];

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should be able to show an error when trying to update an existing user with a invalid role', (done) => {
      user.roles = ['invalid-user-role-enum'];

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });
  });

  describe('Password Validation Tests', () => {
    test('should validate when the password strength passes - "P-@-$-$-w-0-r-d-!"', (done) => {
      user.password = 'P-@-$-$-w-0-r-d-!';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should validate when the password is undefined', (done) => {
      user.password = undefined;

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should allow a difficult password with a score of 4 with zxcvbn- "WeAreOpenSource"', (done) => {
      user.password = 'Open-Source Stack Solution For WeAreOpenSource Applications';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should allow a password with a score of 3 with zxcvbn- "AreOpenSource"', (done) => {
      user.password = 'AreOpenSource';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should not allow a password with a score of 2 with zxcvbn- "OpenSource"', (done) => {
      user.password = 'OpenSource';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow a simple password with a score of 1 with zxcvbn- "Source"', (done) => {
      user.password = 'Source';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow this simple password - "P@$$w0rd!"', (done) => {
      user.password = 'P@$$w0rd!';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow a password smaller than 8 characters long.', (done) => {
      user.password = ')!/uLT';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow a password greater than 128 characters long.', (done) => {
      user.password =
        ')!/uLT="lh&:`6X!]|15o!$!TJf,.13l?vG].-j],lFPe/QhwN#{Z<[*1nX@n1^?WW-%_.*D)m$toB+N7z}kcN#B_d(f41h%w@0F!]igtSQ1gl~6sEV&r~}~1ub>If1c+';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow a forbidden password.', (done) => {
      user.password = 'azertyui'; // in config.zxcvbn.forbiddenPasswords

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow a password with 3 or more repeating characters - "P@$$w0rd!!!"', (done) => {
      user.password = 'P@$$w0rd!!!';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });
  });

  describe('E-mail Validation Tests', () => {
    test('should not allow invalid email address - "123"', (done) => {
      user.email = '123';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow invalid email address - "123@123@123"', (done) => {
      user.email = '123@123@123';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow invalid email address - "123.com"', (done) => {
      user.email = '123.com';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow invalid email address - "@123.com"', (done) => {
      user.email = '@123.com';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow invalid email address - "abc@abc@abc.com"', (done) => {
      user.email = 'abc@abc@abc.com';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow invalid characters in email address - "abc~@#$%^&*()ef=@abc.com"', (done) => {
      user.email = 'abc~@#$%^&*()ef=@abc.com';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow space characters in email address - "abc def@abc.com"', (done) => {
      user.email = 'abc def@abc.com';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    /* eslint no-useless-escape: 0 */
    test('should not allow doudble quote characters in email address - "abc"def@abc.com"', (done) => {
      user.email = 'abc"def@abc.com';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should not allow double dotted characters in email address - "abcdef@abc..com"', (done) => {
      user.email = 'abcdef@abc..com';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeDefined();
      done();
    });

    test('should allow single quote characters in email address - "abc\'def@abc.com"', (done) => {
      user.email = "abc'def@abc.com";

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should allow valid email address - "abc@abc.com"', (done) => {
      user.email = 'abc@abc.com';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should allow valid email address - "abc+def@abc.com"', (done) => {
      user.email = 'abc+def@abc.com';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should allow valid email address - "abc.def@abc.com"', (done) => {
      user.email = 'abc.def@abc.com';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should allow valid email address - "abc.def@abc.def.com"', (done) => {
      user.email = 'abc.def@abc.def.com';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should allow valid email address - "abc-def@abc.com"', (done) => {
      user.email = 'abc-def@abc.com';

      const result = schema.User.safeParse(user);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });
  });
});

/**
 * Signup attribution unit tests (epic #4002 / #4003)
 */
describe('Attribution (signup) unit tests:', () => {
  describe('Attribution schema', () => {
    test('should accept an attribution object with all fields set', (done) => {
      const attribution = {
        referrer: 'https://google.com',
        landingPath: '/pricing',
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'launch',
        utmTerm: 'saas',
        utmContent: 'ad1',
      };

      const result = schema.Attribution.safeParse(attribution);
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      expect(result.data).toEqual(attribution);
      done();
    });

    test('should accept an empty attribution object (all fields optional)', (done) => {
      const result = schema.Attribution.safeParse({});
      expect(typeof result).toBe('object');
      expect(result.error).toBeFalsy();
      done();
    });

    test('should trim whitespace on attribution string fields', (done) => {
      const result = schema.Attribution.safeParse({ referrer: '  https://google.com  ' });
      expect(result.error).toBeFalsy();
      expect(result.data.referrer).toBe('https://google.com');
      done();
    });

    test('should reject an unknown key via .strict()', (done) => {
      const result = schema.Attribution.safeParse({ referrer: 'https://google.com', evilKey: 'nope' });
      expect(result.error).toBeDefined();
      done();
    });

    test('should accept referrer at exactly the 2048-character cap', (done) => {
      const result = schema.Attribution.safeParse({ referrer: 'a'.repeat(2048) });
      expect(result.error).toBeFalsy();
      done();
    });

    test('should reject referrer longer than the 2048-character cap', (done) => {
      const result = schema.Attribution.safeParse({ referrer: 'a'.repeat(2049) });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject landingPath longer than the 2048-character cap', (done) => {
      const result = schema.Attribution.safeParse({ landingPath: 'a'.repeat(2049) });
      expect(result.error).toBeDefined();
      done();
    });

    test('should accept a utm field at exactly the 256-character cap', (done) => {
      const result = schema.Attribution.safeParse({ utmSource: 'a'.repeat(256) });
      expect(result.error).toBeFalsy();
      done();
    });

    test('should reject a utm field longer than the 256-character cap', (done) => {
      const result = schema.Attribution.safeParse({ utmSource: 'a'.repeat(257) });
      expect(result.error).toBeDefined();
      done();
    });
  });

  describe('User schema carries an optional attribution subdocument', () => {
    test('should accept a full user document with attribution set', (done) => {
      const result = schema.User.safeParse({
        firstName: 'Full',
        lastName: 'Name',
        email: 'test@test.com',
        password: 'M3@n.jsI$Aw3$0m3',
        provider: 'local',
        attribution: { utmSource: 'google', referrer: 'https://google.com' },
      });
      expect(result.error).toBeFalsy();
      expect(result.data.attribution).toEqual({ utmSource: 'google', referrer: 'https://google.com' });
      done();
    });

    test('should accept a full user document with attribution absent (backward compatible)', (done) => {
      const result = schema.User.safeParse({
        firstName: 'Full',
        lastName: 'Name',
        email: 'test@test.com',
        password: 'M3@n.jsI$Aw3$0m3',
        provider: 'local',
      });
      expect(result.error).toBeFalsy();
      expect(result.data.attribution).toBeUndefined();
      done();
    });
  });

  describe('SignupUser + attribution', () => {
    test('should accept a signup with a valid attribution object', (done) => {
      const result = schema.SignupUser.safeParse({ email: 'a@b.com', attribution: { utmSource: 'google' } });
      expect(result.error).toBeFalsy();
      expect(result.data.attribution).toEqual({ utmSource: 'google' });
      done();
    });

    test('should accept a signup with no attribution at all (backward compatible)', (done) => {
      const result = schema.SignupUser.safeParse({ email: 'a@b.com' });
      expect(result.error).toBeFalsy();
      expect(result.data.attribution).toBeUndefined();
      done();
    });

    test('should reject a signup whose attribution has an over-length field', (done) => {
      const result = schema.SignupUser.safeParse({ email: 'a@b.com', attribution: { utmSource: 'a'.repeat(257) } });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject a signup whose attribution carries an unknown key', (done) => {
      const result = schema.SignupUser.safeParse({ email: 'a@b.com', attribution: { evilKey: 'nope' } });
      expect(result.error).toBeDefined();
      done();
    });
  });

  describe('UserUpdate excludes attribution (server-set-once at signup)', () => {
    test('should silently strip an attribution field sent on a profile update, without erroring', (done) => {
      const result = schema.UserUpdate.safeParse({ firstName: 'A', attribution: { utmSource: 'hijack' } });
      expect(result.error).toBeFalsy();
      expect(result.data).not.toHaveProperty('attribution');
      done();
    });
  });
});
