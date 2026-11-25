# Invitations module

Optional, standalone module owning the **invitation** concept: invite a contact by email →
single-use token + `invitedBy` + beta-gate eligibility. Depends on `auth` (via the
`registerSignupEligibility` hook — `auth` never imports this module) and, one way, on
`organizations` (org-targeted invites below — `organizations` never imports this module).

- Routes: `/api/invitations` (admin list/create + revoke via `DELETE /:invitationId` — no
  update endpoint) + `/api/invitations/verify/:token` (public) + the organization routes below.
- Model `Invitation` → collection `invitations` (`email`, `token`, `invitedBy`, `status`,
  `expiresAt`, `consumingAt`, `acceptedAt`, `acceptedUserId`, `revokedAt`, `usedAt`,
  `organizationId`, `role`).
- Signup gate: two-phase claim/finalize (`consumingAt` CAS + lazy 15-min stale sweep),
  email pin, soft revoke. See `services/invitations.service.js`.

## Organization invites

An invitation can carry an **organization target**: `organizationId` + `role` (both `null`
for a platform / referral invite, which behaves exactly as before). An org owner or admin
invites an email that has no account yet; the email (`org-invite` template: inviter name,
org name, brand) links to `/signup?inviteToken=…`.

- Routes, mounted under the org (`:organizationId` loaded by the organizations module):
  `GET|POST /api/organizations/:organizationId/invitations`,
  `DELETE /api/organizations/:organizationId/invitations/:invitationId`,
  `POST /api/organizations/:organizationId/invitations/:invitationId/resend`.
- Rights: an ACTIVE owner/admin of that org, or a platform admin — independent of
  `invitations.userFacing`. Any owner/admin lists, resends and revokes every pending invite of
  the org (not only their own). Another org's invite (or a platform invite) on these routes → 404.
  The token is never returned here; the invitee gets it by email only.
- Role: defaults to `member`; only an owner or a platform admin may invite an `admin`/`owner`
  (the same ceiling as adding a member — `organizations/lib/organizations.rights.js`).
- Create keeps every platform guard: an existing account → 422 (add them as a member instead),
  self-invite → 422, one live invite per email **platform-wide** → 409, `maxLifetime`
  (counts org invites too), `rateLimit.invitationsCreate` (also on resend). No per-org cap.
- `GET /api/invitations/verify/:token` also returns `organization: { name }` for an org invite.
- Not a referral: an org invite never stamps `referredBy`, earns no referral reward (the billing
  rule source `expectedGrantKeys` drops it — listener and reconcile cron alike) and never shows
  in a user's own Referrals list (`GET /api/invitations` for a non-admin = `organizationId: null`).
- `invitation.accepted` carries `organizationId` + `role` (`null` for a platform invite).
- Org removal revokes the org's pending invites (`onOrganizationRemoved`, `invitations.init.js`).

Signup join: a person signing up through an org invite JOINS that organization as an ACTIVE
member with the invited role (`addedBy` = the inviter): no personal workspace, no signup grant,
current organization = the org. An existing account is added with the organizations
`addMember` flow instead (the invitee accepts).

- The signup gate always CLAIMS an org invite token (two-phase, E2), on closed AND open signup,
  whatever `invitations.userFacing` says; it opens a closed/capped signup and counts against the
  cap. On open signup a lost claim race still downgrades to a plain signup (never blocks it).
- OAuth resolves the invite by the provider-verified email (E7). On open signup only an org
  invite is honored there; a platform invite is left untouched, as before.
- The join itself happens in organizations' `handleSignupOrganization`, which asks the resolver
  this module registers (`registerSignupMembershipResolver`, `organizations.signup.registry.js`):
  the org invite this user accepted (verifyEmail, OAuth), else the one claimed in flight for their
  email (local signup — the invite is finalized after provisioning). An unclaimed pending invite
  never counts.
- Never auto-verify (E6): with strict verification + a mailer, nothing joins at signup; the join
  happens at `verifyEmail`. With verification `off` or no mailer, the join happens at signup.
- Org removed or invite revoked before the join → the usual personal workspace.

## The referral substrate (what the reward grants hook into)

