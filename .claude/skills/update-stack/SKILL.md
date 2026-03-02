---
name: update-stack
description: Merge the latest changes from the Devkit Node stack repository into a downstream project. Use when pulling stack updates, syncing with upstream via `git merge devkit-node/master`, or resolving merge conflicts from stack updates.
---

# Update Stack Skill

Two-phase workflow. Phase 1 brings the stack down ISO. Phase 2 aligns the project.

## Phase 1 — ISO merge

**Goal: stack modules and lib exit this phase identical to upstream. Zero downstream logic in them.**

Stack modules: `home`, `auth`, `users`, `tasks`, `uploads` — Stack core: `lib/`, `config/defaults/` (stack-owned files only — `config/defaults/<project>.js` is downstream-only and will never conflict)

### 1. Setup remote + merge

```bash
git remote get-url devkit-node >/dev/null 2>&1 || git remote add devkit-node https://github.com/pierreb-devkit/Node.git
git fetch devkit-node
git merge devkit-node/master
```

### 2. Resolve conflicts

| File | Rule |
|------|------|
| Stack module (`modules/home\|auth\|users\|tasks\|uploads`) | `git checkout --theirs <file>` |
| `lib/` | `git checkout --theirs <file>` (core framework — always ISO) |
| `config/defaults/development.js`, `production.js`, etc. | `git checkout --theirs <file>` (stack-owned defaults) |
| `package-lock.json` | `git checkout --theirs package-lock.json` — regenerate after `package.json` is resolved |
| `ERRORS.md` | Union merge — keep every line from both sides, never drop |
| `MIGRATION.md` (if present) | Read it (needed for Phase 2), then `git checkout --theirs MIGRATION.md` |
| `package.json` | `git checkout --ours package.json` then merge upstream version bumps |

After resolving `package.json`:

```bash
npm install --package-lock-only
git add package-lock.json
```

Stage all resolved files and complete the merge:

```bash
git add .
git merge --continue
```

### 3. `/verify`

All failures here are regressions from conflict resolution. Fix before Phase 2.

---

## Phase 2 — Project alignment

**Goal: project-specific modules work and match stack patterns.**

### 4. Apply MIGRATION.md (if present)

Read the last entries — they list breaking changes requiring updates in project modules. Apply each one to non-stack modules.

### 5. Align project modules

Diff project modules against `modules/tasks` (stack reference). Fix pattern drift per `ERRORS.md`:

- Layer order: Routes → Controllers → Services → Repositories → Models (no controller→repository direct calls)
- JSDoc on all functions
- `async/await + try/catch` in controllers and services

### 6. `/verify`
