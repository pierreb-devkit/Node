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
  0. Draft guard                        → if PR is still draft AND CI is green, flip to ready now (see 6-guard)
  1. Wait for CI                        → sleep 30 then gh pr checks $PR --watch
  2. If CI fails                        → fix, /verify, commit, push, consecutive_zero=0, GOTO 1
  2a. CI just turned green              → re-run the draft guard now, before proceeding (see 6-guard) —
                                           catches a pass that started draft+CI-red so the PR doesn't
                                           stay draft into the review wait below
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

## 6-guard. Draft ordering guard (belt-and-braces)

CodeRabbit never reviews a draft PR. Section 5 already flips the PR to ready
before this loop starts, but run this check at the top of **every** pass —
and again the moment CI turns green mid-pass (step 2a) — anyway: it covers a
loop entered before that flip, a rebase/force-push that reverted the PR back
to draft, or a pass that started draft with CI red:

```bash
STATUS=$(gh pr view "$PR" --json isDraft,statusCheckRollup)
IS_DRAFT=$(echo "$STATUS" | jq -r '.isDraft')
# green = rollup non-empty (an empty rollup right after a force-push/rebase must NOT read as green) AND
# every check is SUCCESS/NEUTRAL/SKIPPED (all non-blocking; a bare FAILURE/CANCELLED or still-pending check stays not-green)
CI_GREEN=$(echo "$STATUS" | jq -r '[.statusCheckRollup[]? | (.conclusion // .state)] | length > 0 and all(. as $s | ["SUCCESS","NEUTRAL","SKIPPED"] | index($s) != null)')

if [ "$IS_DRAFT" = "true" ] && [ "$CI_GREEN" = "true" ]; then
  gh pr ready "$PR" || { sleep 5; gh pr ready "$PR"; } || {
    echo "ERROR: gh pr ready failed twice — PR still draft, cannot proceed to review wait." >&2
    exit 1
  }
fi
```

If `gh pr ready` fails, retry once after a short sleep; if the retry also
fails, stop here — do not fall through to the review wait with the PR still
draft (that deadlocks on CodeRabbit, which never reviews a draft).

If still draft with CI red, do nothing — wait for CI to go green first (step
1). The instant CI turns green, step 2a re-runs this same guard within the
same pass (not "next pass") so a still-draft PR flips ready before
mergeability, grace period, or review-wait ever run.

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
