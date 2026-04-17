# Monitor loop — full procedure

Full body of the autonomous monitor loop referenced from §6 of `SKILL.md`.
Load only when actively running the loop on a PR.

## Setup

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)
PR=<number>
```

After `gh pr ready`, run this loop yourself — do not wait for the user.

## Loop procedure

```text
consecutive_zero = 0

REPEAT:
  1. Wait for CI                        → sleep 30 then gh pr checks $PR --watch
  2. If CI fails                        → fix, /verify, commit, push, consecutive_zero=0, GOTO 1
  2b. Check mergeable status            → STATUS=$(gh pr view $PR --json mergeable --jq .mergeable)
                                           if STATUS == "UNKNOWN" → sleep 10, retry up to 3 times
                                           if STATUS == "CONFLICTING" → report to user and STOP
  3. Grace period                       → sleep 180 + adaptive check (see 6b)
  4. Re-check pending review checks     → gh pr checks $PR — if any still pending, GOTO 3
  5. Read all feedback                  → unresolved threads only (see 6b)
  6. If actionable comments             → fix all, /verify, commit, push, reply, resolve, consecutive_zero=0, GOTO 1
  7. If non-actionable unresolved       → reply all explaining why, resolve all, consecutive_zero=0, GOTO 5
  8. If zero unresolved threads         → consecutive_zero++
                                           if consecutive_zero >= 3 (~9 min) → check branch protection (see 6f), then STOP ✓
                                           else GOTO 3
```

## 6a. Wait for CI

After any push, wait 30s then watch:

```bash
sleep 30
gh pr checks "$PR" --watch
```

If `no checks reported`, retry up to 5 times (30s apart). If still no checks
after 5 retries, report to user and stop.

If any check fails → fix, `/verify`, commit, push, restart loop. Do not read
review feedback until CI passes.

## 6b. Read all feedback — unresolved threads only

Grace period: `sleep 180`. If 0 bot comments after 3 min, wait 2 more min.

Read **only unresolved threads** (resolved = ignored). Use `monitoring.md` as
source of truth.

```bash
# Optional context only (do not drive action from these):
# gh pr view $PR --json reviews,comments
# gh api repos/$OWNER/$REPO/pulls/$PR/comments --paginate | jq 'map({id, user: .user.login, body})'
# gh api repos/$OWNER/$REPO/issues/$PR/comments --paginate | jq 'map({id, user: .user.login, body})'
# Action source of truth: unresolved threads query in monitoring.md
```

**Actionable** (must fix): change requests, bug reports, missing tests,
security issues, code suggestions.

**Informational** (reply + resolve, no code change): approvals, coverage
reports, style preferences without change request, false positives. PR-level
comments (codecov, approvals) cannot be resolved via thread API — don't count
as unresolved.

## 6b-bis. Classify stack-level vs downstream comments (downstream projects only)

Skip when running directly on the stack repo. Requires `devkit-node` remote
(set up by `/update-stack`) — if missing, stop and report.

For each actionable comment, check if the file exists unmodified in upstream:

```bash
STACK_REPO=$(git remote get-url devkit-node 2>/dev/null | sed 's|.*github.com[:/]||;s|\.git$||')
STACK_DEFAULT_BRANCH=$(git remote show devkit-node 2>/dev/null | sed -n '/HEAD branch/s/.*: //p')
git fetch devkit-node "$STACK_DEFAULT_BRANCH" --quiet 2>/dev/null
# STACK if exists in upstream AND no local diff; else DOWNSTREAM
git cat-file -e "devkit-node/$STACK_DEFAULT_BRANCH:<file-path>" 2>/dev/null && \
  git diff --quiet "devkit-node/$STACK_DEFAULT_BRANCH" -- <file-path> 2>/dev/null
```

- **Stack-level** → create issue on stack repo with review comment details,
  reply with issue link, resolve thread. If `gh issue create` fails, fix
  locally instead.
- **Downstream** → fix locally (section 6c).

## 6c. Fix all actionable comments from this pass

Fix all actionable comments in one batch: `/verify` → commit → push → reply
with SHA → resolve threads via GraphQL (see `monitoring.md`). One commit per
pass. You MUST reply to every thread before resolving it — never resolve a
thread silently. The reply serves as audit trail.

## 6d. Coverage gaps

Add missing tests — never lower thresholds. Include in the same commit batch.

## 6e. After pushing fixes

Wait 30s before watching CI (regular or force-push). Loop back to 6a. Never
post `@copilot review` — it invokes the coding agent, not the reviewer.

## 6f. Stop condition

CI green AND 3 consecutive passes (~9 min of grace periods) with zero
unresolved threads. Mergeable status is also checked after every CI pass
(step 2b) — conflicts cause an early stop. Final branch protection check:

```bash
gh pr view "$PR" --json reviewDecision,mergeable | jq '{reviewDecision, mergeable}'
```

- `APPROVED` + `MERGEABLE` → STOP ✓
- `REVIEW_REQUIRED` → report to user, stop
- `CHANGES_REQUESTED` → report to user, stop
- `BLOCKED` → report details to user

Safety limit: 10 iterations max — report to user if still unresolved.
