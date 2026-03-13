---
name: pull-request
description: Full PR lifecycle — branch, commit, issue, draft PR, CI, ready, autonomous monitor loop (fix comments, resolve threads, iterate until CI green and zero unresolved threads).
---

# Pull Request Skill

Manage the full lifecycle of a pull request: branch → commit → issue → PR (draft) → CI → ready → monitor → iterate.

**Golden rules**
- Never commit or push without an explicit user request (exception: the monitoring loop in section 6 is an autonomous workflow — once the user starts it, commits/pushes within the loop are implicitly authorized)
- Never work directly on `main` / `master`
- Never use `--no-verify`

## 1. Branch

Create a dedicated branch before any work:

```bash
git switch -c type/short-description   # e.g. feat/user-auth, fix/login-crash
```

Types: `feat`, `fix`, `docs`, `test`, `ci`, `build`, `style`, `refactor`, `perf`, `chore`.

## 2. Commit (on demand only)

Use commitizen — never write commit messages manually:

```bash
npm run commit
```

> **In the monitor loop (section 6)**, commitizen is interactive and cannot run autonomously.
> Use `git commit -m` directly with a conventional commit message instead:
> ```bash
> git commit -m "fix(scope): description of fixes applied in this pass"
> ```

## 3. Verify before PR

Run `/verify` and fix all failures before opening the PR. **Never lower coverage thresholds** — add tests instead.

## 4. Issue

Search for an existing issue first:

```bash
gh issue list --search "<topic>" --state open
```

- **Issue found** → note the number, use `Closes #N` in the PR body
- **No issue found** → create one via CLI:

```bash
gh label list   # pick the right label first

gh issue create \
  --title "type(scope): short description" \
  --body "## Problem
<describe the problem>

## Expected behaviour
<what should happen>" \
  --label "Fix"
```

Label priority: use repo labels from `gh label list` first. Fallback mapping from commit type:
`feat→Feat`, `fix→Fix`, `docs→Docs`, `test→Tests`, `ci→CI`, `build→Build`,
`style→Style`, `refactor→Refactor`, `perf→Perf`, `chore→Chore`.

## 5. PR creation

Open as **draft** first — CI runs immediately; some review bots (e.g. CodeRabbit) only trigger on ready PRs:

```bash
gh pr create --draft \
  --title "type(scope): description" \
  --body "$(cat <<'EOF'
<filled template>
EOF
)" \
  --label "Feat" \
  --assignee "@me"
```

PR title must follow `type(scope): description` (conventional commits). Link the issue with `Closes #N` in the body.

**Fill every required section of `.github/pull_request_template.md`:**
- Narrative sections (Summary, Why, Scope): write real content, no placeholders
- Checkbox sections (Validation, Guardrails): check each box that applies (`- [x]`), leave unchecked only what genuinely does not apply
- Follow any instructions in the template (e.g. "Delete this section if not applicable")

Once **draft CI passes** and the PR is ready for human review, convert to ready:

```bash
gh pr ready <number>
```

> Some bots (e.g. CodeRabbit) trigger on ready, not on CI completion. After converting, do a **preliminary review pass** before entering the main loop:
>
> ```bash
> sleep 180
> # Read feedback (see 6b) — fix any actionable comments and push before entering the loop
> ```
>
> If actionable comments exist: fix, `/verify`, commit, push, then enter the loop at step 6a.
> If none: enter the loop at step 6a directly.

## 6. Monitor loop (autonomous)

Set these variables once before running any loop command:

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)
PR=<number>
```

After `gh pr ready`, enter an autonomous polling loop. Do not wait for the user — drive the loop yourself until the stop condition is met.

### Loop procedure

```text
consecutive_zero = 0

