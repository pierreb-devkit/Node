---
name: feature
description: Implement a new feature or modify existing functionality following the project's layered architecture and modularity rules. Use when adding features, modifying existing ones, or ensuring correct isolation within module boundaries.
---

# Feature Skill

Implement features with strict layer ordering and module isolation.

## Steps

### 1. Identify target module(s)

Before coding, determine:

- Which module(s) does this feature belong to?
- Default to **ONE module** unless strictly necessary
- If it spans multiple modules, explain why and minimize coupling

### 2. Apply layer rules

Respect the strict layer order — never skip or reverse it:

```
Routes → Controllers → Services → Repositories → Models
```

- **Routes** (`routes/`): Define HTTP endpoints, apply policy middleware
- **Controllers** (`controllers/`): Handle HTTP req/res, call services, format responses via `lib/helpers/responses.js`
- **Services** (`services/`): Business logic, call repositories, throw `AppError` for domain errors
- **Repositories** (`repositories/`): Database access only, use Joi schemas for validation
- **Models** (`models/`): Mongoose schema definition (`*.model.mongoose.js`) and Joi schema (`*.schema.js`)

### 3. Apply modularity rules

- **Isolate feature logic** inside the module boundary
- **Avoid cross-module imports** unless absolutely required
- If shared code is needed:
  - Place it in `lib/helpers/` or `lib/services/`
  - Provide **explicit justification** for why it must be shared
- Keep these inside the module (`modules/{module}/**`):
  - Controllers, services, repositories, models, schemas, policies, routes, tests

### 4. Use existing helpers

Before writing new utilities, check:

- `lib/helpers/responses.js` — JSend response wrapper
- `lib/helpers/AppError.js` — Custom error class for domain errors
- `lib/helpers/errors.js` — Error formatting utilities
- `lib/helpers/joi.js` — Shared Joi validation helpers
- `lib/middlewares/policy.js` — Authorization middleware
- `lib/middlewares/model.js` — Model middleware

### 5. Follow API response format

All API responses must use the JSend wrapper from `lib/helpers/responses.js`:

```js
// Success
responses.success(res, 'task list')(data);
// Error
responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))(err);
```

### 6. Run verify

```bash
npm run lint
npm test
```

## Notes

- Config is loaded from `config/` and overridable via `WAOS_NODE_*` env vars
- Authentication is handled via Passport JWT middleware — don't reimplement
- All policies must use `lib/middlewares/policy.js` patterns
