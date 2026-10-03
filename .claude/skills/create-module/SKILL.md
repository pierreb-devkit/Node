---
name: create-module
description: >
  Use this whenever the user asks to "create a module", "scaffold a feature",
  "add a domain", "new module called X", or starts work on a brand-new
  vertical (controller + service + repo + model + routes + tests). Duplicates
  the canonical `modules/tasks` template, applies kebab/Pascal/camel renames,
  and registers config-driven enums. A `crud-only` option scaffolds a leaner
  module for plain CRUD, skipping the bulk data service, the org integration
  test, and the OpenAPI yaml. Module stays self-contained — never modify
  shared `lib/` or `config/` to bolt on module logic.
---

# Create Module Skill

Create a new module by copying and renaming the `tasks` template module.

## Prerequisites

- The canonical template module `modules/tasks` must exist
- You need a name for the new module (kebab-case)

## Steps

### 1. Ask for the module name

Prompt user for the new module name in kebab-case (e.g., `my-feature`, `user-settings`), and whether it's plain CRUD (→ `crud-only`, see step 3) or needs the full template. Non-interactive run (no human to ask) → full template.

### 2. Derive naming conventions

Follow `/naming` for the full reference. Quick summary from the module name (e.g., `my-feature`):

- **kebab-case**: `my-feature` (folder names, file prefixes, routes)
- **PascalCase**: `MyFeature` (Mongoose model names, class names)
- **lowerCamelCase**: `myFeature` (variable names, function names, JS exports)
- **UPPER_SNAKE_CASE**: `MY_FEATURE` (constants)

### 3. Duplicate the module

```bash
cp -r modules/tasks modules/{new-module-name}
```

#### `crud-only` option

When the new module is plain CRUD with no bulk-import/export or multi-tenant need, scaffold it leaner by removing these **right after the copy, before step 4's renaming** (files are still named `tasks.*` at this point — the copy doesn't rename them):

- `services/tasks.data.service.js` — the bulk push/list/remove data service
- `tests/tasks.organization.integration.tests.js` — the org-scoped integration test
- `doc/tasks.yml` — the OpenAPI spec
- `tests/tasks.openapi-operationid.unit.tests.js` — it only exists to check the yaml above, now gone with it

Each removal leaves a dangling reference in the main integration test — clean it up in the same pass:

- In `tests/tasks.integration.tests.js`: drop the `TasksDataService` variable, its `import(...)` in `beforeAll`, and the whole `describe('Data', ...)` block that exercises it.

Then proceed to step 4, which renames what's left (including these surviving files) to `{new-module-name}`.

Skip this subsection entirely for a full-featured module — the plain copy already carries everything.

### 4. Rename references

Search and replace the following tokens across the new module:

- `tasks` → `{new-module-name}` (kebab-case)
- `Tasks` → `{NewModuleName}` (PascalCase)
- `task` → `{new-module}` (singular kebab-case, if applicable)
- `Task` → `{NewModule}` (singular PascalCase, if applicable)

Files to check in `modules/{new-module-name}/`:

- File names (controllers, services, repositories, models, schemas, policies, routes, tests)
- Mongoose model name and collection name
- Route paths and prefixes
- Joi validation schemas
- Policy function names
- Test descriptions and fixture data

#### Config-driven enums

Business values (plans, roles, statuses) must be driven by the module config, never hardcoded in models or schemas.

Pattern:
- Define values in `modules/{module}/config/{module}.development.config.js`
- Reference in Mongoose model: `enum: config.{section}.{enumName}`
- Reference in Zod schema: `z.enum(config.{section}.{enumName})`

Example: `config.billing.plans` used in both `billing.subscription.model.mongoose.js` and `billing.subscription.schema.js`.

> Reference: `modules/users/models/users.schema.js` uses `z.enum(config.whitelists.users.roles)`.

### 5. Module autonomy

- Everything the module needs lives inside `modules/{module}/` — policies, config, routes, tests, doc
- Module registers its own capabilities (subjects, abilities, config) via exports — auto-discovered by the core
- **NEVER modify shared files** (`lib/middlewares/`, `lib/services/`, `config/`) to add module-specific logic
- If the module needs authorization: create `policies/{module}.policy.js` with ability builder + subject registration exports

### 6. Apply renames carefully

- Case-sensitive, whole-word matches where possible
- Show plan before applying if many files affected
- Don't rename unrelated code (e.g., "tasks" in comments about other features)

### 7. Verify & report

Run `/verify`, then report: module path, renamed tokens, lint/test results, next steps (customize schema/services — routes auto-discovered via `modules/*/routes/*.js`).
