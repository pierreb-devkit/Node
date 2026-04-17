---
name: verify
description: >
  Run this after every code change in this Node project, before committing,
  before opening a PR, or whenever the user says "verify", "check", "lint",
  "run tests", "audit". Diff audit (architecture, security, naming, error
  handling) → lint → tests + coverage gate. Coverage drops → add tests, never
  lower thresholds. Triggers on "is this ready to commit?", "any issues?",
  "tests passing?".
---

# Verify Skill

## Steps

1. **Diff audit** — review all changes (`git diff main...HEAD` or staged changes) using your knowledge of the stack:
   - Read `CLAUDE.md` and `ERRORS.md` for conventions, architecture, and known pitfalls
   - Read the `tasks` reference module structure for layer/naming conventions
   - Analyze the diff: architecture, security, logic, consistency, error handling
   - No hardcoded checklist — reason from context. Examples of what to catch:
     - Routes missing auth/policy middleware
     - Mongoose docs spread without `.toObject()`
     - Silent error swallowing (catch + console.log)
     - Config in wrong location, missing or orphaned files
     - Cross-module import violations
     - Module-specific logic added to shared files (`lib/middlewares/`, `lib/services/`, `config/`)
     - Module not self-registering its capabilities (subjects, abilities, config)
     - Cross-module dependencies that should use the target module's service instead
     - Inconsistent API response formats
     - Missing null/undefined checks on async returns
   - Fix all issues found before proceeding

2. **Lint** — `npm run lint`

3. **Tests + coverage** — check if MongoDB is reachable:
   - **Infra up** → `npm run test:coverage` (all tests + coverage enforcement)
   - **Infra down** → `npm run test:coverage -- --testPathPatterns='unit'` (unit only + coverage) + warn: "Integration/E2E skipped — run `docker compose -f docker-compose.test.yml up -d` for full coverage"
   - If coverage drops below thresholds (jest.config.js) → fail. Add tests, never lower thresholds.

4. **Summary:** ✅ All passed → ready to commit | ❌ Failed → show failures, fix, re-run
