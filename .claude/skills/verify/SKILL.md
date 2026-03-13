---
name: verify
description: Run quality loop (lint + tests + edge case audit) to verify code quality, correctness, and feature completeness. Use when asked to check, validate, test, lint, verify, or audit code quality — or after making changes and before committing.
---

# Verify Skill

## Steps

1. **ERRORS.md scan** — check changed files against known wrong patterns.

2. **Architecture audit** — compare changed files against `tasks` reference module. Verify layer order and import rules from `CLAUDE.md`.
   - Cross-module check: no imports from another module's `repositories/` or `models/`

3. **Edge case audit** — for each new or changed service function:
   - "Last one" case handled? (last owner, last org)
   - Retry after rejection possible? (unique indexes freed)
   - Actions affecting other users send notification? (with mailer check)
   - Error responses include user-friendly `description`?

4. **Route smoke-test** — for each new/changed route: valid data, invalid data, unauthorized. Verify status codes and response shapes.

5. **Lint** — `npm run lint` (no auto-fix)

6. **Tests** — check if MongoDB is reachable (`curl -s http://localhost:27017` or equivalent):
   - **Infra up** → `npm run test:all` (unit + integration + E2E)
   - **Infra down** → `npm test` (unit only) + warn: "Integration/E2E skipped — run `docker compose -f docker-compose.test.yml up -d` for full coverage"

7. **Summary:** ✅ All passed → ready to commit | ❌ Failed → show failures, suggest fix
