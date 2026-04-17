---
name: naming
description: >
  Use this whenever a new file/folder is created or renamed in this Node
  project, when reviewing a module for consistency, or when the right path
  for a file is unclear. Also triggers on "what should I name this?", "is
  this file named correctly?", "audit module naming". Enforces kebab-case
  folders, `{module}[.{entity}].{type}.js` files, multi-entity rules, and
  the layer order Routes → Controllers → Services → Repositories → Models.
---

# Naming Skill

Audit or apply the project's file and folder naming conventions.

## Conventions

### Folders

| Location        | Case        | Example                           |
| --------------- | ----------- | --------------------------------- |
| Top-level dirs  | kebab-case  | `lib/`, `modules/`, `config/`     |
| Module dirs     | kebab-case  | `modules/tasks/`, `modules/home/` |
| Module sub-dirs | fixed names | `controllers/`, `services/`, `repositories/`, `models/`, `policies/`, `routes/`, `tests/`, `config/`, `doc/` |

### Files

| Type            | Pattern                               | Example                                                    |
| --------------- | ------------------------------------- | ---------------------------------------------------------- |
| Controller      | `{module}[.{name}].controller.js`     | `tasks.controller.js`                                      |
| Service         | `{module}[.{name}].service.js`        | `tasks.service.js`, `tasks.data.service.js`                |
| Repository      | `{module}.repository.js`              | `tasks.repository.js`                                      |
| Mongoose Model  | `{module}.model.mongoose.js`          | `tasks.model.mongoose.js`                                  |
| Sequelize Model | `{module}.model.sequelize.js`         | `tasks.model.sequelize.js`                                 |
| Schema          | `{module}.schema.js`                  | `tasks.schema.js`                                          |
| Policy          | `{module}[.{name}].policy.js`         | `tasks.policy.js`                                          |
| Router          | `{module}.routes.js`                  | `tasks.routes.js`                                          |
| Test            | `{module}.{type}.tests.js`            | `tasks.integration.tests.js`, `tasks.unit.tests.js`        |
| Config          | `{name}.js`                           | `app.js`, `default.js`                                     |

> `[.{name}]` is optional — the reference `tasks` module uses the short form (e.g., `tasks.controller.js`, `tasks.service.js`).

### Multi-entity modules

When a module contains multiple entities (e.g., `billing` with `subscription`, `organizations` with `membership`), files are still prefixed by the **module name**, not the entity:

| Correct | Wrong |
| --- | --- |
| `billing.subscription.model.mongoose.js` | `subscription.model.mongoose.js` |
| `billing.subscription.schema.js` | `subscription.schema.js` |
| `organizations.membership.model.mongoose.js` | `membership.model.mongoose.js` |
| `organizations.crud.service.js` | `crud.service.js` |

Pattern: `{module}.{entity}[.{name}].{type}.js`

### Naming Tokens

From a module name (e.g., `my-feature`):

- **kebab-case**: `my-feature` (folder names, file prefixes, route paths)
- **PascalCase**: `MyFeature` (Mongoose model names, class names)
- **lowerCamelCase**: `myFeature` (variable names, function names, JS exports)
- **UPPER_SNAKE_CASE**: `MY_FEATURE` (constants)

## Layer Order

Routes → Controllers → Services → Repositories → Models

Never skip layers. Controllers call services only. `mongoose` is imported exclusively in repositories and models.
