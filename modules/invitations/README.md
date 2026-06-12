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

The reward **seam** ships; the reward **logic** is deliberately deferred (#5, gates in #3833).
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
> (glob-discovered, e.g. `modules/trawl-rewards/` — for custom logic).

### A. Standard grant — ships IN the stack, downstream enables it by CONFIG

The grant listener is implemented **once, upstream, in `billing.init.js`** (#5 — the
no-op seam with the `TODO(#5)` is already there), entirely gated by config:

```js
// modules/billing/config/billing.development.config.js — stack default: OFF
// (this block does NOT exist yet — #5 adds it together with the listener impl)
billing: { referral: { enabled: false, referrerUnits: 0, refereeUnits: 0 } }
```

```js
// a downstream's config/defaults/{project}.config.js — the ONLY thing it touches:
billing: { referral: { enabled: true, referrerUnits: 500, refereeUnits: 200 } }
```

The stack listener (#5 implementation sketch — lives upstream, never downstream):

```js
invitationEvents.on('invitation.accepted', async ({ invitationId, invitedBy, acceptedUserId }) => {
  try {
    const cfg = config.billing?.referral;
    if (!cfg?.enabled) return;                              // downstream flips this
    if (invitedBy && cfg.referrerUnits) await grantCredits({ userId: invitedBy, units: cfg.referrerUnits, key: `referral:${invitationId}:referrer` });
    if (cfg.refereeUnits) await grantCredits({ userId: acceptedUserId, units: cfg.refereeUnits, key: `referral:${invitationId}:referee` });
  } catch (err) {
    // ⚠️ MANDATORY self-guard: EventEmitter.emit is synchronous — the emit-site
    // try/catch in invitations.service only catches SYNC throws. An async
    // listener's rejection escapes as an unhandledRejection. Never let it.
    logger.error('[billing] referral grant failed', { err: err?.message, stack: err?.stack });
  }
});
```

Rules that make this production-grade:

- **Idempotency** — key every grant on `invitationId` (unique index on the ledger `key`):
  a replayed/duplicate event can never double-credit.
- **Reconcile cron (safety net)** — EventEmitter is in-process fire-and-forget; a crash
  between accept and grant loses the event. Pair the listener with a periodic script
  (k8s CronJob, pattern: `modules/billing/crons/`) that scans
  ALL `invitations { status:'accepted' }` vs the grant ledger keys and back-fills misses
  (scan all accepted, not just `invitedBy:{$ne:null}` — referee grants exist even when
  `invitedBy` is null, so a referrer-only scan would miss referee-only back-fills).
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
// illustrative — a countAccepted helper does not exist yet; #5 adds it (or an equivalent query)
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

## Gates before shipping rewards (#3833 — read it first)

1. **Scope the list**: `GET /api/invitations` is platform-global today (admin-only by
   CASL). Before widening `create Invitation` to regular users, add an `invitedBy`-scoped
   `/mine` (PII: invitee emails).
2. **Self-referral guard** — alternate-email self-invites become valuable once credits exist.
3. **Open-signup hole** — claim/finalize are gated on `!config.sign.up`: with public signup
   open the event never fires. Resolve (finalize-without-claim) or hide the Referrals tab
   before any open deployment enables rewards.
4. **Index `referredBy`** alongside the first real referral query.

## UI

The Vue module (`src/modules/invitations/` in Devkit Vue) ships the admin beta-gate tab and
the account **Referrals** tab (invite a contact, my invites + status chips, a referral
summary, and the "Referral rewards — coming soon" placeholder where #5's balance lands —
the placeholder is contractually digit-free until real numbers exist).
