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
};

export default config;
