# Migrations

Breaking changes and upgrade notes for downstream projects.

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
