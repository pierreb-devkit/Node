---
name: verify
description: Run the quality loop (lint + tests) to verify code quality and correctness. Use after making any code changes, before committing, or when asked to check/verify the project works.
---

# Verify Skill

Run lint → tests and report results.

## Steps

1. Run `npm run test:lint` to check code quality (read-only, no auto-fix)
2. Run `npm test` to run all tests
3. Summarize results:
   - ✅ All checks passed → ready to commit
   - ❌ Some checks failed → show what failed and suggest next action

## Notes

- Use `npm run test:lint` (not `npm run lint`) — `lint` auto-fixes files which is not suitable for verification
- Does not run tests in watch mode (use `npm run test:watch` manually for that)
- Does not run coverage (use `npm run test:coverage` manually for that)
- Does not commit or push changes
