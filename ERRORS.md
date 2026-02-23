# AI Error Log

Use this file as a compact memory of recurring AI mistakes.

## Rules

- One error per line
- Keep each line actionable and specific
- Use format: `[YYYY-MM-DD] <scope>: <wrong> -> <right>`
- Add only confirmed/recurrent mistakes and avoid duplicates

## Entries

- [2026-02-22] functions: new or modified functions without JSDoc header -> always add JSDoc (description + `@param` for each arg + `@returns` for non-void return values and all async functions)
- [2026-02-22] tests: never patch code to pass a test -> if a test is wrong, fix the test; if logic needs refactoring, refactor it
- [2026-02-23] pr skill: stopping after `gh pr ready` -> always enter the monitor loop (wait CI → 3min grace → read feedback → iterate) until stop condition is met
- [2026-02-23] pr skill: skipping issue creation when none found -> always create a GitHub issue before opening a PR (`gh issue create --web` or via CLI)
- [2026-02-23] zod v4: z.string({ error: 'msg' }) does NOT override invalid_type message -> Zod v4 produces 'Invalid input: expected string, received number'; update test expectations accordingly and remove the no-op error option
