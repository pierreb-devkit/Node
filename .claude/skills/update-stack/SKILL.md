---
name: update-stack
description: >
  Use this whenever a downstream Node project needs to absorb upstream Devkit
  Node changes — triggers on "update stack", "sync with devkit", "merge
  upstream", "pull stack updates", "resolve stack conflicts". Two-phase: ISO
  merge (stack modules + lib stay byte-identical to upstream) then project
  alignment (apply MIGRATIONS.md, diff project modules vs `tasks` reference,
  /verify). Stack-code failures get an issue on `pierreb-devkit/Node`.
---

# Update Stack Skill

Two-phase workflow. Phase 1 brings the stack down ISO. Phase 2 aligns the project.

## Phase 1 — ISO merge

**Goal: stack modules and lib exit this phase identical to upstream. Zero downstream logic in them.**

Stack scope = every file under `modules/`, `lib/`, `config/` (defaults, templates, assets) that exists in `devkit-node/master`. Auto-discovered by the step 3ter gate; do not enumerate by hand.

### 1. Setup remote + merge

```bash
git remote get-url devkit-node >/dev/null 2>&1 || git remote add devkit-node https://github.com/pierreb-devkit/Node.git
git fetch devkit-node
git merge devkit-node/master
```

### 2. Resolve conflicts

| File | Rule |
|------|------|
| Stack module (`modules/home\|auth\|users\|tasks\|uploads\|billing`) | `git checkout --theirs <file>` |
| `lib/<existing-file>` | `git checkout --theirs <file>` (existing stack framework files — always ISO) |
| `config/defaults/development.js`, `production.js`, etc. | `git checkout --theirs <file>` (stack-owned defaults) |
| `package-lock.json` | `git checkout --theirs package-lock.json` — regenerate after `package.json` is resolved |
| `ERRORS.md` | Merge stack entries + project entries — never drop lines |
| `MIGRATIONS.md` (if present) | Read it (needed for Phase 2), then `git checkout --theirs MIGRATIONS.md` |
| `package.json` | `git checkout --ours package.json` then merge upstream version bumps |
| Downstream-only new files (new modules, helpers, lib additions, scripts) | Never delete — these do not exist in the stack, `git checkout --ours <file>` if flagged. Step 3ter warns on the ones that break the ownership rule; only a dead copy of a file the stack deleted gets removed |

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

If `/verify` failures originate from a **stack file** (any file under `modules/`, `lib/`, or `config/` present in `devkit-node/master`) and not from conflict resolution mistakes, open a GitHub issue on `pierreb-devkit/Node`.

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

### 3ter. Block on drift

After `/verify` passes, run a final diff sweep before starting Phase 2. Any shared non-test stack file that diverges from upstream blocks the flow. No ledger exception (user decision 2026-06-02 — drift must never happen, not be documented).

