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
- [2026-03-11] architecture: importing mongoose in controllers/services/helpers -> mongoose must only be imported in repositories and models
- [2026-03-11] architecture: controller importing a Repository directly -> controllers call Services only; cross-module access goes through the other module's Service
- [2026-03-11] services: wrapping return values in Promise.resolve() -> unnecessary when calling async/promise-returning functions, just return directly
- [2026-03-13] architecture: service importing another module's Repository -> use target module's Service
- [2026-03-13] architecture: middleware using mongoose.model() directly -> use module's Service or Repository
- [2026-03-13] tests: test file placed outside its module (e.g. lib/middlewares/tests/) -> tests belong in modules/{module}/tests/
- [2026-03-13] docs: duplicate doc files covering the same topic (e.g. MIGRATION.md + MIGRATIONS.md) -> single file, no duplication
- [2026-03-14] middleware: assuming config section exists in all environments (e.g. `config.rateLimit`) -> always handle missing config gracefully (passthrough/no-op); dev config often omits sections that only prod defines
- [2026-03-15] cross-stack: changing a Node API without checking Vue E2E tests -> when modifying an endpoint Vue consumes, run Vue E2E tests before pushing
- [2026-03-15] pr scope: batching multiple unrelated fixes in one PR -> one fix = one PR to isolate blast radius and reduce iteration loops
- [2026-05-05] repository: Repository.update(doc) doing `new Model(doc).save()` rewrites the full document from in-memory state, silently clobbering any concurrent partial update that landed after the read -> always use `Model.updateOne({ _id }, { $set: ... })` or `findOneAndUpdate({ _id }, { $set: ... })` for partial updates to avoid race conditions; see comes-io/trawl_node#1115 comes-io/trawl_node#1116 comes-io/trawl_node#1118 + pierreb-devkit/Node#3605
- [2026-05-31] billing/stripe: reading `price.metadata.planId` in `customer.subscription.updated` webhook handler -> field is EMPTY in real Stripe webhook payloads (planId lives on the Product, not the Price); use a `priceId → plan` map built at boot from `config.stripe.prices` instead; see pierreb-devkit/Node#3742
- [2026-06-04] repository: top-level `const Foo = mongoose.model('Foo')` in a repository file -> this is evaluated at import time; safe in an HTTP server (loadModels() runs first) but silently crashes standalone scripts (crons, migrations) with `MissingSchemaError` when import order differs; tests miss it because jest mocks intercept the module entirely; fix = lazy getter `const Foo = () => mongoose.model('Foo')` (call sites: `Foo().find(...)`) or dynamic import after `loadModels()` in the entrypoint; see comes-io/trawl_node#1337 comes-io/trawl_node#1338 pierreb-devkit/Node#3789
