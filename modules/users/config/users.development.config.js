const config = {
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
        'lastLoginAt',
        'complementary',
        'terms',
      ],
      update: ['firstName', 'lastName', 'bio', 'position', 'email', 'avatar', 'currentOrganization', 'complementary'],
      updateAdmin: ['firstName', 'lastName', 'bio', 'position', 'email', 'avatar', 'roles', 'complementary'],
      recover: ['password', 'resetPasswordToken', 'resetPasswordExpires', 'emailVerified', 'emailVerificationToken', 'emailVerificationExpires'],
      roles: ['user', 'admin'],
    },
  },
};

export default config;
