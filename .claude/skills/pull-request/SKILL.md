---
name: pull-request
description: Full PR lifecycle — branch, commit, issue, draft PR, CI, ready, autonomous monitor loop (fix comments, resolve threads, iterate until CI green and zero actionable threads).
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

Run `/verify` and fix all failures before opening the PR.

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
REPEAT:
  1. Wait for CI            → sleep 30 then gh pr checks <number> --watch
  2. If CI fails            → fix, /verify, commit, push, GOTO 1
  3. Grace period           → sleep 180 + adaptive check (see 6b)
  4. Read all feedback      → unresolved threads only (see 6b)
  5. If actionable comments → fix all, /verify, commit, push, reply, resolve, GOTO 1
  6. If zero new actionable → check branch protection (see 6f), then STOP ✓
```

### 6a. Wait for CI

After any push (including force-push after rebase), wait before watching to let CI register the new run:

```bash
sleep 30
gh pr checks <number> --watch
```

If `--watch` returns `no checks reported`, the run hasn't started yet — retry:

```bash
# Retry until checks appear (max 5 attempts, 30s apart)
for i in 1 2 3 4 5; do
  if output=$(gh pr checks <number> 2>&1); then
    if echo "$output" | grep -q "no checks reported"; then
      sleep 30  # checks not started yet
    else
      echo "$output" && break  # checks detected
    fi
  else
    echo "$output" >&2 && sleep 30  # gh command failed, retry
  fi
done
gh pr checks <number> --watch
```

**If all 5 retries fail and no checks appear**, CI may be disabled or misconfigured — report to the user and stop.

**If any check fails** → treat as actionable. Fix the issue, run `/verify`, commit, push, and restart from the top of the loop. Do not read review feedback until all CI checks pass.

### 6b. Read all feedback — unresolved threads only

After CI passes, apply the grace period:

```bash
sleep 180
```

If after 3 min the total bot comment count is 0, wait an extra 2 min and re-check (slow bots on large PRs):

```bash
TOTAL=$(gh api repos/$OWNER/$REPO/issues/$PR/comments --paginate | jq -s 'add | length')
[ "$TOTAL" -eq 0 ] && sleep 120
```

Then read **only unresolved threads** — already-resolved threads from previous passes must be ignored:

```bash
# Reviews and PR-level comments
gh pr view $PR --json reviews,comments

# Inline review comments — all, then filter unresolved via GraphQL (see references/monitoring.md)
gh api repos/$OWNER/$REPO/pulls/$PR/comments --paginate | jq 'map({id, user: .user.login, body})'

# Bot / issue comments
gh api repos/$OWNER/$REPO/issues/$PR/comments --paginate | jq 'map({id, user: .user.login, body})'

# Unresolved threads only (source of truth for what still needs fixing)
# → see references/monitoring.md "List unresolved threads"
```

**New actionable** = unresolved review threads not yet replied to in this pass.

**Actionable** (must fix): change requests, bug reports, missing tests, security issues, code suggestions.

**Informational** (skip): "LGTM", approvals, "coverage up from X% to Y%", "no issues found", style preferences without a change request.

### 6c. Fix all actionable comments from this pass

Fix all actionable comments in one batch, then:

1. Run `/verify` — never commit fixes without verifying first
2. Commit all fixes in one commit using a conventional message:
   ```bash
   git commit -m "fix(scope): address review feedback from pass N"
   ```
3. Push first — the commit must be visible to reviewers before replying:
   ```bash
   git push -u origin HEAD
   ```
4. For each fixed comment: reply citing the commit SHA (now visible to reviewers)
5. For each fixed comment: resolve the thread via GraphQL (see `references/monitoring.md`)

One commit per pass keeps the history clean while keeping each fix traceable to a SHA.

See `references/monitoring.md` for the exact gh API / GraphQL commands.

### 6d. Coverage gaps

When codecov or codeclimate reports missing coverage: add the missing tests, run `/verify`, include in the same commit batch.

### 6e. After pushing fixes

After a regular push, wait 30s before watching CI (new run takes time to register).
After a force-push (post-rebase), wait 30s before watching — the old run is being cancelled and replaced.

Loop back to step 6a. Do not attempt to trigger reviewers — reviews arrive on their own if the repo has auto-review configured.

> **Never post `@copilot review` as a PR comment.** That invokes the Copilot coding agent (which can open PRs and issues), not the code reviewer.

### 6f. Stop condition

All CI checks pass **and** a complete polling pass (after the grace period) produces **zero unresolved actionable threads**.

Before declaring done, check branch protection:

```bash
gh pr view <number> --json reviewDecision,mergeable \
  | jq '{reviewDecision, mergeable}'
```

- `reviewDecision: "APPROVED"` and `mergeable: "MERGEABLE"` → **STOP ✓**
- `reviewDecision: "REVIEW_REQUIRED"` → human review is required by branch protection rules — report this to the user and stop the loop
- `mergeable: "BLOCKED"` → something else is blocking merge (status check, conversation resolution) — report details to the user

**Safety limit:** stop after **10 iterations** of the main loop (the preliminary pass after `gh pr ready` is not counted) even if comments remain — report the situation to the user to avoid infinite loops from unsatisfiable reviewers.

## 7. Conflict resolution

If the branch has conflicts with the default branch (GitHub shows "This branch has conflicts" or `git status` shows conflicts):

```bash
git fetch origin
git rebase origin/HEAD
# Resolve conflicts in each file, then:
git add <resolved-files>
git rebase --continue
git push --force-with-lease origin HEAD
```

After force-push, restart the monitor loop from step 6a — wait 30s before watching CI.
