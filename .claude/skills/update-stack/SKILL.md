---
name: update-stack
description: Merge the latest changes from the Devkit Node stack repository into a downstream project. Use when pulling stack updates, syncing with upstream via `git merge devkit-node/master`, or resolving merge conflicts from stack updates.
---

# Update Stack Skill

Pure git workflow for merging stack updates while preserving downstream customizations.

## Steps

### 1. Add the stack remote (if not already added)

```bash
git remote add devkit-node https://github.com/pierreb-devkit/Node.git
```

### 2. Fetch the latest stack changes

```bash
git fetch devkit-node
```

### 3. Merge the stack updates

```bash
git merge devkit-node/master
```

### 4. Handle conflicts

Focus on these high-conflict areas:

- `config/defaults/` — Merge stack defaults carefully, preserve downstream overrides
- `lib/services/` — Accept stack changes unless downstream has specific customizations
- `package.json` — Keep downstream dependencies, accept stack dependency updates
- `modules/*/` — Stack only ships `tasks`, `home`, `auth`, `users`, `uploads` — downstream modules are safe

### 5. Verify after merge

```bash
npm run lint
npm test
```

## Conflict Strategy

| File/Dir               | Strategy                                      |
| ---------------------- | --------------------------------------------- |
| `config/defaults/`     | Preserve downstream values, take stack structure |
| `lib/`                 | Prefer stack (core framework code)            |
| `modules/tasks/`       | Prefer stack (reference module)               |
| `modules/home/`        | Prefer stack (core module)                    |
| `modules/auth/`        | Prefer stack (security — take updates)        |
| `modules/users/`       | Prefer stack unless customized                |
| Custom modules         | Always keep downstream                        |
| `package.json`         | Merge carefully, keep both dependency sets    |

## Notes

- Stack modules (`tasks`, `home`, `auth`, `users`, `uploads`) are reference implementations — downstream may customize them
- Custom modules added downstream will never conflict
- After merge, check `config/defaults/development.js` to ensure new stack config keys are present
