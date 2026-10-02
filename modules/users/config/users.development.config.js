const config = {
  audit: {
    routeTypeMap: {
      users: 'User',
    },
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
        'emailVerified',
        'currentOrganization',
        'lastLoginAt',
        'complementary',
        'terms',
        // #4162 — read-exposed like `complementary` (both self-editable AND
        // reflected back), unlike `attribution`'s write-never/read-hidden pair.
        'emailPreferences',
      ],
      update: ['firstName', 'lastName', 'bio', 'position', 'email', 'avatar', 'complementary', 'emailPreferences'],
      updateAdmin: ['firstName', 'lastName', 'bio', 'position', 'email', 'avatar', 'roles', 'complementary'],
      recover: ['password', 'resetPasswordToken', 'resetPasswordExpires', 'emailVerified', 'emailVerificationToken', 'emailVerificationExpires', 'additionalProvidersData'],
      roles: ['user', 'admin'],
    },
  },
};

export default config;
