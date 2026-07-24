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
     * to actually reward accepted referrals — this flag only controls WHO can see/
     * create invitations, not whether a reward is granted.
     */
    userFacing: false,
  },
};

export default config;
