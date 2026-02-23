# PR Monitoring — gh API Reference

Set these variables once before running any command below:

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)
PR=<number>
```

## Wait for CI to start after a push

After any push (including force-push), give CI time to register the new run:

```bash
sleep 30
# Retry until checks appear (max 5 attempts, 30s apart)
for i in 1 2 3 4 5; do
  gh pr checks $PR 2>&1 | grep -v "no checks" && break
  sleep 30
done
gh pr checks $PR --watch
```

## List unresolved review threads (source of truth)

Use this — not the raw comments list — to determine what still needs fixing:

```bash
gh api graphql -f query='{
  repository(owner: "'"$OWNER"'", name: "'"$REPO"'") {
    pullRequest(number: '"$PR"') {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { body author { login } }
          }
        }
      }
    }
  }
}' | jq '.data.repository.pullRequest.reviewThreads.nodes | map(select(.isResolved == false)) | map({id, author: .comments.nodes[0].author.login, body: .comments.nodes[0].body[0:120]})'
```

## List all review comments (with IDs)

```bash
gh api repos/$OWNER/$REPO/pulls/$PR/comments --paginate \
  | jq 'map({id, user: .user.login, body: .body[0:100], line})'
```

## List bot / issue comments

```bash
gh api repos/$OWNER/$REPO/issues/$PR/comments --paginate \
  | jq 'map({id, user: .user.login, body: .body[0:100]})'
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

## Resolve a thread

Use the `id` field from the **List unresolved review threads** query above as `THREAD_ID`:

```bash
gh api graphql -f query='mutation {
  resolveReviewThread(input: {threadId: "THREAD_ID"}) {
    thread { isResolved }
  }
}'
```

## Check branch protection status

```bash
gh pr view $PR --json reviewDecision,mergeable \
  | jq '{reviewDecision, mergeable}'
```

- `APPROVED` + `MERGEABLE` → ready
- `REVIEW_REQUIRED` → human review required, report to user
- `BLOCKED` → something is blocking merge, report details to user

## Full PR status summary

```bash
gh pr view $PR --json statusCheckRollup,reviews,reviewRequests | jq .
```

> **Never post `@copilot review` as a PR comment** — this invokes the Copilot coding agent
> (which can open PRs and issues), not the code reviewer.
