# Devkit Node Stack - Claude Code Setup

Node / Express / Mongoose / JWT stack from Devkit. Standalone backend or fullstack with Vue/Swift. Cloned into downstream projects, kept up-to-date via upstream merges.

## Quick start

- Source of truth: `README.md` + `package.json` scripts
- `.claude/` contains embedded settings and skills
- Read `ERRORS.md` before proposing changes — append new mistakes as `[YYYY-MM-DD] <scope>: <wrong> -> <right>`

## Architecture

**Layer order** (strict, never skip or reverse): Routes → Controllers → Services → Repositories → Models

- Each layer imports only the one directly below. `mongoose` exclusively in repositories/models.
- Controllers call services only — never repositories.
- Cross-module access via the other module's **service** (exception: service→repository to avoid circular deps).
- Shared code in `lib/helpers/` or `lib/services/` only with justification.
- Modularity, implementation rules, and definition of done → see `/feature`

## CASL authorization

- Policy files export `<module>Abilities(user, membership, { can, cannot })` + optional `<module>GuestAbilities`.
- Auto-discovered by `policy.discoverPolicies()` — no manual registration.
- Platform admins: `if (user.roles.includes('admin')) { can('manage', 'all'); return; }`
- Ownership via CASL conditions (`{ user: String(user._id) }`), not `isOwner` middleware.
- Org scoping: `{ organizationId: String(membership.organizationId) }` when membership present.
- `resolveSubject(req)` maps req properties to CASL subjects. `deriveSubjectType(routePath)` for collection-level checks.

## Identity module

- Located at `modules/identity-local/` — auth, organizations, memberships in one module.
- Swappable with `identity-clerk` (same interface, different provider).
- Membership roles: `owner`, `admin`, `member`.
- `resolveOrganization` middleware loads org + membership onto `req.organization` / `req.membership`.
- Config: `modules/organizations/config/organizations.development.config.js` → `organizations: { enabled, domainMatching }`.

## Migrations

- Files in `modules/<name>/migrations/` with date prefix (e.g. `20260310120000-organizations-init.js`).
- Export `up()`, auto-run at boot after MongoDB connects, tracked in `migrations` collection.
- Must be idempotent.

## Scripts & testing conventions

| Script | Command | Purpose |
|--------|---------|---------|
| `npm run dev` | `node --watch server.js` | Dev server with Node 22 native watch |
| `npm start` | `node server.js` | Production start |
| `npm test` | Jest unit only | Unit tests (`*.unit.tests.js`, no infra needed) |
| `npm run test:all` | Jest all | All tests (unit + integration + E2E, needs MongoDB) |
| `npm run test:unit` | Jest `--testPathPatterns='unit'` | Unit tests only |
| `npm run test:integration` | Jest `--testPathPatterns='integration'` | Integration tests (`*.integration.tests.js`, needs MongoDB) |
| `npm run test:e2e` | Jest `--testPathPatterns='e2e'` | E2E tests (`*.e2e.tests.js`, needs MongoDB) |
| `npm run test:watch` | Jest `--watchAll` | Re-run tests on file changes |

- Every new feature needs unit + integration tests
- E2E only for critical product flows (auth, org onboarding, invite/join)
- Docker: `docker compose -f docker-compose.test.yml up --build --abort-on-container-exit`

## Guardrails

- Never commit secrets (`.env*`, keys, tokens)
- No cross-module coupling without justification
- Keep changes minimal and merge-friendly for downstream
- Every function: JSDoc header (`@param`, `@returns`)
- PRs: always use `/pull-request` — never open manually
- After user correction, evaluate if the pattern belongs in `ERRORS.md`

## Workflow rules

- **Never push directly to master/main.** Always create a branch, push, create a PR, wait for CI green + review, then merge.
- **Never lower coverage thresholds** in `jest.config.js`. If coverage drops after adding code, write tests for the new project modules to bring it back above thresholds.
- **Audit existing modules before implementing.** Before creating new storage, file handling, or utility code, check `modules/` for existing solutions (e.g., `uploads` module for file storage via GridFS).
- **Always run `/verify` after any code change** before declaring done. CI must be green.

## Skills

| Skill | Description |
|---|---|
| `/feature` | Scope analysis → implement → DOD (includes `/create-module` if needed) |
| `/verify` | Lint + tests + edge case audit |
| `/naming` | File and folder naming conventions |
| `/pull-request` | Full PR lifecycle: draft → CI → monitor → iterate |
| `/update-stack` | Merge upstream stack updates |
| `/create-module` | Scaffold new module from `tasks` template |
