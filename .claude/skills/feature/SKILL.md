---
name: feature
description: >
  Use this whenever the user asks to "implement", "add", "build", "create",
  or "modify" a feature, endpoint, API, route, or module in this Node
  project. Three phases: Phase 0 scope analysis (flows + edge cases + plan
  validation, STOP for user), Phase 1 implementation (layered Routes →
  Controllers → Services → Repositories → Models, module-isolated), Phase 2
  Definition-of-Done checklist + /verify + /pull-request. Auto-runs
  /create-module if the target module doesn't exist.
---

# Feature Skill

## Phase 0.0 — Issue Claim (if invoked with `#N`)

**When this section runs:** only if the invocation provides a GitHub issue number, e.g. `/feature #1153`. Skip entirely for `/feature <freeform-spec>` (no issue to claim — proceed directly to Phase 0).

### 1. Read the issue state

```bash
gh issue view <N> --json number,title,state,body,createdAt,assignees,comments
```

If the command fails (issue not found, network down, missing scope) → **STOP** and surface the error to the user before proceeding. Do not silently fall through to the claim step.

If `state` is `closed` → **STOP**, ask the user (working on a closed issue is almost always wrong).

### 2. Detect collision

Inspect `assignees[]` and the most recent comment whose body starts with `WIP —` (em dash U+2014, not a hyphen — only the canonical em-dash form is detected; hyphen variants `WIP -` are silently ignored):

| Situation | Action |
|-----------|--------|
| `assignees` contains `@me` (current GitHub user) | Continue silently — resuming own work |
| Most recent `WIP —` comment by `@me` (any age) | Continue silently — resuming own work |
| `assignees` empty AND no `WIP —` comment from anyone | Proceed to claim (step 3) |
| `assignees` contains user ≠ `@me` | **STOP** — surface "Issue #N already assigned to <user>. Take over? (y/N)". Wait for explicit user confirmation. |
| Most recent `WIP —` comment by user ≠ `@me` AND `<24h` old | **STOP** — surface "Issue #N has fresh WIP from <user> (started <ts>). Collision likely. Continue anyway? (y/N)". Wait. |
| Most recent `WIP —` comment by user ≠ `@me` AND `>24h` old | Stale claim — surface "Issue #N has stale WIP from <user> (started <ts>, >24h). Reclaim? (y/N)". Wait. |

"Current GitHub user" = `gh api user --jq .login`. Run inline each time `@me` is compared (the call is fast and read-only).

### 3. Claim

If detection passed (or user confirmed override), run **both** commands:

