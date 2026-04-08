# Migrations

Breaking changes and upgrade notes for downstream projects.

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

This guide is for downstream projects (e.g. lou-node, pierreb-node) migrating to the new organizations + CASL document-level authorization system introduced on the `feature/signup-org-flow` branch.

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
| `POST`   | `/api/organizations/:organizationId/members/invite` | JWT      | Invite a member                  |
| `PUT`    | `/api/organizations/:organizationId/members/:memberId` | JWT   | Update member role               |
| `DELETE` | `/api/organizations/:organizationId/members/:memberId` | JWT   | Remove member                    |

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
    organizations.membership.controller.js  # list, invite, updateRole, remove + memberByID
  helpers/
    slug.js                              # slugify() + generateOrganizationSlug()
  migrations/
    20260310120000-organizations-init.js  # Creates default orgs for existing users, backfills tasks
  models/
    organizations.model.mongoose.js      # Organization Mongoose model (name, slug, domain, plan, createdBy)
    organizations.schema.js              # Zod validation schema
    organizations.membership.model.mongoose.js  # Membership Mongoose model (userId, organizationId, role)
    organizations.membership.schema.js   # Zod validation (MembershipInvite, MembershipUpdate)
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
| `app`, `swagger`, `api`, `db`, `log`, `cors`, `cookie`, `mailer`, `seedDB` | global | Pure infrastructure, no module owns them |

### File layout

```text
config/defaults/
  development.config.js          ← infra only (app, swagger, api, db, log, csrf, cors, cookie, mailer, seedDB)
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
