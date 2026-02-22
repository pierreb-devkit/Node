---
name: pr
description: Full PR lifecycle for Devkit stacks. Use when: creating a branch for new work, committing changes, opening a pull request, or iterating on PR review feedback. Covers branch naming, commit-on-demand (never without explicit request), issue creation or linking, PR creation following .github/pull_request_template.md with correct labels, draft PR workflow, CI failure handling, conflict resolution, and a monitoring loop (Copilot, codecov, codeclimate, sonarcloud, coderabbit) that iterates until zero new review comments remain.
---

# PR Skill

Manage the full lifecycle of a pull request: branch → commit → issue → PR (draft) → CI → ready → monitor → iterate.

**Golden rules**
- Never commit or push without an explicit user request
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

## 3. Verify before PR

Run `/verify` and fix all failures before opening the PR.

## 4. Issue

Search for an existing issue first:

```bash
gh issue list --search "<topic>" --state open
```

- **Issue found** → note the number, use `Closes #N` in the PR body
- **No issue found** → create one with the appropriate template:

```bash
# Check available labels first
gh label list

# Create issue — opens the browser form (required for YAML issue templates)
gh issue create --web
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

Once CI passes and the PR is ready for human review, convert to ready:

```bash
gh pr ready <number>
```

> Note: some bots (CodeRabbit, etc.) only trigger on ready PRs, not drafts. The monitor loop in step 6 starts after this conversion.

## 6. Monitor loop

Repeat until a full review pass produces **zero new actionable comments**.

### 6a. Wait for CI — fix failures first

After opening the PR or pushing fixes, wait for CI checks:

```bash
gh pr checks <number> --watch
```

**If any check fails or warns** → treat failures and bot warnings (e.g. CodeRabbit "Description check") as actionable. Fix the issue, commit, push, and re-run `--watch`. Do not read review feedback until all CI checks pass with no warnings on required sections.

Once all checks pass, wait **4–5 minutes** — bots that react to CI results (codecov, codeclimate, sonarcloud) post shortly after. Then read all feedback.

### 6b. Read all feedback

```bash
gh pr view <number> --json number,title,reviews,comments
```

Read bot comments (codecov, codeclimate, sonarcloud, coderabbit):

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)
gh api repos/$OWNER/$REPO/issues/<number>/comments --paginate
gh api repos/$OWNER/$REPO/pulls/<number>/comments --paginate
```

**Actionable** (must fix): change requests, bug reports, missing tests, security issues, failing suggestions with code.

**Informational** (skip): "LGTM", approvals, "coverage up from X% to Y%", "no issues found", style preferences without a change request.

### 6c. Fix all actionable comments from this pass

Fix all actionable comments in one batch, then:

1. Commit all fixes in one commit: `npm run commit`
2. For each fixed comment: reply citing the commit SHA
3. For each fixed comment: resolve the thread

One commit per pass keeps the history clean while keeping each fix traceable to a SHA.

See `references/monitoring.md` for the exact gh API / GraphQL commands.

### 6d. Coverage gaps

When codecov or codeclimate reports missing coverage: add the missing tests, run `/verify`, commit.

### 6e. Re-trigger review

Push commits and wait. Reviews from bots (Copilot, coderabbit, codecov…) or humans will arrive on their own if configured. Do not attempt to trigger reviewers — that is outside the skill's scope and depends on each repo's setup.

> **Never post `@copilot review` as a PR comment.** That invokes the Copilot coding agent (which can open PRs and issues), not the code reviewer.

### 6f. Stop condition

All CI checks pass and a complete review pass (after the 4–5 min grace period) produces **zero new actionable comments** from all reviewers and bots.

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

After resolving conflicts, restart the monitor loop from step 6a — CI will re-run.
