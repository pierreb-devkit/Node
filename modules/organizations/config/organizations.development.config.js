const config = {
  organizations: {
    enabled: true, // false → B2C mode, organizations invisible
    autoCreate: true, // automatically create/join orgs at signup
    domainMatching: true, // match users to existing orgs by email domain
    roles: ['owner', 'admin', 'member'],
    roleDescriptions: {
      owner: 'Full control — manage organization settings, members, roles, and billing.',
      admin: 'Approve join requests, invite and remove members. Cannot change roles or delete the organization.',
      member: 'Access organization resources. Read-only on settings and member list.',
    },
    publicDomains: [
      'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.fr',
      'hotmail.com', 'hotmail.fr', 'outlook.com', 'outlook.fr',
      'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
      'mac.com', 'protonmail.com', 'proton.me', 'mail.com',
      'zoho.com', 'yandex.com', 'gmx.com', 'gmx.fr',
      'free.fr', 'orange.fr', 'sfr.fr', 'laposte.net',
      'wanadoo.fr', 'bbox.fr',
    ],
  },
};

export default config;
