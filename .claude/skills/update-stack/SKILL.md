---
name: update-stack
description: Merge the latest changes from the Devkit Node stack repository into a downstream project. Use when pulling stack updates, syncing with upstream via `git merge devkit-node/master`, or resolving merge conflicts from stack updates.
---

# Update Stack Skill

Two-phase workflow. Phase 1 brings the stack down ISO. Phase 2 aligns the project.

## Phase 1 — ISO merge

**Goal: stack modules and lib exit this phase identical to upstream. Zero downstream logic in them.**

Stack modules: `home`, `auth`, `users`, `tasks`, `uploads` — Stack core: `lib/` (existing files), `config/defaults/` (stack-owned files only)

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
| `lib/<existing-file>` | `git checkout --theirs <file>` (existing stack framework files — always ISO) |
| `config/defaults/development.js`, `production.js`, etc. | `git checkout --theirs <file>` (stack-owned defaults) |
| `package-lock.json` | `git checkout --theirs package-lock.json` — regenerate after `package.json` is resolved |
| `ERRORS.md` | Merge stack entries + project entries — never drop lines |
| `MIGRATION.md` (if present) | Read it (needed for Phase 2), then `git checkout --theirs MIGRATION.md` |
| `package.json` | `git checkout --ours package.json` then merge upstream version bumps |
| Downstream-only new files (new modules, helpers, lib additions, scripts) | Never delete — these do not exist in the stack, `git checkout --ours <file>` if flagged |

After resolving `package.json`:

```bash
npm install --package-lock-only
git add package-lock.json
```

Stage all resolved files and complete the merge:

```bash
git add -u
git merge --continue
```

### 3. `/verify`

Failures typically indicate regressions from conflict resolution — fix these before Phase 2. However, if failures originate from stack module code itself (see 3bis), report them upstream.

### 3bis. Report stack issues

If `/verify` failures originate from **stack module code** (`home`, `auth`, `users`, `tasks`, `uploads`) or **stack core** (`lib/`, `config/defaults/`) and not from conflict resolution mistakes, open a GitHub issue on `pierreb-devkit/Node`.

**How to determine the failure origin:**
- **Stack code failure:** error occurs in unmodified stack module files (resolved with `--theirs`)
- **Conflict resolution mistake:** error occurs in files you manually merged or in downstream-only modules

**Create the issue:**

```bash
gh issue create \
  --repo pierreb-devkit/Node \
  --title "fix(scope): <short description>" \
  --body "$(cat <<'BODY'
## Problem
<failing command output>

## Affected file(s)
<list>

## Steps to reproduce
<steps>
BODY
)" \
  --label "Fix"
```

Proceed to Phase 2 and track the upstream fix separately — do not block downstream alignment on it.

---

## Phase 2 — Project alignment

**Goal: project-specific modules work and match stack patterns.**

### 4. Apply MIGRATION.md (if present)

Read the last entries — they list breaking changes requiring updates in project modules. Apply each one to non-stack modules.

### 5. Align project modules

Diff project modules against `modules/tasks` (stack reference). Fix any pattern drift flagged by `ERRORS.md`.

### 6. `/verify`