The reward **seam** ships, and the STANDARD reward logic now ships too (#3842 — the
config-gated grant listener in `billing.init.js`, default OFF; product gates in #3833).
Two primitives are written on every accepted invite — on **both** the token-signup path and
the OAuth path (shared `accept(invite, userId)`):

1. **`user.referredBy`** — the inviter's userId, stamped server-side on the created account
   (never client-writable: absent from the Zod schemas + update whitelists; written via the
   raw repository path only). This is the durable referral edge — it supports
   *compute-on-read* forever, even if an event was missed.
2. **`invitation.accepted` event** — emitted by this module's singleton
   (`lib/invitations.events.js`):

   ```js
   invitationEvents.emit('invitation.accepted', {
     invitationId,    // ← natural IDEMPOTENCY KEY for any grant
     email,           // invitee email (lowercased)
     invitedBy,       // inviter userId — the admin API always stamps the creating admin;
                      // null only for actor-less inserts (legacy/scripted data)
     acceptedUserId,  // the REFEREE — double-sided rewards need no schema change
     organizationId,  // set for an ORGANIZATION invite (not a referral) — null otherwise
     role,            // role granted in organizationId — null otherwise
   });
   ```

Both the **referrer** (`invitedBy`) and the **referee** (`acceptedUserId`) are identifiable
from the payload — reward either side, or both.

## Implementing rewards — two architectures (pick per product)

> **⚠️ Downstream rule first:** stack files (`modules/billing/**`, this module, `lib/`)
> stay **byte-identical** downstream — the drift gate blocks edits and `/update-stack`
> would clobber them. A downstream project therefore NEVER wires a listener by editing
> `billing.init.js`. The two sanctioned channels are: **config** (deep-merged
> `{project}.config.js` — for the standard reward below) and **project-only modules**
> (glob-discovered, e.g. `modules/<project>-rewards/` — for custom logic).

### A. Standard grant — ships IN the stack, downstream enables it by CONFIG

**Shipped (#3842).** The grant listener is implemented **once, upstream, in
`billing.init.js`** (it replaced the P8a no-op seam), entirely gated by config:

```js
// modules/billing/config/billing.development.config.js — stack default: OFF (shipped)
billing: { referral: { enabled: false, referrerUnits: 0, refereeUnits: 0, expiryDays: 365 } }
```

```js
// a downstream's config/defaults/{project}.config.js — the ONLY thing it touches:
billing: { referral: { enabled: true, referrerUnits: 500, refereeUnits: 200 } }
```

The listener delegates to `modules/billing/services/billing.referral.service.js`
(`grantForInvitation`), which:

- maps the **user-scoped** referral actors onto the **organization-scoped** billing
  ledger: each side credits the actor's `currentOrganization` (active-membership
  fallback) on the `BillingExtraBalance` ledger via `creditGrant` — `kind:'topup'`,
  `source:'referral'`, expiry from `billing.referral.expiryDays` (same sweep as pack
  credits, `crons/billing.extrasExpiration.js`);
- skips the referrer grant when `invitedBy` is null, and when
  `invitedBy === acceptedUserId` (cheap self-referral floor — the full guard is #3833);
- when an actor has no organization yet (mailer-configured signups provision the org at
  email verification, AFTER the event), the side is left to the reconcile cron;
- is **self-guarded**: the listener wraps everything in try/catch + `logger.error` — an
  async rejection must never escape (`EventEmitter.emit` is synchronous; the emit-site
  try/catch only covers sync throws, see `lib/invitations.events.js`).

Rules that make this production-grade (both shipped):

- **Idempotency** — every grant is keyed `referral:${invitationId}:referrer|referee`
  (`ledger.refId`): a replayed/duplicate event can never double-credit. The ledger is an
  embedded array, so enforcement is the house atomic
  `'ledger.refId': { $ne: key }` findOneAndUpdate guard (same mechanism as
  creditPack/debit), supported by the sparse `{ 'ledger.refId': 1, 'ledger.source': 1 }`
  index.
- **Reconcile cron (safety net)** — `crons/billing.referralReconcile.js` (k8s CronJob,
  house cron pattern): EventEmitter is in-process fire-and-forget; a crash between
  accept and grant loses the event. The cron scans ALL `invitations
  { status:'accepted' }` vs the grant ledger keys and back-fills misses idempotently
  (it scans all accepted, not just `invitedBy:{$ne:null}` — referee grants exist even
  when `invitedBy` is null, so a referrer-only scan would miss referee-only back-fills).
  The listener is latency; the cron is truth.

### A'. Custom rewards (cashback, Stripe credit note, partner webhook) — project-only module

When a downstream needs logic beyond units (cashback %, coupons, external payouts), it
ships its OWN module — glob discovery means zero stack edits:

```js
// modules/{project}-rewards/{project}-rewards.init.js   (downstream-only module)
import invitationEvents from '../invitations/lib/invitations.events.js';

export default async () => {
  invitationEvents.on('invitation.accepted', async (payload) => {
    try { await myCashbackFlow(payload); }                 // same idempotency key rule
    catch (err) { logger.error('[rewards] cashback failed', { err: err?.message, stack: err?.stack }); }
  });
};
```

Multiple listeners on the shared emitter are fine (the stack's standard grant + a
project's custom one can coexist); each owns its own failure handling.

### B. Compute-on-read (no writes, simplest)

Derive the reward at quota/entitlement time instead of granting:

```js
// illustrative — a countAccepted helper does not exist yet (add it, or an equivalent query)
const accepted = await InvitationRepository.countAccepted({ invitedBy: userId });
const bonus = accepted * config.billing.referral.referrerUnits;
```

Always consistent (survives missed events), zero ledger. Costs a query on the hot
entitlement path (index `invitations.invitedBy` first — the field this query hits;
`users.referredBy` gets its own index only if referral lists query it),
and hard to cap/expire/audit ("when was this credited?"). Good for simple boosts
(e.g. "+1 project slot per referral"), wrong for money-shaped balances.

> Recommended: **A + reconcile cron** for credit/cashback economies; **B** for static
> entitlement boosts. The substrate supports both simultaneously.

## Gates before shipping rewards (#3833 — status)

1. **Scope the list — SHIPPED (#3833)**: `GET /api/invitations` is role-keyed in the
   service: admins read the platform-global list; any other caller reads only the
   invitations they sent (`invitedBy`-scoped — the `{ invitedBy: 1 }` index covers
   it; a caller with no resolvable id gets `[]`, never the `invitedBy:null`
   admin-created rows). **CASL widening — SHIPPED (#3945), config-gated**:
   `config.invitations.userFacing` (stack default OFF — preserves existing
   deployments) flips `invitationAbilities` to grant any authenticated user
   `create` + `read` on `Invitation` (still TYPE-level; the real invitedBy-scoping
   is the service list() above — see `invitations.policy.js` for why no
   document-subject is registered). `resend` stays explicitly admin-gated in the
   controller regardless of the flag (the POST→`create` method-mapping collision
   with new-invitation creation). Also shipped: an `invitation_redeemed` analytics
   event on accept, invite/referral properties on `user_signed_up`, and a
   best-effort referrer notification email (`referral-reward-earned` template)
   when a referral reward is freshly credited.
2. **Self-referral guard — SHIPPED (#3833), with a known residual**: `create()`
   rejects 422 "You cannot invite yourself" when the invitee email equals the
   inviter's own, before the E9 registered-email check. The grant-side floor
   (`expectedGrantKeys` drops the referrer side when
   `invitedBy === acceptedUserId` — pinned in the billing unit tests) covers
   same-account pairs only. **Alias/variant self-invites (a second personal email
   → a separate account) are NOT prevented** — accepted residual risk; revisit
   (fraud review / email-normalization dedup) before any paid-rewards launch.
3. **Open-signup hole — CLOSED behind `invitations.userFacing` (#3981)**: claim/finalize
   are gated on `!config.sign.up`, EXCEPT when `config.invitations.userFacing` is `true`
   — then a presented, valid (email-pinned, unexpired, single-use) token still claims
   and finalizes even on an open-signup deployment, so `invitation.accepted` +
   `invitation_redeemed` + the referral grant fire exactly as on closed signup. With
   `userFacing: false` (the default) the original invariant holds unchanged: a
   presented token on open signup is *resolved* but never *claimed/finalized*, so
   enabling `billing.referral` there is still a silent no-op. `GET /api/auth/config`
   now exposes `invitations.userFacing` (same top-level, unauthenticated shape as
   `sign.up`) so a consumer can tell the two open-signup states apart and gate the
   Referrals tab's invite-form-vs-informational-state accordingly.
4. **Index `referredBy` — SHIPPED (#3945)**: `{ referredBy: 1 }` on the `User` model,
   added alongside the CASL widening above (the account Referrals view is the first
   real referral query).

## UI

The Vue module (`src/modules/invitations/` in Devkit Vue) ships the admin beta-gate tab and
the account **Referrals** tab (invite a contact, my invites + status chips, and a referral
summary). Reward grants happen server-side (#3842) with no client-visible balance UI —
the former "coming soon" placeholder was removed once the grant path shipped (#4504).

## Shareable referral link (credit only unless `billing.referral.link`)

With `billing.referral.enabled`, `GET /api/users/me` returns `referralCode` — the user id encoded
(base64url, derived, nothing stored). An email/password signup may send it as `ref`; the server decodes it,
checks the referrer exists and sets `referredBy`. An unknown or malformed code, a disabled flag, or an honored
invite (which wins) means no link attribution (the honored invite keeps its own attribution to its inviter) and never a 4xx. A link referral is **credit only** by default: no billing reward.
Set `billing.referral.link: true` (with `enabled`) and a link signup with no accepted invitation earns the
same two sides as an invite, keyed `referral:link:<refereeUserId>:referee` and `referral:link:<refereeUserId>:referrer:<referrerUserId>` (granted by the
`organization.provisioned` listener, back-filled by the reconcile cron). An accepted invitation always wins,
and `invitations.maxLifetime` (a positive integer, required: without it no link grant happens) caps the link rewards per referrer, counted per referrer across all ledgers (creating or switching organization never resets it). Turning `link` on also back-fills past link signups through the cron, bounded by that cap.
`user_signed_up` carries `referralSource: 'invite' | 'link' | null`.
