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
