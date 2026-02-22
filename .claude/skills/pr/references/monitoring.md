# PR Monitoring — gh API Reference

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)
PR=<number>
```

## List review comments (with IDs)

```bash
gh api repos/$OWNER/$REPO/pulls/$PR/comments --paginate \
  | jq '.[] | {id, body, user: .user.login, path, line}'
```

## List bot / issue comments

```bash
gh api repos/$OWNER/$REPO/issues/$PR/comments --paginate \
  | jq '.[] | {id, body, user: .user.login}'
```

## Reply to a review comment

```bash
gh api repos/$OWNER/$REPO/pulls/$PR/comments/$COMMENT_ID/replies \
  -X POST -f body="Fixed in $(git rev-parse --short HEAD): <explanation>"
```

## Reply to a bot / issue comment

```bash
gh api repos/$OWNER/$REPO/issues/$PR/comments \
  -X POST -f body="Fixed in $(git rev-parse --short HEAD): <explanation>"
```

## Get review thread IDs (for resolving)

```bash
gh api graphql -f query="{
  repository(owner: \"$OWNER\", name: \"$REPO\") {
    pullRequest(number: $PR) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { id body author { login } }
          }
        }
      }
    }
  }
}"
```

## Resolve a thread

```bash
gh api graphql -f query="mutation {
  resolveReviewThread(input: {threadId: \"THREAD_ID\"}) {
    thread { isResolved }
  }
}"
```

## After pushing fixes

Push commits and wait. Reviews arrive on their own if the repo has auto-review configured (rulesets, bots, etc.). Triggering reviewers is outside the skill's scope.

> **Never post `@copilot review` as a PR comment** — this invokes the Copilot coding agent
> (which can open PRs and issues), not the code reviewer.

## Full PR status summary

```bash
gh pr view $PR --json statusCheckRollup,reviews,reviewRequests | jq .
```