```bash
gh issue edit <N> --add-assignee @me

gh issue comment <N> --body "WIP — session $(date -u +%Y%m%dT%H%M%SZ)-$(uuidgen | head -c 8), branch <branch-name>, started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Where `<branch-name>` is the branch this `/feature` invocation will use (planned name, even if not yet created). If the branch isn't decided yet, use `branch TBD`. Posting a follow-up comment with the real branch name after `/pull-request` creates it is best-effort manual — the linked PR superseding the WIP comment is what matters in practice.

### 4. Aged-scope gate (re-validate before implementing)

The issue `body` is the **primary scope source** — read it, not just the title (issues are often filed well ahead of execution, and the intended scope lives in the description). Before coding:

- If the issue is **old** (`createdAt` older than ~7 days), or its body references files, symbols, or routes that no longer match the current codebase → **re-validate the scope**: check the referenced code, summarize the drift ("the issue says X, the code now does Y"), and present it to the user for confirmation before proceeding. A stale scope implemented as-written ships against a codebase that has moved.
- Fresh issue with matching references → continue silently.
- If the user aborts at this gate, roll back the FULL claim from step 3 — `gh issue edit <N> --remove-assignee @me` AND delete the `WIP —` comment just posted (`gh api -X DELETE repos/<owner>/<repo>/issues/comments/<comment-id>` — capture the id when posting, or take the last own `WIP —` comment). Leaving the comment behind would make step 2 treat the aborted claim as resumable on the next run.

### 4b. Non-interactive invocation (orchestrated runs)

When the invoker's brief declares a **non-interactive run** (an orchestrating
agent executes the issue headlessly — no human present to answer), every
STOP-and-ask in this skill becomes a structured final line instead of a
question:

| Interactive behavior | Non-interactive replacement |
|---|---|
| Collision prompt (any `y/N` row of the table above) | Emit `SKIP: collision — <detail>` and stop |
| `gh` command failure (step 1) or `state == closed` | Emit `STOP: claim — <error>` and stop |
| Aged-scope drift confirmation (step 4) | Emit `STOP: freshness — <drift summary>` and stop |
| Phase 0 "Present plan & wait for validation" | Satisfied by the issue body when the brief states the scope was validated upstream; insufficient scope → emit `STOP: scope — <gap>` and stop |

Never wait on a prompt in a non-interactive run. If the stop happens after
the claim (step 3) already landed, roll the claim back first (step 4's
rollback: `--remove-assignee` + delete the `WIP —` comment) so the aborted
attempt doesn't read as live work on the next run. Interactive sessions keep
the exact behavior above.

### 5. Proceed to Phase 0

Continue to scope analysis below.

---

## Phase 0 — Scope Analysis (interactive, before coding)

### 1. Identify target module

- Read `ERRORS.md` for known bugs and non-obvious pitfalls to avoid before coding.
- Which module? Default to **ONE** unless justified.
- **If the module doesn't exist** → run `/create-module` to scaffold it first, then continue.

### 2. Module boundaries

- All new code isolated inside the target module (`modules/{module}/`)
- No modifications to shared core files (`lib/middlewares/`, `config/`) — except `config/templates/` for new email templates; additions to `lib/helpers/` or `lib/services/` require explicit justification
- Module registers its own capabilities via exports (policies, subjects) and file discovery (config auto-discovered by filepath pattern) — auto-discovered by the core

### 3. Analyze flows & edge cases

For each user-facing flow this feature creates or modifies, identify:

- **Happy path** — standard success scenario
- **Error path** — what fails, what does the user see?
- **"Last one" edge** — last owner, last org, last member, sole record
- **Retry edge** — can the user retry after failure/rejection? (check unique indexes)
- **Multi-user impact** — who else is affected? Do they need notification?

### 4. Check boilerplate resilience

- Works WITHOUT mailer configured? (graceful skip, no crash)
- Works WITHOUT organizations enabled?
- No hard dependency on external services for core flow?

### 4b. Minimal-code ladder (run before presenting)

Challenge every **mechanism** this change would introduce — a schema field, a flag, a collection, an abstraction, a scheduled job. Stop at the first rung that holds:

0. **Does a product decision remove it?** — accept the cost, accept the failure, do nothing, or surface it to the user.
1. **Already in this codebase?** — reuse the helper, service or pattern.
2. **In the standard library?** — use it.
3. **A native platform feature?** (DB constraint/index, framework built-in) — use it.
4. **An already-installed dependency?** — use it.
5. **One line, a constant, or config?** — make it that.
6. Only then: build it, minimal.

**Persisted state is the expensive rung.** A schema field, collection or flag encoding a *policy* (a known-bad marker, a cap, a memo of a past failure) is not a code choice — code is deleted, data is migrated. Rung 0 is mandatory for it, and it needs **explicit user confirmation in §5** before it is built.

**Never traded away** (lazy ≠ negligent): understanding the problem before picking a rung, validation at trust boundaries, error handling that prevents data loss, security, and anything the user explicitly asked for.

### 5. Present plan & ask questions

**STOP and present to the user:**
- Flows identified (happy + error + edge cases)
- Users impacted + notification plan
- **Ladder outcome (§4b)** — one line per rejected mechanism (`<mechanism> — simpler option <X> rejected because <reason>`), plus any persisted state awaiting confirmation. A change that adds a mechanism and rejects nothing means nobody looked.
- Open questions or scope decisions

**Wait for user validation before coding.** (Non-interactive runs: Phase 0.0
§4b — a validated issue body satisfies this step; never wait.)

## Phase 1 — Implementation

### 6. Apply layer rules

Strict order — never skip or reverse:

```
Routes → Controllers → Services → Repositories → Models
```

- **Controllers**: HTTP only, call services, format via `lib/helpers/responses.js`
- **Services**: Business logic, call repositories, throw `AppError`
- **Repositories**: Database only — sole layer importing mongoose

### 7. Apply modularity rules

- Isolate inside module boundary
- No cross-module imports unless justified (shared code → `lib/helpers/`)
- **No cross-module Repository/Model imports** — a service must never import another module's repositories or models; use the target module's Service instead
- Follow `/naming` conventions

### 8. Handle notifications

If an action affects another user:
- Use `lib/helpers/mailer/` abstraction (never nodemailer directly)
- Check `mailer.isConfigured()` — skip silently if not configured
- Create template in `config/templates/` for each new email type
- Send async, non-blocking (`.catch(() => {})`)

## Phase 2 — Definition of Done

### 9. Self-review checklist

**Edge cases:**
- [ ] "Last one" handled (last owner can't leave/be demoted)
- [ ] Retry works after rejection (unique indexes freed)
- [ ] Works without mailer (graceful skip)
- [ ] Error responses have user-friendly `description` field

**Tests:**
- [ ] Tests: add unit (`*.unit.tests.js`) + integration (`*.integration.tests.js`) tests. Add E2E (`*.e2e.tests.js`) only if the change affects a critical user flow (auth, org onboarding, invite/join).

**Schema consistency:**
- [ ] New enum values added to ALL schema definitions (Mongoose model `enum`, Zod `z.enum`, tests)
- [ ] Grep existing enum values to find all locations before committing

**Module autonomy:**
- [ ] No shared-file changes unless explicitly required; any `lib/helpers/` or `lib/services/` additions include explicit justification, and `config/templates/` is used for new email templates
- [ ] Module self-registers capabilities (subjects, abilities) via policy exports
- [ ] New routes/middleware defined inside the module boundary

**Modularity:**
- [ ] Isolated in ONE module (or justified)
- [ ] No cross-module Repository/Model imports (use target module's Service)
- [ ] Layer order respected

**Notifications:**
- [ ] Actions affecting other users trigger email (if configured)
- [ ] Templates created for each email type

**Error documentation:**
- [ ] If a non-obvious bug was fixed, add a single-line entry to `ERRORS.md` (root of repo) using format: `[YYYY-MM-DD] <scope>: <wrong> -> <right>` (see existing examples in `ERRORS.md`)

### 9b. Elegance check

For non-trivial changes: pause and ask yourself "is there a simpler or more elegant approach?" If the current implementation feels hacky, refactor before proceeding.

### 10. Run `/verify`

### 11. Run `/pull-request`