```bash
git fetch devkit-node master --quiet

# Project names = config/defaults/<name>.config.js files the stack does not ship.
projects=$(for c in config/defaults/*.config.js; do
  git cat-file -e "devkit-node/master:$c" 2>/dev/null || basename "$c" .config.js
done)
stack_modules=$(git ls-tree --name-only devkit-node/master modules/ | sed 's#^modules/##')

# True when the path carries a project name the way the ownership rule allows.
carries_project() {
  local f="$1" p
  for p in $projects; do
    case "$f" in
      *."$p".*|config/defaults/"$p".config.js|config/templates/"$p"/*) return 0 ;;
    esac
  done
  return 1
}

# True when the stack loads the path by glob or runs it by path (config/assets.js
# globs, the migration runner, CronJobs) — such a file is live without any import.
glob_registered() {
  case "$1" in
    modules/*/routes/*.js|modules/*/models/*.mongoose.js|modules/*/*.init.js|\
    modules/*/policies/*.js|modules/*/doc/*.yml|modules/*/doc/guides/*.md|\
    modules/*/crons/*.js|modules/*/migrations/*.js) return 0 ;;
  esac
  return 1
}

drift_found=0
while IFS= read -r f; do
  # Both sides exist + differ → drift
  if git cat-file -e "devkit-node/master:$f" 2>/dev/null && git cat-file -e "HEAD:$f" 2>/dev/null; then
    echo "BLOCK: drift on shared file: $f"
    echo "  Fix A — revert to upstream: git checkout devkit-node/master -- $f"
    echo "  Fix B — promote upstream:   open a devkit PR with the change, merge, /update-stack here"
    echo "  Fix C — relocate:           move logic to a downstream-only module or config/defaults/<project>.config.js"
    drift_found=1
  # Upstream has it, local doesn't → missing-locally
  elif git cat-file -e "devkit-node/master:$f" 2>/dev/null; then
    echo "BLOCK: missing locally (was on upstream): $f"
    echo "  Fix — restore: git checkout devkit-node/master -- $f"
    drift_found=1
  # Downstream-only file → WARN (never blocks) on the two ownership-rule breaks
  else
    # (b) a file the stack deleted, still here
    if [ -n "$(git log devkit-node/master --diff-filter=D --format=%h -1 -- "$f")" ]; then
      if case "$f" in */migrations/*) true ;; *) false ;; esac; then
        echo "WARN: stack deleted $f — never move or delete — migrations are recorded by path"
      elif glob_registered "$f"; then
        echo "WARN: stack deleted $f but it is registered by glob — move it to the project's own module"
      elif git grep -q -F -e "/$(basename "$f")" -- modules lib config server.js ':!*/tests/*' ":!$f"; then
        echo "WARN: stack deleted $f but something still imports it — move it to the project's own module"
      else
        echo "WARN: stack deleted $f and nothing imports it — dead copy, delete it"
      fi
    # (a) a new file inside lib/, config/ or a stack module folder without the project name
    else
      module=$(echo "$f" | sed -n 's#^modules/\([^/]*\)/.*#\1#p')
      in_stack_folder=0
      case "$f" in lib/*|config/*) in_stack_folder=1 ;; esac
      [ -n "$module" ] && echo "$stack_modules" | grep -qx "$module" && in_stack_folder=1
      if [ "$in_stack_folder" -eq 1 ] && ! carries_project "$f"; then
        echo "WARN: downstream file inside a stack folder without the project name: $f"
        case "$f" in
          */migrations/*) echo "  never move or delete — migrations are recorded by path" ;;
          *) echo "  generic → upstream it to the stack · project-only → move it to the project's own module" ;;
        esac
      fi
    fi
  fi
done < <(git diff --no-renames --name-only devkit-node/master HEAD -- modules lib config 2>/dev/null \
  | grep -vE "/(tests|__tests__)/" | grep -vE "\.(test|spec)\.(js|jsx|ts|tsx)$")

[ "$drift_found" -eq 1 ] && exit 1
echo "3ter: no drift — OK"
```

**Rules:**
- Block on ANY shared-file divergence. No "declare and skip" path — the `DOWNSTREAM_PATCHES.md` ledger model was abandoned 2026-06-02 (memory `feedback_no_dev_in_shared_modules`).
- Scan source is `git diff --name-only devkit-node/master HEAD` (bidirectional) — catches both files that differ AND files present upstream but missing locally (deleted downstream). The previous `git ls-files` approach only saw locally-present files.
- Test files (paths containing `/tests/` or `/__tests__/`, or filenames ending `.test.{js,jsx,ts,tsx}` / `.spec.{js,jsx,ts,tsx}`) are excluded — downstream test adaptations are acceptable.
- Downstream-only files never block; they **warn** when they break the ownership rule (see `CLAUDE.md` § Stack vs downstream ownership): (a) a file in `lib/`, `config/` or a stack module folder that does not carry the project name; (b) a file the stack deleted. List every warning in the report. Act only on a dead copy (stack deleted it, nothing imports it, and no glob in `config/assets.js`, the migration runner or a CronJob loads it): delete it. A file loaded by glob (routes, preroutes, `*.mongoose.js` models, `*.init.js`, policies, doc yml, crons) is live with no import — move it, never delete it. Never delete a file something imports, never a module a downstream router or `*.init.js` registers, and never move a migration file (migrations are recorded by path — a moved one re-runs).
- This gate runs **after** `/verify` (never blocks on transient verify failures) and **before** Phase 2 (failure is recoverable — no merge commit yet).

---

## Phase 2 — Project alignment

**Goal: project-specific modules work and match stack patterns.**

### 4. Apply MIGRATIONS.md (if present)

Read the last entries — they list breaking changes requiring updates in project modules. Apply each one to non-stack modules.

### 5. Align project modules

Diff project modules against `modules/tasks` (stack reference). Fix any pattern drift flagged by `ERRORS.md`.

### 6. `/verify`
