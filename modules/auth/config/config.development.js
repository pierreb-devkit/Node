const config = {
  auth: {
    lockout: {
      maxAttempts: 5, // lock account after N consecutive failed login attempts
      lockDuration: 30, // lock duration in minutes
    },
  },
  sign: {
    in: true, // disable signin
    up: true, // disable signup
  },
  // jwt is for token authentication
  jwt: {
    secret: 'WaosSecretKeyExampleToChnageAbsolutely', // secret for hash
    expiresIn: 7 * 24 * 60 * 60, // token expire in x sec
  },
  mailer: {
    from: 'DEVKIT_NODE_mailer_from',
    options: {
      service: 'DEVKIT_NODE_mailer_options_service',
      auth: {
        user: 'DEVKIT_NODE_mailer_options_auth_user',
        pass: 'DEVKIT_NODE_mailer_options_auth_pass',
      },
    },
  },
  oAuth: {
    google: {
      // google console / api & service / identifier
      clientID: null,
      clientSecret: null,
      callbackURL: null,
    },
    apple: {
      clientID: null, // developer.apple.com service identifier
      teamID: null, // developer.apple.com team identifier
      keyID: null, // developer.apple.com private key identifier
      callbackURL: null,
      privateKeyLocation: null,
    },
  },
  // zxcvbn is used to manage password security
  zxcvbn: {
    forbiddenPasswords: ['12345678', 'azertyui', 'qwertyui', 'azertyuiop', 'qwertyuiop'], // passwords forbidden
    minSize: 8, // min password size
    maxSize: 126, // max password size
    minimumScore: 3, // min password complexity score
  },
  // Data filter whitelist & Blacklist
  blacklists: {},
  whitelists: {
    users: {
      default: [
        '_id',
        'id',
        'firstName',
        'lastName',
        'bio',
        'position',
        'email',
        'avatar',
        'roles',
        'provider',
        'updatedAt',
        'createdAt',
        'resetPasswordToken',
        'resetPasswordExpires',
        'emailVerified',
        'currentOrganization',
        'complementary',
        'terms',
      ],
      update: ['firstName', 'lastName', 'bio', 'position', 'email', 'avatar', 'currentOrganization', 'complementary'],
      updateAdmin: ['firstName', 'lastName', 'bio', 'position', 'email', 'avatar', 'roles', 'complementary'],
      recover: ['password', 'resetPasswordToken', 'resetPasswordExpires', 'emailVerified', 'emailVerificationToken', 'emailVerificationExpires'],
      roles: ['user', 'admin'],
    },
  },
  seedDB: {
    seed: true,
    options: {
      logResults: true,
      seedTasks: [
        {
          title: 'title1',
          description: 'do something about something else',
        },
        {
          title: 'title2',
          description: 'do something about something else',
        },
      ],
      seedUser: {
        provider: 'local',
        email: 'seeduser@localhost.com',
        firstName: 'User',
        lastName: 'Local',
        displayName: 'User Local',
        roles: ['user'],
      },
      seedAdmin: {
        provider: 'local',
        email: 'seedadmin@localhost.com',
        firstName: 'Admin',
        lastName: 'Local',
        displayName: 'Admin Local',
        roles: ['user', 'admin'],
      },
    },
  },
};

export default config;
