const config = {
  // Audit: label /api/invitations* routes as the Invitation target type (matches the
  // canonical mount; the /api/auth/invitations alias still resolves under `auth`→User).
  audit: {
    routeTypeMap: {
      invitations: 'Invitation',
    },
  },
  // Invite-specific knob. Kept under the `sign` namespace (deep-merged with auth's
  // sign.{in,up,cap}) so the service read `config.sign.inviteExpiresInDays` is unchanged.
  sign: {
    inviteExpiresInDays: 14, // signup invite link validity (days)
  },
  invitations: {
    /**
     * User-facing referral invitations (#3945) — stack default OFF, preserves
     * existing deployments' admin-only behavior. When true, invitationAbilities
     * grants any authenticated user `create` on Invitation (their own referral
     * link) and `read` (scoped server-side to invitations THEY sent — see
     * InvitationsService.list(), #3833); platform admins keep `manage all`
     * regardless. Pair with `billing.referral.enabled` (billing.development.config.js)
     * to actually reward accepted referrals.
     *
     * #3981: ALSO controls whether the signup flow claims/finalizes a presented
     * invite token while public signup is OPEN (`config.sign.up: true`) — the
     * open-signup hole documented in this module's README point 3. With signup
     * CLOSED, a valid invite always claims/finalizes regardless of this flag (it is
     * what opens the gate). Exposed read-only via `GET /api/auth/config`
     * (`invitations.userFacing`) so the frontend can gate referral UI on it.
     */
    userFacing: false,
  },
  // #3945: POST /api/invitations already had no rate limiter under admin-only access
  // (a trusted caller); with `invitations.userFacing` able to widen `create` to any
  // authenticated user, an unbounded create is a DB-bloat / outbound-email-spam
  // abuse surface (mirrors the verify/:token route, which already uses `limiters.auth`).
  // Lives in this base layer so the profile is present — and the limiter active —
  // under EVERY env, not only the literal `production`; a missing profile means a
  // no-op limiter. Stricter cap applied in config/defaults/production.config.js.
  rateLimit: {
    invitationsCreate: {
      windowMs: 15 * 60 * 1000, // 15 min
      max: 200, // lenient in dev; production overrides to a stricter cap
      message: { message: 'Too many requests, please try again later.' },
      standardHeaders: true,
      legacyHeaders: false,
    },
  },
};

export default config;