REPEAT:
  1. Wait for CI                        → sleep 30 then gh pr checks <number> --watch
  2. If CI fails                        → fix, /verify, commit, push, consecutive_zero=0, GOTO 1
  3. Grace period                       → sleep 180 + adaptive check (see 6b)
  4. Re-check pending review checks     → gh pr checks <number> — if any still pending, GOTO 3
  5. Read all feedback                  → unresolved threads only (see 6b)
  6. If actionable comments             → fix all, /verify, commit, push, reply, resolve, consecutive_zero=0, GOTO 1
  7. If non-actionable unresolved       → reply all explaining why, resolve all, consecutive_zero=0, GOTO 5
  8. If zero unresolved threads         → consecutive_zero++
                                           if consecutive_zero >= 2 → check branch protection (see 6f), then STOP ✓
                                           else GOTO 3
```

### 6a. Wait for CI

After any push, wait 30s then watch:

```bash
sleep 30
gh pr checks "$PR" --watch
```

If `no checks reported`, retry up to 5 times (30s apart). If still no checks after 5 retries, report to user and stop.

**If any check fails** → fix, `/verify`, commit, push, restart loop. Do not read review feedback until CI passes.

### 6b. Read all feedback — unresolved threads only

Grace period: `sleep 180`. If 0 bot comments after 3 min, wait 2 more min.

Read **only unresolved threads** (resolved = ignored). See `references/monitoring.md` for exact commands.

```bash
gh pr view $PR --json reviews,comments
gh api repos/$OWNER/$REPO/pulls/$PR/comments --paginate | jq 'map({id, user: .user.login, body})'
gh api repos/$OWNER/$REPO/issues/$PR/comments --paginate | jq 'map({id, user: .user.login, body})'
# Unresolved threads → see references/monitoring.md
```

**Actionable** (must fix): change requests, bug reports, missing tests, security issues, code suggestions.

**Informational** (reply + resolve, no code change): approvals, coverage reports, style preferences without change request, false positives. PR-level comments (codecov, approvals) cannot be resolved via thread API — don't count as unresolved.

### 6b-bis. Classify stack-level vs downstream comments (downstream projects only)

Skip when running directly on the stack repo. Requires `devkit-node` remote (set up by `/update-stack`) — if missing, stop and report.

For each actionable comment, check if the file exists unmodified in upstream:

```bash
STACK_REPO=$(git remote get-url devkit-node 2>/dev/null | sed 's|.*github.com[:/]||;s|\.git$||')
git fetch devkit-node master --quiet 2>/dev/null
# STACK if exists in upstream AND no local diff; else DOWNSTREAM
git cat-file -e devkit-node/master:<file-path> 2>/dev/null && git diff --quiet devkit-node/master -- <file-path> 2>/dev/null
```

- **Stack-level** → create issue on stack repo with review comment details, reply with issue link, resolve thread. If `gh issue create` fails, fix locally instead.
- **Downstream** → fix locally (section 6c).

### 6c. Fix all actionable comments from this pass

Fix all actionable comments in one batch: `/verify` → commit → push → reply with SHA → resolve threads via GraphQL (see `references/monitoring.md`). One commit per pass.

### 6d. Coverage gaps

Add missing tests — **never lower thresholds**. Include in the same commit batch.

### 6e. After pushing fixes

Wait 30s before watching CI (regular or force-push). Loop back to 6a. Never post `@copilot review` — it invokes the coding agent, not the reviewer.

### 6f. Stop condition

CI green **and** 2 consecutive passes with zero unresolved threads. Then check branch protection:

```bash
gh pr view "$PR" --json reviewDecision,mergeable | jq '{reviewDecision, mergeable}'
```

- `APPROVED` + `MERGEABLE` → **STOP ✓**
- `REVIEW_REQUIRED` → report to user, stop
- `BLOCKED` → report details to user

**Safety limit:** 10 iterations max — report to user if still unresolved.

## 7. Conflict resolution

```bash
git fetch origin && git rebase origin/HEAD
# Resolve conflicts, then: git add <files> && git rebase --continue
git push --force-with-lease origin HEAD
```

After force-push, restart from 6a.
