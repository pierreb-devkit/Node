# Billing Runbooks

Operational runbooks for the billing module. Each runbook references real endpoints — see `modules/billing/routes/billing.admin.routes.js` for auth requirements (JWT admin token required for all `/api/admin/*` routes).

---

## 1 — Stripe Dispute

**Context**: Stripe gives 7 calendar days from dispute creation to submit evidence. Missing the window results in an automatic loss. `billing.dispute.opened` fires an ntfy alert on day 1. The dispute funds are held by Stripe immediately on `charge.dispute.funds_withdrawn`.

**Steps**:

1. Confirm dispute in Stripe Dashboard → Radar → Disputes. Note the `charge_id` and `dispute_id`.
2. Retrieve customer state to verify DB-side ledger matches Stripe:

   ```text
   GET /api/admin/billing/customer/:orgId
   ```

   Confirm `stripeStatus` matches `subscription.status` in DB.
3. If the dispute is fraudulent (stolen card), cancel the subscription immediately:

   ```text
   POST /api/admin/billing/cancel/:orgId
   ```

4. Gather evidence in Stripe Dashboard: usage records, signup email, ToS acceptance timestamp, IP logs.
5. Submit evidence before day 7 via Stripe Dashboard → Dispute → Submit evidence.
6. If dispute won (`charge.dispute.funds_reinstated` received): restore the customer's extras balance via:

   ```text
   POST /api/admin/billing/dispute/credit/:orgId
   Body: {
     "chargeId": "ch_xxx",
     "amountCents": <dispute_amount_cents>,
     "reason": "dispute won — funds reinstated on charge ch_xxx",
     "refundRequestId": "<uuid>"
   }
   ```

   Example curl:

   ```bash
   curl -X POST https://api.trawl.me/api/admin/billing/dispute/credit/<orgId> \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -H "Content-Type: application/json" \
     -d '{"chargeId":"ch_xxx","amountCents":2000,"reason":"dispute won — Stripe reinstated funds","refundRequestId":"<uuid>"}'
   ```

   Confirm credit applied: `GET /api/admin/billing/customer/:orgId` — check ledger for an `adjustment` entry with `refId: dispute-credit-<uuid>`.
7. If dispute lost: extras balance debited by `charge.dispute.funds_withdrawn` is not refunded — log in incident tracker.

---

## 2 — Dead-Letter Investigation

**Context**: Stripe webhook events that fail processing 5+ times (or where the idempotency guard fires on a poisoned payload) are marked `deadLetter: true` in `processedStripeEvents`. They accumulate and must be reviewed manually — partial TTL index excludes them from auto-expiry.

**Steps**:

1. List all dead-letter events:

   ```text
   GET /api/admin/billing/dead-letters
   ```

   Response includes `eventId`, `type`, `createdAt`, `lastError` for each.

2. For each suspicious event, attempt replay (re-fetches event from Stripe API, re-dispatches through the webhook pipeline):

   ```text
   POST /api/admin/billing/webhook/replay
   Body: { "eventId": "evt_xxx" }
   ```

   On success: the event is re-processed and the `deadLetter` flag cleared automatically.

3. If replay succeeds but state is still inconsistent (e.g. subscription not updated), force a DB sync from Stripe:

   ```text
   POST /api/admin/billing/sync/:orgId
   ```

4. If the event is stale/unrecoverable (e.g. the subscription no longer exists in Stripe), purge it:

   ```text
   DELETE /api/admin/billing/dead-letters/:eventId
   ```

5. If the same event type keeps dead-lettering: check `lastError` for the root cause, open a fix issue, and monitor the next occurrence before purging.

---

## 3 — Meter Mismatch

**Context**: `billing.reconcile` cron (Sundays 03:00 UTC) logs `billing.reconciliation.divergence` when Stripe subscription status or plan differs from the DB. Operations must investigate and resolve manually — no auto-fix to avoid masking bugs.

**Steps**:

1. Identify the divergence from the weekly reconciliation log:

   ```bash
   kubectl logs -n pierreb-projects job/billing-reconcile-<timestamp>
   ```

   Look for lines containing `divergence detected` — they include `orgId`, `stripeStatus`, `dbStatus`, `stripePlan`, `dbPlan`.

2. Get the full customer state for the affected org:

   ```text
   GET /api/admin/billing/customer/:orgId
   ```

   Compare `stripeSnapshot` (live from Stripe API) vs `dbSnapshot` (local DB) fields.

3. If Stripe is authoritative (e.g. subscription renewed but DB missed the webhook), sync Stripe → DB:

   ```text
   POST /api/admin/billing/sync/:orgId
   ```

4. If the plan needs manual correction (e.g. plan bump after payment confirmation):

   ```text
   PATCH /api/admin/billing/plans/bump
   Body: { "orgId": "...", "planId": "pro" }
   ```

5. Re-run `GET /api/admin/billing/customer/:orgId` to confirm `stripeSnapshot` and `dbSnapshot` now match.

