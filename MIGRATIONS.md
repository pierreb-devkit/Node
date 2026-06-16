# Migrations

Breaking changes and upgrade notes for downstream projects.

---

## Config rename: `swagger` → `openapi` (2026-06-16)

The mis-named `config.swagger` namespace is renamed to `config.openapi`: it gates the OpenAPI JSON spec served at `/api/spec.json`, and there is no Swagger-UI (the Redoc UI was decommissioned earlier). Pure rename, no behavior change.

### What changed (this repo)

- `config.swagger` → `config.openapi` (defaults in `config/defaults/development.config.js` + `production.config.js`).
- `config.swagger.publicInProd` → `config.openapi.public` (the `InProd` suffix is dropped — the flag means "serve the spec publicly"; still secure-by-default `public: false`).
- `config.files.swagger` glob key → `config.files.openapi` (`lib/helpers/config.js` + the `fileKeys` filter list in `config/index.js`).
- The gate in `lib/services/express.js` (`initApiSpec`) reads the new keys; internal log prefixes `[swagger]` → `[openapi]`.

### Action required for downstream projects (`/update-stack`)

- Rename the `swagger` block to `openapi` in `config/defaults/{project}.config.js` and rename `publicInProd` → `public` if set. No other action — the glob key + gate are devkit-owned stack files that arrive via `/update-stack`.

---

## Referral grant — config-gated `invitation.accepted` listener in billing (2026-06-12)

