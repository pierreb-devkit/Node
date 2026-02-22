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