6. If mismatch persists after sync: open an incident, check dead-letter queue (Runbook #2), replay missing events.

---

## 4 — Stripe LIVE Rollout

**Context**: Pre-live checklist before switching `STRIPE_SECRET_KEY` from `sk_test_*` to `sk_live_*` in production.

**Pre-live checklist** (complete all before toggling):

- [ ] Stripe Dashboard (LIVE mode): 10 webhook events enabled (see `STRIPE_SETUP.md`)
- [ ] Stripe Dashboard (LIVE mode): Smart Retries enabled (Billing settings → Smart Retries)
- [ ] Stripe Dashboard (LIVE mode): `tax_id` collection enabled in Checkout (B2B EU)
- [ ] `STRIPE_SECRET_KEY` = `sk_live_*` set in K8s secret `trawl-node-env`
- [ ] `STRIPE_WEBHOOK_SECRET` = `whsec_*` (LIVE mode endpoint secret) updated in K8s secret
- [ ] `STRIPE_PRICE_*` env vars point to LIVE price IDs (not test price IDs)
- [ ] All 4 CronJob manifests deployed: `trawl-billing-dunning-sweep`, `trawl-billing-weekly-reset`, `trawl-billing-extras-expiration`, `trawl-billing-reconcile`
- [ ] Dead-letter queue empty: `GET /api/admin/billing/dead-letters` → 0 entries
- [ ] Test mode webhooks drained: Stripe Dashboard → Webhooks → no pending test deliveries
- [ ] Smoke test: in staging pointed at **TEST** Stripe keys (not LIVE), create a checkout session using Stripe test card `4242 4242 4242 4242` — confirm `checkout.session.completed` webhook received + subscription created in DB. Do **not** use test cards against LIVE keys (they are rejected; use this step to validate the integration flow, then cut over to LIVE keys for production)
- [ ] Rollback plan documented: toggling `STRIPE_SECRET_KEY` back to test key is sufficient for rollback (no DB migration required)

**Go/no-go gate**: all checkboxes ticked + at least 1 successful end-to-end checkout in staging with LIVE keys.

---

## 5 — Stripe API Down

**Context**: When Stripe's API is unavailable, the billing module degrades gracefully rather than erroring. No revenue-blocking occurs for existing subscribers.

**Behavior during outage**:

- `GET /api/billing/plans` (`getPlans`): returns stale cache (up to 24h old) + emits `billing.plans.stale` event. After 24h stale TTL, throws — clients see a 503 but cannot subscribe anyway (checkout would fail at Stripe).
- Incoming webhooks: Stripe's retry queue accumulates events and delivers them when connectivity is restored. No action required — events replay automatically via Stripe's retry schedule.
- `POST /api/admin/billing/sync/:orgId`: fails with Stripe error — do not retry in a loop; wait for Stripe status page to confirm recovery.
- `POST /api/admin/billing/webhook/replay`: fails if Stripe API unreachable (event re-fetch fails). Queue replays until recovery.
- Meter usage (`incrementMeter`): continues working — no Stripe call on the hot path. Extras debit is DB-only.
- Admin operations (`adminBumpPlan`, `adminCancelSubscription`): `adminBumpPlan` is DB-only and continues working. `adminCancelSubscription` calls `stripe.subscriptions.cancel` — will fail; retry after recovery.

**Steps during outage**:

1. Confirm Stripe outage via https://status.stripe.com — check if it is API-wide or specific to Webhooks/Dashboard.
2. No action required for existing subscribers — their access is unaffected.
3. Disable any scheduled marketing emails that reference plan upgrade CTAs to avoid confusing users who cannot checkout.
4. Monitor `billing.plans.stale` event frequency — if the stale cache is 24h+, alert the on-call to decide whether to take the plans endpoint down entirely or serve a static fallback.
5. Once Stripe recovers: `POST /api/admin/billing/sync/:orgId` on any org that attempted a subscription change during the outage.
6. Check dead-letter queue for events that exhausted retries during the outage window: `GET /api/admin/billing/dead-letters`.

---

## 6 — Cron lock stuck

**Symptom:** All billing crons emit `lock held by another pod, skipping` for longer than the lock TTL duration, meaning no billing cron is running at all.

**Cause:** A pod crashed mid-job without reaching the `finally` block that calls `releaseLock`. The TTL has not yet expired on the stale lock doc in `cron_locks`.

**Wait first:** Lock TTLs are sized 2–3× typical exec time. Wait for the TTL to expire (max 15 min for `dunningSweep`). MongoDB's TTL monitor runs every 60 seconds, so actual cleanup may lag up to 60 s after expiry.

**If urgent — drop the stale lock manually:**

**Before drop:** verify the holder and TTL window first to avoid kicking a running cron.

```js
db.cron_locks.findOne({ _id: "billing.weeklyReset" })
// If lockedUntil is in the past → safe to drop.
// If in the future → the lock is genuinely held; wait for TTL unless the holder pod is confirmed dead.
```

Then drop:

```js
// weeklyReset
db.cron_locks.deleteOne({ _id: "billing.weeklyReset" })

// dunningSweep
db.cron_locks.deleteOne({ _id: "billing.dunningSweep" })

// extrasExpiration
db.cron_locks.deleteOne({ _id: "billing.extrasExpiration" })
```

Or via `kubectl exec` on the mongo pod:

```bash
kubectl exec -n pierreb-projects mongo-0 -- mongosh \
  "mongodb://localhost:27017/<your-db>" \
  --eval 'db.cron_locks.deleteOne({ _id: "billing.weeklyReset" })'
```

**Prevention:** Lock TTLs are intentionally conservative. If you see frequent stuck-lock incidents, investigate cron duration (slow query? tenant scale?) rather than lower the TTL — a TTL too short defeats the mutual-exclusion guarantee.
