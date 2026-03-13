---
name: create-module
description: Create a new feature module by duplicating the canonical `tasks` module template. Use when adding a new module to the application, scaffolding a new domain area from scratch, or generating the boilerplate for a new feature.
---

# Create Module Skill

Create a new module by copying and renaming the `tasks` template module.

## Prerequisites

- The canonical template module `modules/tasks` must exist
- You need a name for the new module (kebab-case)

## Steps

### 1. Ask for the module name

Prompt user for the new module name in kebab-case (e.g., `my-feature`, `user-settings`)

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

### 5. Apply renames carefully

- Case-sensitive, whole-word matches where possible
- Show plan before applying if many files affected
- Don't rename unrelated code (e.g., "tasks" in comments about other features)

### 6. Verify & report

Run `/verify`, then report: module path, renamed tokens, lint/test results, next steps (customize schema/services — routes auto-discovered via `modules/*/routes/*.js`).
