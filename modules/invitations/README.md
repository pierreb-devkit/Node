# Invitations module

Optional, standalone module owning the **platform invitation** concept: invite a contact by
email → single-use token + `invitedBy` + beta-gate eligibility. Depends only on `auth`
(via the `registerSignupEligibility` hook — `auth` never imports this module). Knows nothing
about organizations: getting an invited person into an org is the 2-step flow
*platform invite → `org.addMember(userId)`*.

- Routes: `/api/invitations` (admin list/create + revoke via `DELETE /:invitationId` — no
  update endpoint) + `/api/invitations/verify/:token` (public).
- Model `Invitation` → collection `invitations` (`email`, `token`, `invitedBy`, `status`,
  `expiresAt`, `consumingAt`, `acceptedAt`, `acceptedUserId`, `revokedAt`, `usedAt`).
- Signup gate: two-phase claim/finalize (`consumingAt` CAS + lazy 15-min stale sweep),
  email pin, soft revoke. See `services/invitations.service.js`.

## The referral substrate (what "Referral rewards — coming soon" hooks into)

The reward **seam** ships, and the STANDARD reward logic now ships too (#3842 — the
config-gated grant listener in `billing.init.js`, default OFF; product gates in #3833).
Two primitives are written on every accepted invite — on **both** the token-signup path and
the OAuth path (shared `accept(invite, userId)`):

1. **`user.referredBy`** — the inviter's userId, stamped server-side on the created account
   (never client-writable: absent from the Zod schemas + update whitelists; written via the
   raw repository path only). This is the durable referral edge — it supports
   *compute-on-read* forever, even if an event was missed.
2. **`invitation.accepted` event** — emitted by this module's singleton
   (`lib/events.js`):

   ```js
   invitationEvents.emit('invitation.accepted', {
     invitationId,    // ← natural IDEMPOTENCY KEY for any grant
     email,           // invitee email (lowercased)
     invitedBy,       // inviter userId — the admin API always stamps the creating admin;
                      // null only for actor-less inserts (legacy/scripted data)
     acceptedUserId,  // the REFEREE — double-sided rewards need no schema change
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
  try/catch only covers sync throws, see `lib/events.js`).

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
import invitationEvents from '../invitations/lib/events.js';

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
   admin-created rows). CASL still grants the route to admins only — widening the
   `Invitation` abilities to regular users is the referral phase's flip; the scoping
   ships first so that flip can never leak invitee emails (PII) platform-wide.
2. **Self-referral guard — SHIPPED (#3833), with a known residual**: `create()`
   rejects 422 "You cannot invite yourself" when the invitee email equals the
   inviter's own, before the E9 registered-email check. The grant-side floor
   (`expectedGrantKeys` drops the referrer side when
   `invitedBy === acceptedUserId` — pinned in the billing unit tests) covers
   same-account pairs only. **Alias/variant self-invites (a second personal email
   → a separate account) are NOT prevented** — accepted residual risk; revisit
   (fraud review / email-normalization dedup) before any paid-rewards launch.
3. **Open-signup hole — DOCUMENTED, intentionally NOT changed**: claim/finalize stay
   gated on `!config.sign.up` (the "open signup never burns a token" invariant).
   **Referral rewards therefore require `sign.up: false`.** On an open-signup
   deployment a presented token is *resolved* but never *claimed/finalized*, so
   `invitation.accepted` never fires and no grant occurs — enabling
   `billing.referral` there is a silent no-op. The Vue Referrals tab reads
   `GET /api/auth/config` (`sign.up`) and replaces the invite form with an
   informational state when signup is open (the referrals list stays read-only).
4. **Index `referredBy`** alongside the first real referral query.

## UI

The Vue module (`src/modules/invitations/` in Devkit Vue) ships the admin beta-gate tab and
the account **Referrals** tab (invite a contact, my invites + status chips, a referral
summary, and the "Referral rewards — coming soon" placeholder where the #3842 grant
balance lands — the placeholder is contractually digit-free until real numbers exist).
