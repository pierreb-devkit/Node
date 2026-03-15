---
name: feature
description: Implement a new feature or modify existing functionality. Use when asked to implement, add, build, create, or modify a feature, endpoint, API, or module. Includes scope analysis, edge case detection, module scaffolding, implementation, and quality verification.
---

# Feature Skill

## Phase 0 — Scope Analysis (interactive, before coding)

### 1. Identify target module

- Which module? Default to **ONE** unless justified.
- **If the module doesn't exist** → run `/create-module` to scaffold it first, then continue.

### 2. Analyze flows & edge cases

For each user-facing flow this feature creates or modifies, identify:

- **Happy path** — standard success scenario
- **Error path** — what fails, what does the user see?
- **"Last one" edge** — last owner, last org, last member, sole record
- **Retry edge** — can the user retry after failure/rejection? (check unique indexes)
- **Multi-user impact** — who else is affected? Do they need notification?

### 3. Check boilerplate resilience

- Works WITHOUT mailer configured? (graceful skip, no crash)
- Works WITHOUT organizations enabled?
- No hard dependency on external services for core flow?

### 4. Present plan & ask questions

**STOP and present to the user:**
- Flows identified (happy + error + edge cases)
- Users impacted + notification plan
- Open questions or scope decisions

**Wait for user validation before coding.**

## Phase 1 — Implementation

### 5. Apply layer rules

Strict order — never skip or reverse:

```
Routes → Controllers → Services → Repositories → Models
```

- **Controllers**: HTTP only, call services, format via `lib/helpers/responses.js`
- **Services**: Business logic, call repositories, throw `AppError`
- **Repositories**: Database only — sole layer importing mongoose

### 6. Apply modularity rules

- Isolate inside module boundary
- No cross-module imports unless justified (shared code → `lib/helpers/`)
- **No cross-module Repository/Model imports** — a service must never import another module's repositories or models; use the target module's Service instead
- Follow `/naming` conventions

### 7. Handle notifications

If an action affects another user:
- Use `lib/helpers/mailer/` abstraction (never nodemailer directly)
- Check `mailer.isConfigured()` — skip silently if not configured
- Create template in `config/templates/` for each new email type
- Send async, non-blocking (`.catch(() => {})`)

## Phase 2 — Definition of Done

### 8. Self-review checklist

**Edge cases:**
- [ ] "Last one" handled (last owner can't leave/be demoted)
- [ ] Retry works after rejection (unique indexes freed)
- [ ] Works without mailer (graceful skip)
- [ ] Error responses have user-friendly `description` field

**Tests:**
- [ ] Tests: add unit + integration tests. Add E2E (`*.e2e.tests.js`) only if the change affects a critical user flow (auth, org onboarding, invite/join).

**Modularity:**
- [ ] Isolated in ONE module (or justified)
- [ ] No cross-module Repository/Model imports (use target module's Service)
- [ ] Layer order respected

**Notifications:**
- [ ] Actions affecting other users trigger email (if configured)
- [ ] Templates created for each email type

### 8b. Elegance check

For non-trivial changes: pause and ask yourself "is there a simpler or more elegant approach?" If the current implementation feels hacky, refactor before proceeding.

### 9. Run `/verify`

### 10. Run `/pull-request`
