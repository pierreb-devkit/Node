# Migration Guide: Organizations & CASL v2

This guide is for downstream projects (e.g. lou-node, pierreb-node) migrating to the new organizations + CASL document-level authorization system introduced on the `feature/signup-org-flow` branch.

---

## Breaking Changes

### Authorization: CASL policies

- **Route-level rules replaced by document-level abilities.** Policy files no longer call `policy.registerRules()` with route paths. Instead, each policy file exports named functions (`<module>Abilities` and optionally `<module>GuestAbilities`) that receive `(user, membership, { can, cannot })` and define CASL conditions on subject types (e.g. `'Task'`, `'Upload'`).
- **`policy.isOwner` middleware removed.** Ownership is now enforced automatically via CASL conditions (e.g. `{ user: String(user._id) }`). Remove all `policy.isOwner` calls from routes and all `req.isOwner` assignments from controllers/param middleware.
- **`policy.registerRules()` removed.** Replaced by `policy.registerAbilities()` (called automatically by `policy.discoverPolicies()`).
- **Policy auto-discovery.** `initModulesServerPolicies()` in `lib/services/express.js` now calls `policy.discoverPolicies(policyPaths)` instead of looping over `invokeRolesPolicies()`.

### Auth responses

- **Signup response** now includes `organization`, `abilities` (array of CASL rules), and `organizationSetupRequired` fields.
- **JWT payload** remains `{ userId }` (unchanged), but the user's organization context is resolved server-side via `user.currentOrganization`.

### Models

- **User model**: new `currentOrganization` field (`ObjectId` ref to `Organization`).
- **Task model**: new `organizationId` field (`ObjectId` ref to `Organization`).
- **Upload model**: new `metadata.organizationId` field (`ObjectId` ref to `Organization`).
- **Task schema** (Zod): new optional `organizationId` field.
- **User schema** (Zod): new optional `currentOrganization` field; added to `whitelists.users.default` and `whitelists.users.update`.

### New MongoDB collections

| Collection     | Mongoose model | Purpose                                    |
| -------------- | -------------- | ------------------------------------------ |
| `organizations`| `Organization` | Multi-tenant organization records          |
| `memberships`  | `Membership`   | User-to-organization membership + role     |
| `migrations`   | `Migration`    | Tracks executed migration scripts          |

### New dependencies

None for Node (CASL `@casl/ability` was already installed). No new npm packages required.

### Configuration

- New `organizations` section in `modules/auth/config/config.development.js` with keys `enabled`, `autoCreate`, and `domainMatching`.

### New API endpoints

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

## Prerequisites

- MongoDB accessible and writable (the migration script creates documents at boot).
- Current stack version on `master` (before migration) — your downstream project should be up to date with the latest `master` before merging the feature branch.

---

## Step-by-step Migration

### Step 1: Migration System

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

### Step 2: CASL Refactor

#### Policy middleware (`lib/middlewares/policy.js`)

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

#### Policy auto-discovery (`lib/services/express.js`)

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

#### Module policies — before/after

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

#### Remove `isOwner` from routes

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

#### Remove `req.isOwner` from controllers

If your downstream project sets `req.isOwner` in any param middleware (e.g. `taskByID`), remove those assignments. They are no longer used.

#### Platform admin: `can('manage', 'all')`

Every policy's `abilities` function should start with:
```js
if (user.roles.includes('admin')) {
  can('manage', 'all');
  return;
}
```

This gives platform admins full access to everything, matching the old behavior where admins had `manage` on all routes.

### Step 3: Organizations Module

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

### Step 4: Org-scoped Middleware

#### New middleware: `lib/middlewares/organization.js`

The `resolveOrganization` middleware:
1. Reads the organization ID from `req.params.organizationId` or `req.user.currentOrganization`.
2. Loads the `Organization` document onto `req.organization`.
3. Loads the user's `Membership` document onto `req.membership`.
4. Platform admins (`roles: ['admin']`) bypass the membership check and receive a synthetic owner-level membership.
5. If no organization context is present, the middleware passes through silently (backward compatibility).

