---
name: naming
description: Check or apply file and folder naming conventions for this Node project. Use when creating new files or folders, renaming existing ones, auditing a module for naming consistency, or any time the correct name/path for a file is unclear.
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

### Naming Tokens

From a module name (e.g., `my-feature`):

- **kebab-case**: `my-feature` (folder names, file prefixes, route paths)
- **PascalCase**: `MyFeature` (Mongoose model names, class names)
- **lowerCamelCase**: `myFeature` (variable names, function names, JS exports)
- **UPPER_SNAKE_CASE**: `MY_FEATURE` (constants)

## Layer Order

Routes → Controllers → Services → Repositories → Models

Never skip layers. Controllers must not call repositories directly.