Standard referral reward (#3842, the real tracker behind the old in-code `TODO(#5)` refs). The `invitation.accepted` no-op seam in `billing.init.js` is now the **config-gated grant listener**: on every accepted invite it idempotently credits meter units to the **referrer**'s and **referee**'s organizations on the `BillingExtraBalance` ledger (`kind:'topup'`, `source:'referral'`, keys `referral:<invitationId>:referrer|referee`, expiry like pack credits).

### What changed (this repo)

- **New config knob** (`modules/billing/config/billing.development.config.js`) — stack default **OFF**, zero behavior change for existing deployments:

  ```js
  billing: { referral: { enabled: false, referrerUnits: 0, refereeUnits: 0, expiryDays: 365 } }
  ```

- **`billing.init.js`** — the P8a no-op listener is replaced by the grant impl (async, self-guarded: a grant failure is logged, never escapes as an unhandledRejection). Skips the referrer grant when `invitedBy` is null or `invitedBy === acceptedUserId` (cheap self-referral floor; the full guard is #3833).
- **New service** `modules/billing/services/billing.referral.service.js` — maps user-scoped referral actors onto the org-scoped ledger (actor's `currentOrganization`, active-membership fallback; an actor without an org yet — e.g. mailer-configured signups before email verification — is left to the cron).
- **`creditGrant`** (`billing.extraBalance.repository.js`) now accepts `{ refId, expiresAt }` options (explicit idempotency key + expiry); backward compatible — signup grant unchanged. `source` enums (Mongoose + Zod) gain `'referral'`. New `findExistingRefIds` helper.
- **New reconcile cron** `modules/billing/crons/billing.referralReconcile.js` (house cron pattern: jitter + distributed lock `billing.referralReconcile` 10 min TTL; gates on `billing.referral.enabled`, NOT `meterMode`): scans ALL `invitations { status:'accepted' }` vs the grant ledger keys and back-fills misses idempotently. The listener is latency; the cron is truth.
- **New index** `invitations.invitedBy` (schema-declared, built by Mongoose autoIndex at boot) — the reconcile + future referral lists query it.

### Action required for downstream projects (`/update-project`)

1. All changes are devkit-owned stack files → arrive via `/update-stack` (`--theirs`). Default OFF: **no action = no behavior change**.
2. **To enable referral rewards**, flip the knob in `config/defaults/{project}.config.js` (NEVER edit `billing.init.js`):

   ```js
   billing: { referral: { enabled: true, referrerUnits: 1000, refereeUnits: 500 } } // example values
   ```

   ⚠️ Merging is safe everywhere (default OFF); do NOT enable until pierreb-devkit/Node#3833 lands — only the cheap self-referral floor ships here.
3. When enabling, add a k8s CronJob manifest for `billing.referralReconcile.js` in the infra repo (mirror the existing billing cron manifests; recommended daily `0 4 * * *`). Also confirm `billing.extrasExpiration.js` runs — referral credits expire through the same sweep. Note: the first reconcile run retro-grants every previously accepted invitation — if unwanted, pre-seed the `referral:<id>:*` ledger keys before enabling.
4. The `invitations.invitedBy` index is created automatically at boot (autoIndex, small collection — no manual migration needed).

---

## org.addMember + membership consent split (2026-06-10)

Phase 5a of the invitations↔org decouple epic (#3813). Replaces the deleted org email-invite with a **consent-safe add-member flow**: an owner/admin adds an *existing* user, creating a **PENDING `owner_add`** membership that the **invited user** must accept — the owner can NEVER approve it (consent invariant).

### What changed (this repo)

- **Membership model** (`organizations.membership.model.mongoose.js`) — new `source` enum field `{ 'join_request', 'owner_add' }` **with NO default** + a `pre('validate')` hook that throws if a PENDING row has no `source` (a forgotten source must fail loudly, never silently become an owner-approvable join request). New optional `addedBy` (ObjectId, audit-only).
- **Constants** — new `PENDING_SOURCES = { JOIN_REQUEST:'join_request', OWNER_ADD:'owner_add' }`.
- **Service** (`organizations.membership.service.js`) — `addMember(orgId, userId, role, addedBy)` creates a PENDING owner_add (status set EXPLICITLY — the schema defaults status to `'active'`); rejects if ANY membership already exists for (user, org); last-owner-safe. `acceptMembership(id, userId)` flips PENDING→ACTIVE **only** for a `source:'owner_add'` membership whose `userId` is the caller (sets `currentOrganization` if unset). `createJoinRequest`'s single-pending-global rule is now **source-scoped to join_request** (a pending owner_add no longer blocks a join request, and vice-versa). New `listPendingOwnerAddsByUser`.
- **Approval surface scoped to join_request** — `listPending`, `listPendingByUser`, and the `requestByID` approve/reject gate now match `source:'join_request'` (with an E17 `source $exists:false` legacy fallback) so an owner_add is **invisible** to the owner-approval surface. The auth-payload `pendingRequests` is unchanged in shape — still the user's own join requests.
- **Routes** — `POST /api/organizations/:organizationId/members` (owner/admin; CASL `create Membership`) adds a member; `GET /api/organizations/:organizationId/members/search?email=` (owner/admin) looks up a user by **exact email** (GDPR: no fuzzy directory enumeration); `GET /api/membership-requests/mine/pending` lists the user's pending owner_add invitations; `PUT /api/membership-requests/:membershipId/accept` lets the **invited user** accept (auth-only; consent gate in the service, no org-CASL).
- **Migration** `modules/organizations/migrations/20260610140000-backfill-membership-source.js`: sets `source:'join_request'` on all existing PENDING memberships (they were all join requests pre-change). Idempotent (filter requires `source` absent). Raw collection driver (house style).

### Action required for downstream projects (`/update-project`)

1. Module/model/migration changes are devkit-owned → arrive via `/update-stack` (`--theirs`).
2. **Migration ORDERING (E17 — critical):** the backfill `20260610140000` MUST run BEFORE the source-filtering code deploys, so no pre-existing join request is hidden from the approval list. The migration runs at boot before `listen()`; downstream rollouts must sequence it before the code deploy. The service/controller carry a temporary `source $exists:false` fallback so legacy rows stay visible even if the code lands first; that fallback is removed in a follow-up once every environment's backfill is confirmed.
3. No platform-invitation (`sign.cap` / `?inviteToken=`) behavior changes. Vue add-member UI + pending-invitation list land in Vue #4281.

---

## Remove organization email-invite feature (2026-06-10)

Phase 4 of the invitations↔org decouple epic (#3812). The organization's **own** email-invite flow is **deleted** — distinct from the platform `invitations` module (single-use signup-token gate), which is unchanged. This is the owner-invites-an-email-to-join-their-org flow that lived on the membership doc as `status:'invited'` + `inviteToken` / `invitedEmail` / `inviteExpiresAt`. The 2-step "invite to platform, then add the resulting user as a member" flow replaces it (`org.addMember` lands in a later phase / #3813).

### What changed (this repo)

- **Routes removed** (now 404): `POST /api/organizations/:organizationId/invites`, `GET /api/invites/:token`, `POST /api/invites/:token/accept`. Org **join-requests** (`/requests`, `/requests/:id/approve`, `/requests/:id/reject`, `/membership-requests/mine`) and member CRUD are **unchanged**.
- **Service/controller** (`organizations.membership.service.js`, `organizations.membershipRequest.{controller,routes}.js`) — `invite` / `acceptInvite` / `getInvite` deleted.
- **Membership model** (`organizations.membership.model.mongoose.js`) — dropped the `inviteToken` / `invitedEmail` / `inviteExpiresAt` fields, removed `'invited'` (and the never-written `'rejected'`) from the `status` enum, and removed the sparse `inviteToken_1` index. The partial-unique `(userId, organizationId)`, the `organizationId`, and the `(organizationId, status)` indexes are kept.
- **Constants** — `MEMBERSHIP_STATUSES` now `{ ACTIVE, PENDING }` (`INVITED` and the dead `REJECTED` removed; `rejectRequest` hard-deletes the doc, so `rejected` was never written).
- **Template** `config/templates/org-invite.html` deleted.
- **Migration** `modules/organizations/migrations/20260610130000-drop-org-invited-memberships.js`: deletes leftover `status:'invited'` memberships (often `userId:null` orphans), unsets the removed invite fields on any survivor, and drops the `inviteToken_1` index (idempotent; absent index swallowed).

### Action required for downstream projects (`/update-project`)

1. The module/model/migration changes are devkit-owned → arrive via `/update-stack` (`--theirs`).
2. The migration runs at boot before `listen()` and removes any leftover org `invited` memberships + drops the index automatically. (downstream deployments may carry a few such legacy rows — removed automatically.)
3. No platform-invitation (`sign.cap` / `?inviteToken=` signup gate) behavior changes. Any downstream UI calling the removed `/invites` org routes must migrate to the add-member flow (#3813 / Vue #4280).

---

## Invitations hardening: case-insensitive unique email index + two-phase invite claim (2026-06-10)

Phase 3 of the invitations↔org decouple epic (#3811). Two downstream-relevant changes.

### What changed (this repo)

- **`users.email` is now lowercased + case-insensitively unique.** Inline `unique:true` removed; `lowercase:true` added; an explicit collation index `{ email:1 }, { unique:true, name:'email_ci_unique', collation:{ locale:'en', strength:2 } }` declared on the schema. Email inputs normalized to lowercase in `findByEmail` / get-by-email / `linkProviderByEmail` / `remove`. New migration **`modules/users/migrations/20260610120000-users-email-ci-unique-index.js`**: pre-checks for case-variant duplicate emails and **ABORTS boot if any exist** (no auto-merge), then creates the collation index FIRST and drops the legacy `email_1` (never a window without a unique index). `lib/helpers/errors.js` `getUniqueMessage` now derives the field from `err.keyPattern` (index-name-agnostic) so the collation index still yields a friendly "Email already exists." message.
- **Invitation `consumingAt` two-phase claim** (new optional field on the `invitations` collection): the signup gate now atomically claims an invite before user creation and finalizes/releases after, with a lazy stale-claim sweep (15 min, no scheduler). Pure additive schema change — no data migration needed.

### Action required for downstream projects (`/update-project`)

1. The model/repository/migration changes are devkit-owned → arrive via `/update-stack` (`--theirs`).
2. **🔴 Before the first boot that carries the new schema, pre-check prod for case-variant duplicate emails** (`db.users.aggregate([{$group:{_id:{$toLower:'$email'},n:{$sum:1}}},{$match:{n:{$gt:1}}}])`). If any exist, resolve them BEFORE deploy — otherwise the migration aborts boot. Mixed-case **singles** need no action: the migration now lowercases them in place (post-dup-check, pre-index) so binary lookups keep finding those accounts. (each downstream runs this pre-check before its own rollout.)
3. Migrations run at boot before `listen()`; the index swap + the `consumingAt` field land automatically once the dupe pre-check passes.
4. No client/contract change; existing 200/422 signup assertions pass unchanged.

---

## @casl/ability v6 → v7 (2026-05-22)

`@casl/ability` upgraded from `^6.8.1` to `^7.0.0`.

### What changed (this repo)

- **`lib/middlewares/policy.js`** — v7 renames `PureAbility` to `Ability` and **drops its default conditions matcher**, so the `Ability` export no longer does MongoDB-style condition matching out of the box (`createMongoAbility` is the replacement for the old behavior). `defineAbilityFor()` now builds via `createMongoAbility`:

  ```js
  // before (v6)
  const { AbilityBuilder, Ability } = await import('@casl/ability');
  const { can, cannot, build } = new AbilityBuilder(Ability);
  // after (v7)
  const { AbilityBuilder, createMongoAbility } = await import('@casl/ability');
  const { can, cannot, build } = new AbilityBuilder(createMongoAbility);
  ```

  Without this, conditions like `can('manage', 'Organization', { _id })` stop matching → authorization silently denies → endpoints return 403/422.
- **JSDoc type refs** `import('@casl/ability').Ability` → `MongoAbility` (`lib/middlewares/policy.js`, `lib/helpers/abilities.js`).
- **`package.json`** — `@casl/ability` `^6.8.1` → `^7.0.0`.

### Downstream action required

The `policy.js` fix is a devkit-owned file → it arrives via `/update-stack` (`--theirs`). The **dependency bump does not auto-propagate** (`package.json` is `--ours`):

1. Bump `@casl/ability` to `^7.0.0` in `package.json` and reinstall.
2. After `/update-stack`, verify `lib/middlewares/policy.js` (~line 95) reads `new AbilityBuilder(createMongoAbility)`.
3. **Module policy files need no change** — they use `can`/`cannot` closures, never the `Ability` class.
4. The serialized rules format is **unchanged** (`createMongoAbility` keeps the MongoQuery rule shape), so Node→client rule packing stays compatible.
5. Run unit + integration + e2e to confirm authorization paths still pass.

---

## Sentry removed — PostHog Error Tracking is now sole source (2026-05-10)

The `@sentry/node` integration shipped in 2026-03-26 (still documented below as **PostHog Analytics (2026-03-26)** + the now-removed Sentry monitoring section) is dropped. Error capture moves entirely to PostHog Error Tracking via `posthog.capture('$exception', ...)`.

### What changed

- **Deleted** : `lib/services/sentry.js` + its unit tests + the `@sentry/node` dependency.
- **`lib/services/errorTracker.js`** simplified to PostHog-only path. The `captureExceptionPostHogOnly` fan-out helper is removed (collapsed into `captureException` since there is no longer a double-reporting risk from a parallel Sentry Express handler).
- **`lib/app.js`** — Sentry init/shutdown calls removed from bootstrap and shutdown paths.
- **`config/defaults/{development,production,test}.config.js`** — `sentry: { ... }` blocks deleted.
- **`config/defaults/development.config.js` + `production.config.js`** — `posthog.errorTracking` default flipped from `false` → `true`. Error capture is now enabled by default whenever `posthog.apiKey` is set.
- **`modules/home/services/home.service.js`** `getReadinessStatus()` — the `monitoring` row (Sentry presence) is replaced by an `errorTracking` row that gates on `posthog.apiKey && posthog.errorTracking === true`.
- **NEW `lib/middlewares/posthog-context.middleware.js`** — parses the `User-Agent` header, attaches `req.posthogContext = { source: 'cli'|'web', cli_version? }` for CLI-source attribution. Wired in `lib/services/express.js` after CORS / before routes.
- **`lib/services/analytics.js`** `capture()` accepts an optional `req` param. When provided, `req.posthogContext` is merged into event defaults so that CLI-originated requests carry `source` + `cli_version` automatically. Backward-compatible: callers that omit `req` see no behaviour change.

### Action required for downstream projects (`/update-project`)

1. **Drop env vars** `SENTRY_DSN` + any `SENTRY_*` references from `.env`, K8s manifests (`clusters/*/apps/*-node.yaml`), `.env.example`, deploy scripts, and CI secrets — they are no longer read.
2. **Drop `@sentry/*` deps** from project `package.json` if pinned downstream. Run `npm install` to regen lockfile.
3. **Remove project `config/defaults/*.config.js` overrides** of the `sentry: { ... }` block — they were either referencing the now-removed config path (no-op merge) or overriding fields that no longer exist.
4. **Confirm `posthog.errorTracking`** : if downstream config explicitly sets `posthog.errorTracking: false` to suppress capture, that override still wins via deepmerge. To opt into error tracking, set it to `true` (or rely on the new default if you remove the override).
5. **Optional — wire `req` into existing `capture()` callers** : if you want CLI-source attribution on existing events, change `capture({ distinctId, event, properties })` → `capture({ distinctId, event, properties, req })`. Without this opt-in, events still capture correctly but lack the `source`/`cli_version` properties.

### Why

Cf `infra/docs/superpowers/plans/2026-05-10-posthog-observability-followups.md` (decision matrix). PostHog Error Tracking is GA, free tier covers 100k exceptions/mo, and the single-tracker setup eliminates dual-config drift + cross-tool funnel friction.

---

## Test DB isolation: per-pid Mongo database default + globalTeardown (2026-04-24)

Default test database is now `mongodb://127.0.0.1:27017/NodeTest_${process.pid}` instead of the shared `NodeTest`. Concurrent jest invocations (e.g. multiple agent worktrees running `npm run test:coverage` in parallel) get isolated databases, eliminating the 401 / 404 / 422 / `MongoPoolClosedError` flake patterns seen in parallel runs.

### What changed

- `config/defaults/test.config.js` — `db.uri` is now computed at module load with `process.pid` suffix.
- `scripts/jest.globalTeardown.js` — new file; drops the resolved per-pid DB after the suite finishes so local Mongo doesn't accumulate orphan `NodeTest_<pid>` databases. Reuses the same NODE_ENV + `/test/i` guards as `globalSetup`.
- `jest.config.js` — registers the new `globalTeardown`.
- New regression tests: `scripts/tests/jest.globalTeardown.unit.tests.js` and `scripts/tests/testConfig.perPid.unit.tests.js`.

### Why `NodeTest_` (not just `Test_<pid>`)

The `NodeTest_` prefix preserves the `/test/i` DB-name guard in `scripts/jest.globalSetup.js` (#3476) — the guard refuses to drop any DB whose name does not contain `test`. Keeping the literal substring keeps the belt-and-suspenders intact.

### CI is unaffected

CI workflows (`.github/workflows/CI.yml` and downstream copies) set `DEVKIT_NODE_db_uri` explicitly, which lands in Layer 4 of `config/index.js` and overrides this default. Per-pid never applies on CI runs.

### Action for downstream

1. `/update-stack` pulls the change.
2. No env var changes required — your CI workflow's `DEVKIT_NODE_db_uri` keeps working.
3. If a downstream README / docs / make target references the literal `NodeTest` DB name (e.g. a manual `mongo NodeTest --eval ...` command), update it to point at the new default or invoke `mongosh` against the resolved URI from `config.db.uri`.
4. No Mongo data migration — test DBs are dropped on every run by design.

### Non-breaking

- CI is unchanged (env var override wins, see above).
- All test scripts (`npm run test`, `test:integration`, `test:coverage`, etc.) keep working with no flag changes.
- `docker-compose.test.yml` still ships an explicit `DEVKIT_NODE_db_uri` override (`mongodb://mongo:27017/NodeTest`) so containerised runs stay deterministic.

### Downstream propagation note (#3518)

When this lands in your project via `/update-stack`, the new `parallel-smoke` CI job ships a default `SMOKE_TEST_PATTERN` of `organizations.integration|tasks.integration` — which only matches in the upstream Devkit. **You MUST override `SMOKE_TEST_PATTERN`** in your CI `parallel-smoke` job (set it under the job's `env:` in `.github/workflows/CI.yml`) to match your project's integration test paths.

Each downstream Node project that consumes this stack must set the override:

| Project | Suggested `SMOKE_TEST_PATTERN` |
|---|---|
| `<project>_node` | project-specific integration globs (e.g. `foo.integration\|bar.integration`) |

(The exact globs are illustrative — replace with whatever integration files actually exist in your repo. The point is: pick at least two real integration suites so the parallel-smoke job exercises the per-pid DB isolation rather than passing on zero matches.)

Without an override, the smoke would historically have silently passed with 0 tests run, defeating the regression gate. As of #3518 the orchestrator passes `--passWithNoTests=false` to jest, so a 0-match pattern now exits non-zero and fails the smoke loudly — but the actionable fix is still to point the pattern at real integration paths in your repo.

The orchestrator also enforces a global timeout (`SMOKE_GLOBAL_TIMEOUT_MS`, default `2 × SMOKE_TIMEOUT_MS + 30s`) on top of the per-child timer, so a child whose `exit` event is dropped (rare ARC edge) no longer hangs the job until the 15-min CI cap.

---

## Auth OAuth redirect: canonical `responses.error` envelope on failure (2026-04-24)

The `GET /api/auth/oauth/:strategy/callback` redirect now carries a JSON-encoded error payload mirroring the canonical `lib/helpers/responses.js` shape, so the Vue client can surface OAuth failures with the same parser it uses for every other API error.

### What changed

- New private helper `oauthErrorRedirect(res, err, fallbackTitle)` in `modules/auth/controllers/auth.controller.js` — builds the redirect URL and stamps a canonical error envelope into the `error` query param (`URLSearchParams` ensures proper encoding).
- Both failure branches of `oauthCallback` (passport error, `!user`) now delegate to the helper instead of hand-rolling query strings with hardcoded titles.
- The `message` query now reflects the real `AppError.message` (e.g. `Signup error`) instead of the hardcoded `Unprocessable Entity` / `Could not define user in oAuth`.
- `logger.error(...)` calls are preserved — observability unchanged.

### Contract

Redirect URL is `${getBaseUrl()}/token?message=<title>&error=<json>` where `<json>` is a stringified envelope:

```json
{
  "type": "error",
  "message": "<err.message || fallbackTitle>",
  "code": 422,
  "status": 422,
  "errorCode": "<err.code || 'OAUTH_ERROR'>",
  "description": "<err.details.message || ''>",
  "details": { "message": "<err.details.message || title>" }
}
```

`code` and `status` are fixed at `422` (Unprocessable Entity) — OAuth callback failures surface via 302 redirect (not a JSON 4xx) so there is no live HTTP status; `422` matches the canonical shape of Zod / AppError validation failures elsewhere in the API.

### Why `details.message` is still shipped

Current downstream `token.view.vue` parsers read `error.details.message` rather than the canonical `error.description` / `error.message`. Shipping the canonical envelope AND the legacy `details.message` field lets Node deploy ahead of Vue without regressing the user-visible error toast during rollout.

Once every downstream Vue deploy has adopted the canonical parser (tracked in Vue issue #4021), the `details` field will be removed from the payload. A follow-up Node PR will ship that cleanup.

### Non-breaking

- Successful OAuth redirect (`${baseUrl}/token` + `TOKEN` cookie) is unchanged.
- The `message` query still exists — only its value changed (from hardcoded constants to the actual error title).
- The `error` query used to be a URL-encoded plain string; it is now URL-encoded JSON. Downstream clients that tried `JSON.parse` on the old payload were already throwing — the fix aligns them with the canonical parser path.

### Action for downstream

1. `/update-stack` pulls the change.
2. No env var changes.
3. No Mongo migration.
4. Vue consumers that currently read `error.details.message` keep working; new consumers should read `error.message` / `error.description` / `error.errorCode` per the canonical envelope.

---

## Organizations: global admin bypass extended to updateRole + `isGlobalAdmin` helper (2026-04-24)

Completes the platform-admin bypass started in #3509, and centralizes the repeated `Array.isArray(req.user?.roles) && req.user.roles.includes('admin')` check into a shared helper.

### What changed

- New helper `lib/helpers/isGlobalAdmin.js` — single source of truth for the global admin check used by moderation guards.
- `modules/organizations/controllers/organizations.membership.controller.js` — `updateRole` now admits global admins who are not members of the target org (required to transfer ownership during moderation). `remove` now uses the shared helper.
- `modules/organizations/controllers/organizations.controller.js` — `remove` now uses the shared helper (no behavior change).

### Why

`updateRole` had exactly the same buggy pattern that `remove` used to have before #3509: `if (!req.membership || req.membership.role !== OWNER)` rejected global admins with `req.membership === undefined` when they were not a member of the target org. The inline comment even said "Belt-and-suspenders: only owners (CASL blocks admins via no 'update Membership')" — the intent never anticipated platform admins. Same class of bug, same fix shape.

While at it, the duplicated `isGlobalAdmin` expression across three call-sites was extracted into a helper. Policies (`organizations.policy.js`, `users.policy.js`, etc.) still inline the check for now — migrating them is out of scope here (wider refactor, different test surface).

### Non-breaking

- No contract changes for regular users / owners / non-global admins.
- New capability: a user with `roles: ['admin']` can `PUT /api/organizations/:orgId/memberships/:memberId` without needing a membership on the target org.
- Belt-and-suspenders guard is preserved: the handler still blocks non-owner, non-admin org roles regardless of CASL.

### Action for downstream

1. `/update-stack` pulls the change.
2. No env var changes.
3. No Mongo migration.

---

## Auth signout endpoint (2026-04-23)

New `POST /api/auth/signout` endpoint that clears the httpOnly `TOKEN` cookie on the client.

### Why

Before: signout was purely client-side — the Vue client dropped its in-memory user state but the httpOnly `TOKEN` cookie remained in the browser. On the next page load the cookie was replayed to `/api/auth/token`, the user was silently re-logged in, and the signout button was effectively a no-op.

Now: the route calls `res.clearCookie('TOKEN', { httpOnly, secure, sameSite })` with options mirroring `tokenCookieOptions`. Browsers only delete cookies whose `secure`/`sameSite`/`path`/`domain` attributes match the original `Set-Cookie`, so the options must match exactly.

### Contract

- `POST /api/auth/signout` → `200 { type: 'success', message: 'Signed out' }`
- `Set-Cookie: TOKEN=; Max-Age=0; HttpOnly; …` (expired cookie — browser discards it)
- No JWT middleware: signout works even if the token is expired, invalid, or missing
- Rate-limited via the standard `authLimiter`

### Non-breaking

Additive endpoint. No existing contract changes. Downstream projects can adopt it at their own pace:

- Vue: call `POST /api/auth/signout` from the signout action, then clear the Vuex/Pinia user state
- No env var changes
- No Mongo migration

### Action for downstream

1. Run `/update-stack` to pull the endpoint.
2. (Vue side, separately) wire the signout action to call `POST /api/auth/signout` before resetting client state.

---

## OAuth account linking + Express 5 callback fix (2026-04-23)

Two related auth fixes that ship together.

### 1. Express 5 GET callback no longer crashes

Enabling Google OAuth on a downstream project used to crash on first signin with `Cannot read properties of undefined (reading 'strategy')`. Root cause: Express 5 leaves `req.body` as `undefined` on GET requests (Express 4 initialized it to `{}`).

- `modules/auth/controllers/auth.controller.js` — `oauthCallback` optional-chains `req.body` access
- Apple OAuth (POST `form_post`) was never affected — no change to behavior

### 2. Account linking by verified email

Before: a local signup at `user@x.com` followed by a Google signin with the same email crashed on Mongo's unique-email index (E11000) — user locked out.

Now: `checkOAuthUserProfile` follows a 4-step lookup:

1. `(provider, providerData[key])` — primary identity (OAuth-first users)
2. `additionalProvidersData[provider][key]` — linked users on subsequent signins
3. `email` match **with provider-verified email** → atomic link (`UserService.linkProviderByEmail`)
4. No match → create new user with `emailVerified` reflecting provider verification

Linking attaches the OAuth `providerData` under `user.additionalProvidersData[provider]` and **does not overwrite `user.provider`** — so password reset (gated on `provider === 'local'`) and local login keep working for linked users.

### Security gates

- Provider + key allowlists (`ALLOWED_PROVIDERS = {google, apple}`, `ALLOWED_PROVIDER_KEYS = {id, sub, email}`) validate the dynamic query path before Mongo.
- `emailVerifiedByProvider: true` required before linking — prevents takeover via a future OIDC provider that returns `email_verified: false` for someone else's address.
- `/token` response sanitizes `accessToken` / `refreshToken` out of `additionalProvidersData` before serialization.

### Action for downstream

1. Run `/update-stack` to pull both fixes in one go.
2. Env vars to set in prod K8s for Google (per project that wants OAuth enabled):
   - `DEVKIT_NODE_oAuth_google_clientID`
   - `DEVKIT_NODE_oAuth_google_clientSecret`
   - `DEVKIT_NODE_oAuth_google_callbackURL` — e.g. `https://api.{project}.{tld}/api/auth/google/callback`
3. Register the callback URL in Google Cloud Console (OAuth 2.0 client, Web type). For Apple: same pattern on `decodedIdToken.email_verified`.
4. `/api/auth/config` returns `oAuth.google: true` once the clientID is set — the Vue signin/signup buttons activate automatically via `serverConfig.oAuth.google`.

### Schema note

`additionalProvidersData` already existed in the Mongoose user schema and is now exposed in the Zod user schema too. No Mongo migration needed — existing users have an empty field.

---

## Analytics: request-aware feature-flag helpers (2026-04-23)

`analytics` service gains two sugar helpers that extract the PostHog `distinctId` from an Express request, so routes no longer need to repeat `req.user?.id ?? req.sessionID ?? 'anonymous'` (and can never forget the anonymous fallback):

```js
import analytics from '../../../lib/services/analytics.js';

// Route handler / middleware
const flag = await analytics.getFeatureFlagForRequest('checkout-v2', req);
if (await analytics.isFeatureEnabledForRequest('billing-portal', req)) { ... }
```

Resolution chain: `req.user?.id` → `req.sessionID` → `'anonymous'`. Defensive fallback: `req == null` also resolves to `'anonymous'`.

### Non-breaking

- The existing `getFeatureFlag(flag, distinctId, options)` / `isFeatureEnabled(flag, distinctId, options)` remain public for cron, worker, and scheduled-job callers that have no `req`.
- Higher-level `FeatureFlagsService` (`analytics.featureFlags.js`) is unchanged.

### Action for downstream

Optional — pull via `/update-stack`. Existing route code keeps working. New routes should prefer the `*ForRequest` variants to avoid the repeated distinctId boilerplate.

---

## Redoc replaces Scalar for /api/docs (2026-04-13)

The `/api/docs` UI is now served by [redoc-express](https://www.npmjs.com/package/redoc-express) instead of `@scalar/express-api-reference`. Redoc renders the same OpenAPI spec (`/api/spec.json`) with a cleaner three-panel layout better suited to a consumer-facing API reference (no try-it-out panel — the API is API-key-gated and meant for programmatic use).

### What changed

- `package.json` — `@scalar/express-api-reference` removed, `redoc-express` added
- `lib/services/express.js` — `initSwagger` mounts `redoc({ title, specUrl: '/api/spec.json', redocOptions: { hideDownloadButton, hideSchemaTitles, expandResponses } })` instead of the Scalar middleware. Spec assembly, guides loader, YAML merge, and `/api/spec.json` handler are unchanged.
- `lib/helpers/guides.js` — comments updated (Scalar → Redoc); behavior unchanged.
- `modules/core/tests/core.integration.tests.js` — `describe('Redoc API reference', …)` rename; assertions (HTML content-type, valid OpenAPI spec) unchanged.

### Action for downstream

1. Run `/update-stack` to pull the change — no project-side YAML, config, or CSP tweaks required.
2. Visual check: hit `/api/docs` and confirm the new Redoc UI renders the merged spec (guides sidebar + endpoint reference).

---

## Rate limiter keys by userId + trust proxy (2026-04-08)

Rate-limit middleware now keys authenticated requests by `user._id` (with `req.ip` fallback) instead of always using IP. Production config enables `trust.proxy: 1` so `req.ip` reflects the real client IP behind a single reverse proxy (Traefik, Nginx).

### What changed

- `lib/middlewares/rateLimiter.js` — default `keyGenerator` uses `req.user._id.toString() || req.ip`; custom profile `keyGenerator` is respected via `??`
- `config/defaults/production.config.js` — adds `trust.proxy: 1` (single hop)

### Action for downstream

1. Run `/update-stack` to pull the change
2. If your production setup has multiple proxy layers, override `trust.proxy` with the correct hop count or subnet in your project config

---

## Tasks stats endpoint requires JWT + org scope (2026-04-08)

`GET /api/tasks/stats` now requires authentication and organization context, consistent with all other task endpoints.

### What changed

- `modules/tasks/routes/tasks.routes.js` — added JWT + `resolveOrganization` + `isAllowed` middleware
- `modules/tasks/controllers/tasks.controller.js` — passes `req.organization` to service, uses try/catch
- `modules/tasks/services/tasks.service.js` — `stats()` accepts organization and filters by `organizationId`
- `modules/tasks/repositories/tasks.repository.js` — `stats()` uses `countDocuments(filter)` instead of `estimatedDocumentCount()`

### Action for downstream
1. Any unauthenticated call to `/api/tasks/stats` will now return `401`
2. Authenticated calls return the count scoped to the user's current organization
3. Run `/update-stack` to pull the change

---

## Remove dead scripts — ci/ssl, crons, db/dump (2026-04-07)

Dead scripts and dev-local data removed from the stack. Downstream projects may have local copies or npm scripts referencing these.

### What was removed

- `scripts/ci/generate-ssl-certs.sh` — HTTPS never active in default configs
- `scripts/crons/purgeUploads.js` — not wired to any cron or npm script
- `scripts/db/mongodump.sh` — dev-local only, not used in CI
- `scripts/db/mongorestore.sh` — dev-local only, not used in CI
- `scripts/db/dump/` — MongoDB fixture data (WaosNodeDev)
- npm scripts removed: `seed:mongodump`, `seed:mongorestore`, `generate:sllCerts` (note: this was a typo of `sslCerts` — remove whichever key your project has)

### Action for downstream

1. Delete any local override of the removed scripts if you copied them
2. Remove from your `package.json` any scripts referencing `seed:mongodump`, `seed:mongorestore`, `generate:sllCerts`
3. If you used `scripts/db/dump/` as dev fixtures, move them outside the repo and add to `.gitignore`
4. Run `/update-stack` to pull the change

---

## Audit route→type map is now config-driven (2026-04-07)

The hardcoded `route→type` map in `audit.middleware.js` has been removed. Each module now declares its own mapping via `audit.routeTypeMap` in its module config.

### Rationale

The previous hardcoded map forced optional modules (tasks, billing) to appear in core audit middleware — a violation of module isolation. Moving the map to config means each module owns its audit-type mapping, reducing coupling and keeping cross-module dependencies explicit. New modules can add their own mapping without modifying core code.

### What changed

- `modules/audit/middlewares/audit.middleware.js` — `deriveTargetType` reads `config.audit.routeTypeMap` instead of a hardcoded object
- `modules/audit/config/audit.development.config.js` — added empty `routeTypeMap: {}` base
- `modules/auth/config/auth.development.config.js` — added `audit.routeTypeMap: { auth: 'User' }`
- `modules/users/config/users.development.config.js` — added `audit.routeTypeMap: { users: 'User' }`
- `modules/billing/config/billing.development.config.js` — added `audit.routeTypeMap: { billing: 'Organization' }`
- `modules/organizations/config/organizations.development.config.js` — added `audit.routeTypeMap: { organizations: 'Organization' }`
- `modules/tasks/config/tasks.development.config.js` — added `audit.routeTypeMap: { tasks: 'Task' }`

### Action for downstream

1. Run `/update-stack` to pull the change
2. If your project has custom modules that need audit-type labelling, add `audit.routeTypeMap` to the module's development config:

```js
// modules/payments/config/payments.development.config.js
const config = {
  audit: {
    routeTypeMap: {
      payments: 'Payment',
    },
  },
  // ... rest of module config
};
export default config;
```

3. If no `routeTypeMap` entry exists for a route segment, the segment is capitalised as a fallback (same behaviour as before for unknown segments)

---

## Remove GDPR data export/deletion routes (2026-04-07)

The stack no longer provides generic GDPR data export and bulk deletion endpoints.
These are downstream product concerns and should be implemented per-project.

### What was removed

- `GET /api/users/data` — export all user data
- `DELETE /api/users/data` — delete user and all associated data
- `GET /api/users/data/mail` — email user data export
- `modules/users/controllers/users.data.controller.js`
- `modules/users/services/users.data.service.js`
- `config/templates/data-privacy-email.html`

### Action for downstream

1. If your project exposes these endpoints, move the logic into a project-level module
2. Remove any frontend calls to `/api/users/data`, `/api/users/data/mail`
3. Run `/update-stack` to pull the change

---

## Per-module project config overrides (2026-04-07)

The config loader now supports per-module project config files in addition to the existing global `config/defaults/{project}.config.js`.

### What changed

- `config/index.js` — Layer 3.5 added: auto-discovers and merges `modules/*/config/*.{project}.config.js` for non-standard `NODE_ENV` values (i.e. downstream project names)
- Per-module project overrides: create `modules/{name}/config/{name}.{project}.config.js` in your downstream project (see README for pattern and examples)

### Load order (updated)

| Layer | Source |
|-------|--------|
| 1 | `modules/*/config/*.development.config.js` |
| 2 | `config/defaults/development.config.js` |
| 3 | `config/defaults/{project}.config.js` |
| 3.5 | `modules/*/config/*.{project}.config.js` ← new |
| 4 | `DEVKIT_NODE_*` env vars |

### Action for downstream

1. Run `/update-stack` to pull the change
2. No breaking change — existing configs are unaffected
3. To add per-module project overrides, create `modules/{name}/config/{name}.{yourproject}.config.js`

---

## OpenAPI Module Documentation (2026-04-04)

Modules can now ship their own OpenAPI YAML in `modules/{name}/doc/{name}.yml`. These files are auto-discovered via the `modules/*/doc/*.yml` glob, merged into the base spec from `modules/core/doc/index.yml`, and served at `/api/spec.json` (+ Scalar UI at `/api/docs`).

### What changed

- `modules/core/doc/index.yml` — added shared component schemas (`SuccessResponse`, `ErrorResponse`) and reusable responses (`Unauthorized`, `Forbidden`, `NotFound`, `UnprocessableEntity`)
- `modules/tasks/doc/tasks.yml` — reference OpenAPI doc for the tasks module (all CRUD + stats endpoints)

### Action for downstream

1. Run `/update-stack` to pull the change
2. No breaking change — existing modules without a `doc/` folder are unaffected
3. To document a custom module, create `modules/{name}/doc/{name}.yml` with paths, schemas, and tags

---

## Scalar replaces swagger-ui-express (2026-04-04)

`swagger-ui-express` has been removed. The API documentation UI is now powered by [Scalar](https://scalar.com/) via `@scalar/express-api-reference`.

### What changed

- `initSwagger()` in `lib/services/express.js` no longer writes `./public/swagger.yml` to disk
- New endpoint `GET /api/spec.json` serves the merged OpenAPI spec as JSON
- `/api/docs` now serves the Scalar UI instead of Swagger UI
- Removed unused swagger config options: `swaggerUrl`, `explore`
- Removed dependency: `swagger-ui-express`
- Added dependency: `@scalar/express-api-reference`

### Action for downstream

1. Run `/update-stack` to pull the change
2. Remove any references to `./public/swagger.yml` — it is no longer generated
3. If you customized swagger options (e.g. `swaggerUrl`, `explore`), remove them — they are no longer used
4. The `/api/docs` and `/api/spec.json` routes are available as before

---

## Module Activation Config (2026-04-05)

Per-module `activated: true/false` config flag. When `activated: false`, the module's routes, policies, models, and swagger YAML are excluded from the app entirely.

### What changed

- New `filterByActivation(files, config)` in `lib/helpers/config.js` — filters all globbed file arrays by module activation status
- `config/index.js` applies filtering after config merge to: routes, policies, models, swagger YAML, preRoutes, configs
- Core modules (`core`, `auth`, `users`, `home`) are always active regardless of flag
- New module config files with `activated: true` default: `audit`, `billing`, `organizations`, `uploads`, `tasks`

### Action for downstream

1. Run `/update-stack` to pull the change
2. No breaking change — all modules default to `activated: true` (backward compatible)
3. To deactivate a module, set `DEVKIT_NODE_{moduleName}_activated=false` in env vars or override in config:
   ```js
   // config/defaults/development.config.js
   tasks: { activated: false }
   ```
4. If you have custom modules, add `activated: true` in their config file to be explicit

---

## Decentralized Policy Subject Resolution (2026-04-03)

Subject resolution in `lib/middlewares/policy.js` is now registry-based instead of hardcoded. Each module's policy file exports a `*SubjectRegistration()` function that registers its own document-level and path-level subjects during `discoverPolicies()`.

### What changed

- `resolveSubject()` iterates `documentSubjectRegistry` instead of hardcoded if/else chain
- `deriveSubjectType()` iterates `pathSubjectRegistry` instead of hardcoded if/else chain
- New exports: `registerDocumentSubject`, `registerPathSubject`
- New helper: `lib/helpers/authorize.js` — simple middleware for route-level CASL checks
- Each module policy file now exports a `*SubjectRegistration({ registerDocumentSubject, registerPathSubject })` function

### Action for downstream

1. Run `/update-stack` to pull the change
2. If you have custom modules with policy files, add a `*SubjectRegistration()` export following the pattern in any existing module (e.g. `modules/tasks/policies/tasks.policy.js`)
3. `policy.isAllowed` continues to work unchanged — no route file modifications needed
4. Optional: use `authorize(action, subject)` from `lib/helpers/authorize.js` for simple route guards

> **Deprecation notice**: `policy.isAllowed` is supported for this release cycle only. New routes should use `authorize(action, subject)` from `lib/helpers/authorize.js`. Custom modules using `policy.isAllowed` should migrate to `authorize()` before the next major version. The legacy middleware will be removed once all built-in module routes have been migrated.

---

## Audit GDPR Flags (2026-03-26)

New config flags to control IP and User-Agent capture in audit logs for GDPR compliance.

### Configuration

Add to your audit config (e.g. `modules/audit/config/audit.development.config.js`):

```js
audit: {
  captureIp: true,          // set false to stop storing client IP addresses
  captureUserAgent: true,   // set false to stop storing User-Agent strings
}
```

Both default to `true` (backward compatible). When set to `false`, the audit log stores an empty string instead of the real value.

### Action for downstream

1. Run `/update-stack` to pull the change
2. Optionally set `captureIp: false` and/or `captureUserAgent: false` in your audit config for GDPR compliance
3. No DB migration needed — existing entries are unaffected

---

## Logging & Monitoring (2026-03-26)

Structured logging, audit trail, Sentry error capture, and enriched health check.

### New module

`modules/audit/` — auto-discovered, no manual registration needed.

### New dependencies

- `@sentry/node` — error tracking (no-op when unconfigured)

### Configuration

Add to your env-specific config or override via `DEVKIT_NODE_*` env vars:

```js
// Audit log (modules/audit/config/audit.development.config.js)
audit: {
  enabled: true,                    // set false to disable audit logging
  ttlDays: 90,                      // auto-purge after N days (MongoDB TTL index)
}

// Sentry (config/defaults/development.config.js)
sentry: {
  dsn: '',                          // Sentry DSN — empty = disabled
  environment: 'development',
  enabled: false,
}

// Logging (config/defaults/development.config.js)
log: {
  json: false,                      // true = structured JSON output (recommended for prod)
  level: 'info',                    // Winston log level
}
```

All features are no-op when not configured — safe to deploy without Sentry or audit.

### What's included

| Feature | File | Notes |
|---------|------|-------|
| Winston JSON logging | `lib/services/logger.js` | Structured JSON when `log.json: true`, configurable level |
| X-Request-ID | `lib/middlewares/requestId.js` | UUID per request, `req.id` + response header |
| Sentry SDK | `lib/services/sentry.js` | Error capture, no-op when DSN empty |
| AuditLog model | `audit.model.mongoose.js` | TTL index, auto-purge via `audit.ttlDays` |
| Audit middleware | `audit.middleware.js` | Auto-captures POST/PUT/DELETE mutations (same pattern as analytics) |
| Audit API | `GET /api/audit` | Admin-only, paginated, filterable by action/userId/orgId |
| Audit policy | `audit.policy.js` | CASL: admin read-only |
| Health endpoint | `GET /api/health` | Public: `{ status }`, Admin (JWT): `{ status, db, uptime, version, memory }` |

### New MongoDB collection

| Collection | Model | Purpose | TTL |
|------------|-------|---------|-----|
| `auditlogs` | `AuditLog` | Action audit trail (who did what when) | Configurable via `audit.ttlDays` |

### Action for downstream

1. Run `/update-stack` to pull the new modules
2. Set env vars if needed: `DEVKIT_NODE_sentry__dsn`, `DEVKIT_NODE_audit__ttlDays`
3. No DB migration needed — collection and TTL index auto-created on first write

---

## PostHog Analytics (2026-03-26)

Server-side analytics, user/org identification, API auto-capture, and feature flags via PostHog.

### New module

`modules/analytics/` — auto-discovered, no manual registration needed.

### Configuration

Uncomment and set in your env-specific config (e.g. `modules/analytics/config/analytics.development.config.js`):

```js
posthog: {
  apiKey: process.env.DEVKIT_NODE_posthog_apiKey ?? '',
  host: process.env.DEVKIT_NODE_posthog_host ?? 'https://us.i.posthog.com',
}
```

All features are no-op when `apiKey` is empty — safe to deploy without PostHog.

### What's included

| Feature | File | Notes |
|---------|------|-------|
| Analytics service | `analytics.service.js` | `track()`, `identify()`, `groupIdentify()` |
| Auto-capture middleware | `analytics.middleware.js` | Captures `api_request` on all routes (except health/public) |
| Feature flags service | `analytics.featureFlags.service.js` | `isEnabled()` (safe default `false` when not configured), `getVariant()` (`undefined` when not configured) |
| `requireFeatureFlag` middleware | `analytics.requireFeatureFlag.js` | 401 when unauthenticated, 403 when flag disabled, fail-open when analytics not configured |
| Billing integration | `analytics.init.js` | Listens to `plan.changed` event → `groupIdentify` |

### Action for downstream

1. Run `/update-stack` to pull the new module
2. Set env vars: `DEVKIT_NODE_posthog_apiKey`, `DEVKIT_NODE_posthog_host`
3. No DB migration needed — all data stored in PostHog

---

## Organizations & CASL v2 (2026-03-13)

This guide is for downstream projects migrating to the new organizations + CASL document-level authorization system introduced on the `feature/signup-org-flow` branch.

---

### Breaking Changes

#### Authorization: CASL policies

- **Route-level rules replaced by document-level abilities.** Policy files no longer call `policy.registerRules()` with route paths. Instead, each policy file exports named functions (`<module>Abilities` and optionally `<module>GuestAbilities`) that receive `(user, membership, { can, cannot })` and define CASL conditions on subject types (e.g. `'Task'`, `'Upload'`).
- **`policy.isOwner` middleware removed.** Ownership is now enforced automatically via CASL conditions (e.g. `{ user: String(user._id) }`). Remove all `policy.isOwner` calls from routes and all `req.isOwner` assignments from controllers/param middleware.
- **`policy.registerRules()` removed.** Replaced by `policy.registerAbilities()` (called automatically by `policy.discoverPolicies()`).
- **Policy auto-discovery.** `initModulesServerPolicies()` in `lib/services/express.js` now calls `policy.discoverPolicies(policyPaths)` instead of looping over `invokeRolesPolicies()`.

#### Auth responses

- **Signup response** now includes `organization`, `abilities` (array of CASL rules), and `organizationSetupRequired` fields.
- **JWT payload** remains `{ userId }` (unchanged), but the user's organization context is resolved server-side via `user.currentOrganization`.

#### Models

- **User model**: new `currentOrganization` field (`ObjectId` ref to `Organization`).
- **Task model**: new `organizationId` field (`ObjectId` ref to `Organization`).
- **Upload model**: new `metadata.organizationId` field (`ObjectId` ref to `Organization`).
- **Task schema** (Zod): new optional `organizationId` field.
- **User schema** (Zod): new optional `currentOrganization` field; added to `whitelists.users.default` and `whitelists.users.update`.

#### New MongoDB collections

| Collection     | Mongoose model | Purpose                                    |
| -------------- | -------------- | ------------------------------------------ |
| `organizations`| `Organization` | Multi-tenant organization records          |
| `memberships`  | `Membership`   | User-to-organization membership + role     |
| `migrations`   | `Migration`    | Tracks executed migration scripts          |

#### New dependencies

None for Node (CASL `@casl/ability` was already installed). No new npm packages required.

#### Configuration

- New `organizations` section in `modules/auth/config/auth.development.config.js` with keys `enabled`, `autoCreate`, and `domainMatching`.

#### New API endpoints

| Method   | Path                                                | Auth     | Description                      |
| -------- | --------------------------------------------------- | -------- | -------------------------------- |
| `GET`    | `/api/organizations`                                | JWT      | List user's organizations        |
| `POST`   | `/api/organizations`                                | JWT      | Create a new organization        |
| `GET`    | `/api/organizations/:organizationId`                | JWT      | Get organization details         |
| `PUT`    | `/api/organizations/:organizationId`                | JWT      | Update organization              |
| `DELETE` | `/api/organizations/:organizationId`                | JWT      | Delete organization              |
| `GET`    | `/api/admin/organizations`                          | JWT+Admin| Platform admin: list all orgs    |
| `GET`    | `/api/admin/organizations/:organizationId`          | JWT+Admin| Platform admin: get org          |
| `DELETE` | `/api/admin/organizations/:organizationId`          | JWT+Admin| Platform admin: delete org       |
| `GET`    | `/api/organizations/:organizationId/members`        | JWT      | List members                     |
| `PUT`    | `/api/organizations/:organizationId/members/:memberId` | JWT   | Update member role               |
| `DELETE` | `/api/organizations/:organizationId/members/:memberId` | JWT   | Remove member                    |
| `POST`   | `/api/organizations/:organizationId/requests`       | JWT      | Request to join                  |
| `PUT`    | `/api/organizations/:organizationId/requests/:membershipRequestId/approve` | JWT | Approve join request   |
| `PUT`    | `/api/organizations/:organizationId/requests/:membershipRequestId/reject`  | JWT | Reject join request    |

---

### Prerequisites

- MongoDB accessible and writable (the migration script creates documents at boot).
- Current stack version on `master` (before migration) — your downstream project should be up to date with the latest `master` before merging the feature branch.

---

### Step-by-step Migration

#### Step 1: Migration System

Three new files power the automatic migration system:

| File | Purpose |
| ---- | ------- |
| `lib/services/migrations.js` | Discovers `modules/*/migrations/*.js` files, checks the `migrations` collection, runs pending `up()` functions in filename order |
| `modules/core/models/migration.model.mongoose.js` | Mongoose model for tracking executed migrations (`name`, `executedAt`) |
| `lib/app.js` | Calls `migrations.run()` after MongoDB connects, before Express starts |

The migration runner is integrated into the bootstrap sequence in `lib/app.js`:

```js
db = await startMongoose();
await migrations.run();      // <-- new line
app = await startExpress();
```

Migration files live in `modules/<name>/migrations/` and are named with a date prefix for ordering (e.g. `20260310120000-organizations-init.js`). Each file exports an `up()` function.

#### Step 2: CASL Refactor

##### Policy middleware (`lib/middlewares/policy.js`)

**Before (master):**
```js
// Global rules registry — route-path based
const rulesRegistry = [];
const registerRules = (rules) => rulesRegistry.push(...rules);

const defineAbilityFor = async (user) => {
  const roles = user ? user.roles : ['guest'];
  for (const rule of rulesRegistry) {
    if (rule.roles.some((r) => roles.includes(r))) {
      can(rule.actions, rule.subject); // subject = route path like '/api/tasks'
    }
  }
  return build();
};

const isAllowed = async (req, res, next) => {
  const ability = await defineAbilityFor(req.user);
  if (ability.can(action, req.route.path)) return next(); // checks route path
  // ...
};

const isOwner = (req, res, next) => {
  if (req.user && req.isOwner && String(req.isOwner) === String(req.user._id)) return next();
  // ...
};

export default { registerRules, isAllowed, isOwner };
```

**After (feature branch):**
```js
// Abilities registry — document/subject-type based
const abilitiesRegistry = [];

const registerAbilities = (entry) => {
  abilitiesRegistry.push(entry);
};

const defineAbilityFor = async (user, membership) => {
  for (const entry of abilitiesRegistry) {
    if (user && entry.abilities) {
      entry.abilities(user, membership || null, { can, cannot });
    } else if (!user && entry.guestAbilities) {
      entry.guestAbilities({ can, cannot });
    }
  }
  return build();
};

const isAllowed = async (req, res, next) => {
  const ability = await defineAbilityFor(req.user, req.membership || null);
  const subjectInfo = resolveSubject(req); // checks req.task, req.upload, etc.
  if (subjectInfo) {
    // Document-level check with CASL subject()
    if (ability.can(action, subject(subjectInfo.subjectType, subjectInfo.document))) return next();
  } else {
    // Collection-level check — derive subject type from route path
    const subjectType = deriveSubjectType(req.route.path);
    if (subjectType && ability.can(action, subjectType)) return next();
  }
  // ...
};

// isOwner is REMOVED — no longer exported
export default { registerAbilities, defineAbilityFor, isAllowed, discoverPolicies, deriveSubjectType };
```

Key additions in the new policy middleware:
- `normalizeForCasl(doc)` — converts Mongoose documents to plain objects with string IDs for CASL condition matching.
- `resolveSubject(req)` — maps `req.task`, `req.upload`, `req.model`, `req.membershipDoc`, `req.organization` to CASL subject types.
- `deriveSubjectType(routePath)` — maps route path prefixes to subject type strings for collection-level checks.
- `discoverPolicies(policyPaths)` — auto-discovers and registers ability builder functions from policy files.

##### Policy auto-discovery (`lib/services/express.js`)

**Before:**
```js
const initModulesServerPolicies = async () => {
  for (const policyPath of config.files.policies) {
    const policy = await import(path.resolve(policyPath));
    policy.default.invokeRolesPolicies();
  }
};
```

**After:**
```js
const initModulesServerPolicies = async () => {
  const policyMod = await import('../middlewares/policy.js');
  await policyMod.default.discoverPolicies(config.files.policies);
};
```

##### Module policies — before/after

**Tasks policy (`modules/tasks/policies/tasks.policy.js`)**

Before:
```js
import policy from '../../../lib/middlewares/policy.js';

const invokeRolesPolicies = () => {
  policy.registerRules([
    { roles: ['user'], actions: 'manage', subject: '/api/tasks' },
    { roles: ['user'], actions: 'manage', subject: '/api/tasks/:taskId' },
    { roles: ['guest'], actions: ['read'], subject: '/api/tasks/stats' },
    { roles: ['guest'], actions: ['read'], subject: '/api/tasks' },
  ]);
};
export default { invokeRolesPolicies };
```

After:
```js
export function taskAbilities(user, membership, { can }) {
  if (user.roles.includes('admin')) { can('manage', 'all'); return; }
  if (membership) {
    const organizationId = String(membership.organizationId);
    can('create', 'Task', { organizationId });
    can('read', 'Task', { organizationId });
    can('update', 'Task', { organizationId, user: String(user._id) });
    can('delete', 'Task', { organizationId, user: String(user._id) });
  } else {
    can('read', 'Task');
    can('create', 'Task');
    can('update', 'Task', { user: String(user._id) });
    can('delete', 'Task', { user: String(user._id) });
  }
}

export function taskGuestAbilities({ can }) {
  can('read', 'Task');
}
```

**Uploads policy (`modules/uploads/policies/uploads.policy.js`)**

Before:
```js
const invokeRolesPolicies = () => {
  policy.registerRules([
    { roles: ['user', 'admin'], actions: ['read', 'delete'], subject: '/api/uploads/:uploadName' },
    { roles: ['guest', 'user', 'admin'], actions: ['read'], subject: '/api/uploads/images/:imageName' },
  ]);
};
export default { invokeRolesPolicies };
```

After:
```js
export function uploadAbilities(user, membership, { can }) {
  if (user.roles.includes('admin')) { can('manage', 'all'); return; }
  can('read', 'Upload');
  can('delete', 'Upload', { 'metadata.user': String(user._id) });
}

export function uploadGuestAbilities({ can }) {
  can('read', 'Upload');
}
```

**Home policy (`modules/home/policies/home.policy.js`)**

Before:
```js
const invokeRolesPolicies = () => {
  policy.registerRules([
    { roles: ['guest'], actions: ['read'], subject: '/api/home/releases' },
    { roles: ['guest'], actions: ['read'], subject: '/api/home/changelogs' },
    { roles: ['guest'], actions: ['read'], subject: '/api/home/team' },
    { roles: ['guest'], actions: ['read'], subject: '/api/home/pages/:name' },
  ]);
};
export default { invokeRolesPolicies };
```

After:
```js
export function homeAbilities(user, membership, { can }) {
  can('read', 'Home');
}

export function homeGuestAbilities({ can }) {
  can('read', 'Home');
}
```

**Users account policy (`modules/users/policies/users.account.policy.js`)** — new file, replaces the user-related rules that were previously in a single users policy.

```js
export function userAccountAbilities(user, membership, { can }) {
  if (user.roles.includes('admin')) { can('manage', 'all'); return; }
  can('read', 'UserAccount');
  can('create', 'UserAccount');
  can('update', 'UserAccount');
  can('delete', 'UserAccount');
  can('update', 'UserSelf');
  can('delete', 'UserSelf');
}

export function userAccountGuestAbilities({ can }) {
  can('read', 'UserAccount');
}
```

**Users admin policy (`modules/users/policies/users.admin.policy.js`)** — new file.

```js
export function userAdminAbilities(user, membership, { can }) {
  if (user.roles.includes('admin')) {
    can('manage', 'UserAdmin');
    can('read', 'UserSelf');
  }
}
```

##### Remove `isOwner` from routes

In routes that previously used `policy.isOwner`, remove those calls. Ownership is now enforced by CASL conditions in `policy.isAllowed`.

**Tasks routes — before:**
```js
app.route('/api/tasks/:taskId')
  .all(passport.authenticate('jwt', { session: false }), policy.isAllowed)
  .get(tasks.get)
  .put(model.isValid(tasksSchema.TaskUpdate), policy.isOwner, tasks.update)
  .delete(policy.isOwner, tasks.remove);
```

**Tasks routes — after:**
```js
app.route('/api/tasks/:taskId')
  .all(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed)
  .get(tasks.get)
  .put(model.isValid(tasksSchema.TaskUpdate), tasks.update)
  .delete(tasks.remove);
```

Note: `organization.resolveOrganization` is added to org-scoped routes (tasks). The `policy.isOwner` calls are gone.

##### Remove `req.isOwner` from controllers

If your downstream project sets `req.isOwner` in any param middleware (e.g. `taskByID`), remove those assignments. They are no longer used.

##### Platform admin: `can('manage', 'all')`

Every policy's `abilities` function should start with:
```js
if (user.roles.includes('admin')) {
  can('manage', 'all');
  return;
}
```

This gives platform admins full access to everything, matching the old behavior where admins had `manage` on all routes.

#### Step 3: Organizations Module

The organizations module follows the standard Devkit module structure:

```
modules/organizations/
  controllers/
    organizations.controller.js          # CRUD + adminList + organizationByID param middleware
    organizations.membership.controller.js  # list, updateRole, remove + memberByID
  helpers/
    slug.js                              # slugify() + generateOrganizationSlug()
  migrations/
    20260310120000-organizations-init.js  # Creates default orgs for existing users, backfills tasks
  models/
    organizations.model.mongoose.js      # Organization Mongoose model (name, slug, domain, plan, createdBy)
    organizations.schema.js              # Zod validation schema
    organizations.membership.model.mongoose.js  # Membership Mongoose model (userId, organizationId, role)
    organizations.membership.schema.js   # Zod validation (MembershipUpdate)
  policies/
    organizations.policy.js              # CASL abilities for Organization + Membership subjects
  repositories/
    organizations.repository.js          # Data access for organizations
    organizations.membership.repository.js  # Data access for memberships
  routes/
    organizations.routes.js              # Organization CRUD + admin routes
    organizations.membership.routes.js   # Member management routes (nested under org)
  services/
    organizations.service.js             # Business logic for organizations
    organizations.membership.service.js  # Business logic for memberships
  tests/
    organizations.integration.tests.js
    organizations.membership.integration.tests.js
    organizations.migration.integration.tests.js
    organizations.migration.unit.tests.js
```

**Membership roles:**
- `owner` — full control over the organization and its members
- `admin` — can update the organization and manage members, but cannot delete the organization
- `member` — read-only access to the organization and its member list

#### Step 4: Org-scoped Middleware

##### New middleware: `lib/middlewares/organization.js`

The `resolveOrganization` middleware:
1. Reads the organization ID from `req.params.organizationId` or `req.user.currentOrganization`.
2. Loads the `Organization` document onto `req.organization`.
3. Loads the user's `Membership` document onto `req.membership`.
4. Platform admins (`roles: ['admin']`) bypass the membership check and receive a synthetic owner-level membership.
5. If no organization context is present, the middleware passes through silently (backward compatibility).

##### Add `organizationId` to existing models

**Task model** (`modules/tasks/models/tasks.model.mongoose.js`):
```js
organizationId: {
  type: Schema.ObjectId,
  ref: 'Organization',
},
```

**Upload model** (`modules/uploads/models/uploads.model.mongoose.js`) — inside `metadata`:
```js
metadata: {
  // ... existing fields
  organizationId: {
    type: Schema.ObjectId,
    ref: 'Organization',
  },
}
```

**Task Zod schema** (`modules/tasks/models/tasks.schema.js`):
```js
organizationId: z.string().trim().optional(),
```

##### Add `currentOrganization` to User model

**User model** (`modules/users/models/user.model.mongoose.js`):
```js
currentOrganization: {
  type: Schema.ObjectId,
  ref: 'Organization',
},
```

**User Zod schema** (`modules/users/models/user.schema.js`):
```js
currentOrganization: z.string().trim().optional(),
```

Also update `modules/auth/config/auth.development.config.js` to add `currentOrganization` to `whitelists.users.default` and `whitelists.users.update`.

##### Update task controllers and services

- `TasksService.list(organization)` — accepts optional organization, filters by `organizationId` when present.
- `TasksService.create(body, user, organization)` — sets `organizationId` on the task when an organization is provided.
- `tasks.controller.js` — passes `req.organization` to service calls.

##### Wire organization middleware into routes

Add `organization.resolveOrganization` to routes that need org context:

```js
import organization from '../../../lib/middlewares/organization.js';

// In task routes:
app.route('/api/tasks')
  .post(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed, ...);

app.route('/api/tasks/:taskId')
  .all(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed);
```

#### Step 5: Auth Updates

##### Signup flow with org creation

`modules/auth/controllers/auth.controller.js` now calls `AuthOrganizationService.handleSignupOrganization(user)` after creating the user. The response includes:

```json
{
  "user": { ... },
  "tokenExpiresIn": 1234567890,
  "organization": { "name": "...", "slug": "...", ... },
  "abilities": [ { "action": "read", "subject": "Task", ... }, ... ],
  "organizationSetupRequired": false,
  "type": "sucess",
  "message": "Sign up"
}
```

##### Auth organization service (`modules/auth/services/auth.organization.service.js`)

Handles four scenarios based on config:

| `organizations.enabled` | `autoCreate` | `domainMatching` | Behavior |
| ----------------------- | ------------ | ---------------- | -------- |
| `false`                 | -            | -                | Creates a silent default org named "{firstName}'s organization" |
| `true`                  | `false`      | -                | Returns null; user sets up org manually (`organizationSetupRequired: true`) |
| `true`                  | `true`       | `true`           | Joins existing org with matching email domain, or creates new domain-based org |
| `true`                  | `true`       | `false`          | Always creates a personal org |

##### Abilities in responses

The signup response includes `abilities` — an array of CASL rule objects that the frontend can use to build its own CASL ability instance for UI permission checks.

#### Step 6: Configuration

##### `organizations` config block

Added to `modules/auth/config/auth.development.config.js`:

```js
organizations: {
  enabled: false,     // when false, a silent default org is created for the user (B2C mode)
  autoCreate: true,   // when true, org is created/joined automatically at signup
  domainMatching: true, // when true, new users join existing orgs with matching email domain
},
```

Override via environment variables:
```bash
DEVKIT_NODE_organizations_enabled=true
DEVKIT_NODE_organizations_autoCreate=true
DEVKIT_NODE_organizations_domainMatching=false
```

##### User whitelists

`currentOrganization` is added to both `whitelists.users.default` and `whitelists.users.update` arrays so it can be read and updated via the API.

#### Step 7: Run Migration

The migration script runs automatically at boot (in `lib/app.js`, after MongoDB connects). No manual step is needed.

**What the `20260310120000-organizations-init.js` migration does:**

1. Finds all users who do not yet have a membership.
2. For each user, creates a personal organization (`"{firstName}'s organization"`) with a unique slug, and an `owner` membership.
3. Backfills `organizationId` on all tasks that are missing one, using the task owner's owner membership to determine the org.

**The migration is idempotent:** users who already have a membership are skipped, tasks with an existing `organizationId` are not touched. It is safe to run multiple times.

**Tracking:** Executed migrations are recorded in the `migrations` collection. The runner checks this collection before each run and skips already-executed scripts.

---

### Security Checklist

- [ ] Every route has a CASL policy (check `policy.isAllowed` is in every route chain)
- [ ] No route bypasses CASL (no unprotected endpoints)
- [ ] 403 tested for unauthorized access on every endpoint
- [ ] Ownership verified via CASL conditions (not `isOwner` middleware)
- [ ] Org isolation: no cross-org data leak (tasks filtered by `organizationId`)
- [ ] Platform admin access verified (`can('manage', 'all')`)
- [ ] Migration script is idempotent (safe to run repeatedly)
- [ ] `isOwner` middleware fully removed from all routes and controllers
- [ ] `req.isOwner` assignments removed from all param middleware

---

### Configuration Options

| Key | Type | Default | Description |
| --- | ---- | ------- | ----------- |
| `organizations.enabled` | `boolean` | `false` | `true` = B2B mode (explicit orgs), `false` = B2C mode (silent default org per user) |
| `organizations.autoCreate` | `boolean` | `true` | When enabled, automatically create/join an org at signup |
| `organizations.domainMatching` | `boolean` | `true` | When enabled + autoCreate, match new users to existing orgs by email domain |

---

### Rollback Plan

If you need to revert after merging:

1. **Git revert**: `git revert <merge-commit>` to undo the merge.
2. **Database cleanup** (optional, only if the migration has run):
   - The `organizations`, `memberships`, and `migrations` collections can be dropped if no production data depends on them.
   - The `organizationId` field on tasks and `currentOrganization` on users can be left in place (Mongoose ignores unknown fields) or removed via a manual migration script.
3. **Restore old policies**: The git revert will restore the old `invokeRolesPolicies` pattern and `isOwner` middleware.
4. **Restart the application**: The old boot sequence (without `migrations.run()`) will be restored.

> **Warning:** If users have already created organizations or memberships in production, dropping those collections will lose that data. Plan accordingly.

---

## Config file naming convention (2026-03-13)

All config files now follow the `module.env.kind.js` naming convention consistently.

### What changed

- **Global defaults renamed**: `config.{env}.js` → `{env}.config.js` (e.g. `development.config.js`)
- **Module defaults renamed**: `config.{module}.js` → `{module}.development.config.js` (e.g. `auth.development.config.js`)
- **Init files renamed**: `{module}.config.js` → `{module}.init.js` (e.g. `auth.init.js`) to avoid collision with config suffix
- **Loader updated**: `config/index.js` globs `modules/*/config/*.development.config.js` for defaults
- **Assets glob updated**: `config/assets.js` globs `modules/*/config/*.init.js` for module init files
- **Template renamed**: `config/defaults/myproject.config.js`

### Naming convention

| File type | Pattern | Example |
|-----------|---------|---------|
| Global default | `{env}.config.js` | `development.config.js` |
| Global override | `{env}.config.js` | `production.config.js` |
| Module default | `{module}.development.config.js` | `auth.development.config.js` |
| Module env override | `{module}.{env}.config.js` | `uploads.test.config.js` |
| Downstream project | `{project}.config.js` | `myproject.config.js` |
| Module init (Express) | `{module}.init.js` | `auth.init.js` |

### Placement strategy: semantic ownership

Config belongs to the module that **semantically owns** the data, even if other modules read it. Global keeps only pure infrastructure (db, cors, api, log, mailer, etc.). This enables autonomous, pluggable modules.

| Key | Owner | Why |
|-----|-------|-----|
| `jwt`, `sign`, `oAuth`, `zxcvbn`, `rateLimit` | `auth` | Auth defines how users authenticate |
| `whitelists`, `blacklists` | `users` | Users defines its own field visibility |
| `uploads`, `sharp` | `uploads` | Uploads defines its own processing rules |
| `organizations`, `roles`, `roleDescriptions`, `publicDomains` | `organizations` | Orgs defines its own structure |
| `repos` | `home` | Home defines its own data sources |
| `app`, `openapi`, `api`, `db`, `log`, `cors`, `cookie`, `mailer`, `seedDB` | global | Pure infrastructure, no module owns them |

### File layout

```text
config/defaults/
  development.config.js          ← infra only (app, openapi, api, db, log, csrf, cors, cookie, mailer, seedDB)
  production.config.js           ← production overrides (standalone)
  test.config.js                 ← test overrides (standalone)
  myproject.config.js            ← template for downstream projects

modules/auth/config/
  auth.init.js                   ← passport init (loaded by assets glob)
  auth.development.config.js     ← sign, jwt, oAuth, zxcvbn, rateLimit

modules/users/config/
  users.development.config.js    ← whitelists, blacklists

modules/uploads/config/
  uploads.development.config.js  ← uploads, sharp

modules/organizations/config/
  organizations.development.config.js ← organizations, roles, roleDescriptions, publicDomains

modules/home/config/
  home.development.config.js     ← repos
```

### Merge order (priority ascending)

1. Module defaults — `modules/*/config/*.development.config.js`
2. Global defaults — `config/defaults/development.config.js`
3. Global env overrides — `config/defaults/${NODE_ENV}.config.js` (if NODE_ENV ≠ development)
4. `DEVKIT_NODE_*` environment variables

### Custom environments

Create `NODE_ENV=staging` by adding any of:
- `config/defaults/staging.config.js` (global overrides)

### Downstream project config files

Files must be named `{projectname}.config.js`. A template is provided at `config/defaults/myproject.config.js`.

### Steps for downstream projects

1. Rename global config files: `config.{env}.js` → `{env}.config.js`
2. Rename module config files: `config.{module}.js` → `{module}.development.config.js`
3. Rename init files: `{module}.config.js` → `{module}.init.js`
4. Rename project config files: `config.{project}.js` → `{project}.config.js`
5. Run `npm run lint && npm test` to confirm everything works.

---

## Configuration split by module (2026-03-07)

The monolithic `config/defaults/development.js` has been split into per-module config files.

See "Config file naming convention (2026-03-13)" above for the current naming standard.

---

## `acl` → `@casl/ability` (2026-02-20)

`acl@0.4.11` (unmaintained since 2018) has been replaced by `@casl/ability`.

### What changed

- `lib/middlewares/policy.js` no longer exports `Acl`.
- Policy files now call `policy.registerRules([...])` instead of `policy.Acl.allow([...])`.
- `isAllowed` and `isOwner` middleware signatures are **unchanged** — routes do not need to be updated.

### HTTP method → CASL action mapping

| HTTP method     | CASL action |
|-----------------|-------------|
| `GET`           | `read`      |
| `POST`          | `create`    |
| `PUT` / `PATCH` | `update`    |
| `DELETE`        | `delete`    |
| `*` (all)       | `manage`    |

### Migration example

**Before (`acl`):**

```js
import policy from '../../../lib/middlewares/policy.js';

const invokeRolesPolicies = () => {
  policy.Acl.allow([
    {
      roles: ['user'],
      allows: [
        { resources: '/api/tasks', permissions: '*' },
        { resources: '/api/tasks/:taskId', permissions: '*' },
      ],
    },
    {
      roles: ['guest'],
      allows: [
        { resources: '/api/tasks/stats', permissions: ['get'] },
        { resources: '/api/tasks', permissions: ['get'] },
        { resources: '/api/tasks/:taskId', permissions: ['get'] },
      ],
    },
  ]);
};

export default { invokeRolesPolicies };
```

**After (`@casl/ability`):**

```js
import policy from '../../../lib/middlewares/policy.js';

const invokeRolesPolicies = () => {
  policy.registerRules([
    { roles: ['user'],  actions: 'manage',   subject: '/api/tasks' },
    { roles: ['user'],  actions: 'manage',   subject: '/api/tasks/:taskId' },
    { roles: ['guest'], actions: ['read'],   subject: '/api/tasks/stats' },
    { roles: ['guest'], actions: ['read'],   subject: '/api/tasks' },
    { roles: ['guest'], actions: ['read'],   subject: '/api/tasks/:taskId' },
  ]);
};

export default { invokeRolesPolicies };
```

### `defineAbilityFor` is now async

`policy.defineAbilityFor(user)` returns a `Promise<Ability>` (lazy-loads `@casl/ability` on first call). Express `isAllowed` middleware is `async` and works unchanged. If you test `defineAbilityFor` directly, `await` it:

```js
// Unit test
const ability = await policy.defineAbilityFor(null);
expect(ability.can('read', '/api/tasks')).toBe(true);
```

> **Jest note**: `policy.js` must be a static top-level import in the test file (not only reached via dynamic `import()`). This pre-loads the module in Jest's VM registry before policy files are dynamically imported in `beforeAll`.
> ```js
> import policy from '../../../lib/middlewares/policy.js'; // required at top level
> ```

### Steps for downstream projects

1. `npm remove acl && npm install @casl/ability`
2. Update every `modules/*/policies/*.policy.js` following the pattern above.
3. Remove any direct use of `policy.Acl` (it is no longer exported).
4. If you have unit tests that call `defineAbilityFor`, add `import policy from '...policy.js'` as a top-level static import and `await` the call.
5. Run `npm run lint && npm test` — all existing 403/200 assertions should pass unchanged.

---

## `@hapi/joi` → `zod@3` + `body-parser` / `swig` removed (2026-02-21)

`@hapi/joi` (abandoned), `body-parser` (built into Express 4.16+), `swig` and `consolidate` (template engine, unused in API-only mode) have been removed.

### What changed

- `lib/helpers/joi.js` deleted → `lib/helpers/zod.js` (zxcvbn `superRefine` helper).
- `lib/middlewares/model.js`: `getResultFromJoi(body, schema, options)` → `getResultFromZod(body, schema)` (no options arg).
- `model.isValid(schema)` middleware interface is **unchanged** — routes do not need updating.
- `config.joi` renamed to `config.validation`; `validationOptions` key removed (Zod handles stripping and defaults internally).
- PUT routes should use a `.partial()` schema (`TaskUpdate`, `UserUpdate`) for partial updates.

### Migration example

**Before (`@hapi/joi`):**

```js
import Joi from '@hapi/joi';

const TaskSchema = Joi.object().keys({
  title: Joi.string().trim().default('').required(),
  description: Joi.string().allow('').default('').required(),
});

export default { Task: TaskSchema };
```

**After (`zod@3`):**

```js
import { z } from 'zod';

const Task = z.object({
  title: z.string().trim().min(1),
  description: z.string().default(''),
}).strip();

const TaskUpdate = Task.partial();

export default { Task, TaskUpdate };
```

### Unit tests

Replace `schema.Task.validate(data, options)` with `schema.Task.safeParse(data)`. The result shape changes:

| | Joi | Zod |
|---|---|---|
| Success | `{ value: T, error: undefined }` | `{ success: true, data: T }` |
| Failure | `{ value: T, error: ValidationError }` | `{ success: false, error: ZodError }` |

Assertions like `expect(result.error).toBeFalsy()` / `.toBeDefined()` work unchanged. To verify field stripping, check `result.data?.unknownField` (not `result.unknownField`).

### Steps for downstream projects

1. `npm remove @hapi/joi body-parser swig consolidate && npm install zod@3`
2. Rewrite `modules/*/models/*.schema.js` using the Zod pattern above.
3. If you call `model.getResultFromJoi(body, schema, options)` directly, replace with `model.getResultFromZod(body, schema)`.
4. Rename `config.joi` → `config.validation` in all `config/defaults/*.js`; remove `validationOptions`.
5. Update unit tests from `.validate()` to `.safeParse()`.
6. Run `npm run lint && npm test` — all existing 422/200 assertions should pass unchanged.
