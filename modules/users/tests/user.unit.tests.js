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

    test('should be able to show an error when trying a schema without first name', (done) => {
      user.firstName = '';

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
