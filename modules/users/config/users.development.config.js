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
  rateLimit: {
    // POST /api/users/unsubscribe/:token (#4162) — public, token-authorized
    // (RFC 8058) one-click unsubscribe. MUST NOT share `limiters.auth`: these
    // POSTs come from mail providers' shared egress IPs, so auth's 10/15min-per-IP
    // cap would lock out genuine recipients after a handful of sends from the
    // same provider. Lives in this base layer so the profile is present — and
    // the limiter active — under EVERY env, not only the literal `production`.
    // A generous, deliberately-kept-generous cap is applied as an override in
    // config/defaults/production.config.js (unlike the other profiles, prod is
    // NOT stricter here — the shared-egress-IP problem is a production problem).
    unsubscribe: {
      windowMs: 60 * 1000, // 1 min
      max: 1200, // lenient in dev
      message: { message: 'Too many requests, please try again later.' },
      standardHeaders: true,
      legacyHeaders: false,
    },
  },
};

export default config;
