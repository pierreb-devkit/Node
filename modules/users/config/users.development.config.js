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
  users: {
    /**
     * Config-declared product email sequences (#4163) — e.g. a day-7 /
     * day-21 onboarding series. Default `{}`: the cron
     * (`modules/users/crons/users.emailSequences.js`) does nothing until a
     * downstream project declares at least one sequence.
     *
     * Shape: { <name>: { startAt: Date|ISOString, kind: 'onboarding'|'news',
     *   from?: string, replyTo?: string|string[], steps: [{ day: number,
     *   template: string, subject: string }] } }
     *
     * - `startAt` is the cutoff below: only users whose `createdAt >= startAt`
     *   are ever considered (existing users don't retroactively join a
     *   sequence declared after they signed up).
     * - `day` is the account age in whole UTC calendar days at which that
     *   step fires. A missed day (cron didn't run, or was added later) is
     *   NOT caught up — the step simply never fires for that user.
     * - `kind`/`from`/`replyTo`/`template`/`subject` are passed straight
     *   through to `UserService.sendProductMail`, including its existing
     *   opt-out and `emailVerified` checks.
     *
     * See `modules/users/crons/README.md` for the Kubernetes CronJob example.
     */
    emailSequences: {},
  },
};

export default config;