#### Add `organizationId` to existing models

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

#### Add `currentOrganization` to User model

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

Also update `modules/auth/config/config.development.js` to add `currentOrganization` to `whitelists.users.default` and `whitelists.users.update`.

#### Update task controllers and services

- `TasksService.list(organization)` — accepts optional organization, filters by `organizationId` when present.
- `TasksService.create(body, user, organization)` — sets `organizationId` on the task when an organization is provided.
- `tasks.controller.js` — passes `req.organization` to service calls.

#### Wire organization middleware into routes

Add `organization.resolveOrganization` to routes that need org context:

```js
import organization from '../../../lib/middlewares/organization.js';

// In task routes:
app.route('/api/tasks')
  .post(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed, ...);

app.route('/api/tasks/:taskId')
  .all(passport.authenticate('jwt', { session: false }), organization.resolveOrganization, policy.isAllowed);
```

### Step 5: Auth Updates

#### Signup flow with org creation

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

#### Auth organization service (`modules/auth/services/auth.organization.service.js`)

Handles four scenarios based on config:

| `organizations.enabled` | `autoCreate` | `domainMatching` | Behavior |
| ----------------------- | ------------ | ---------------- | -------- |
| `false`                 | -            | -                | Creates a silent default org named "{firstName}'s organization" |
| `true`                  | `false`      | -                | Returns null; user sets up org manually (`organizationSetupRequired: true`) |
| `true`                  | `true`       | `true`           | Joins existing org with matching email domain, or creates new domain-based org |
| `true`                  | `true`       | `false`          | Always creates a personal org |

#### Abilities in responses

The signup response includes `abilities` — an array of CASL rule objects that the frontend can use to build its own CASL ability instance for UI permission checks.

### Step 6: Configuration

#### `organizations` config block

Added to `modules/auth/config/config.development.js`:

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

#### User whitelists

`currentOrganization` is added to both `whitelists.users.default` and `whitelists.users.update` arrays so it can be read and updated via the API.

### Step 7: Run Migration

The migration script runs automatically at boot (in `lib/app.js`, after MongoDB connects). No manual step is needed.

**What the `20260310120000-organizations-init.js` migration does:**

1. Finds all users who do not yet have a membership.
2. For each user, creates a personal organization (`"{firstName}'s organization"`) with a unique slug, and an `owner` membership.
3. Backfills `organizationId` on all tasks that are missing one, using the task owner's owner membership to determine the org.

**The migration is idempotent:** users who already have a membership are skipped, tasks with an existing `organizationId` are not touched. It is safe to run multiple times.

**Tracking:** Executed migrations are recorded in the `migrations` collection. The runner checks this collection before each run and skips already-executed scripts.

---

## Security Checklist

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

## Configuration Options

| Key | Type | Default | Description |
| --- | ---- | ------- | ----------- |
| `organizations.enabled` | `boolean` | `false` | `true` = B2B mode (explicit orgs), `false` = B2C mode (silent default org per user) |
| `organizations.autoCreate` | `boolean` | `true` | When enabled, automatically create/join an org at signup |
| `organizations.domainMatching` | `boolean` | `true` | When enabled + autoCreate, match new users to existing orgs by email domain |

---

## Rollback Plan

If you need to revert after merging:

1. **Git revert**: `git revert <merge-commit>` to undo the merge.
2. **Database cleanup** (optional, only if the migration has run):
   - The `organizations`, `memberships`, and `migrations` collections can be dropped if no production data depends on them.
   - The `organizationId` field on tasks and `currentOrganization` on users can be left in place (Mongoose ignores unknown fields) or removed via a manual migration script.
3. **Restore old policies**: The git revert will restore the old `invokeRolesPolicies` pattern and `isOwner` middleware.
4. **Restart the application**: The old boot sequence (without `migrations.run()`) will be restored.

> **Warning:** If users have already created organizations or memberships in production, dropping those collections will lose that data. Plan accordingly.
