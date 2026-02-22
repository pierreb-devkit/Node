# Devkit Node - Copilot Instructions

## Preflight

- Read `ERRORS.md` before proposing changes or code reviews
- If a new recurring mistake occurs, append one line to `ERRORS.md` using `[YYYY-MM-DD] <scope>: <wrong> -> <right>`

## Canonical commands

- Dev: `npm start` (alias: `npm run dev`)
- Debug: `npm run debug`
- Tests: `npm test` / `npm run test:unit` (one-shot) or `npm run test:watch` (watch)
- Coverage: `npm run test:coverage`
- Lint: `npm run lint`
- Lint fix: `npm run lint:fix`
- Format: `npm run format`
- Seed: `npm run seed:dev`
- Commit: `npm run commit`
- Release (CI): `npm run release:auto`

## Available prompts

Use `.github/prompts/*.prompt.md` for guided workflows:

| Task | Prompt file |
| ---- | ----------- |
| Verify | `.github/prompts/verify.prompt.md` |
| Feature | `.github/prompts/feature.prompt.md` |
| Create module | `.github/prompts/create-module.prompt.md` |
| Update stack | `.github/prompts/update-stack.prompt.md` |
| Naming | `.github/prompts/naming.prompt.md` |
| PR | `.github/prompts/pr.prompt.md` |

## Always-on guardrails

- Never commit secrets or credentials (`.env*`, `secrets/**`, keys, tokens)
- Do not introduce cross-module coupling without explicit justification
- Avoid risky renames or moves of core stack paths used by downstream merges
- Keep changes minimal and merge-friendly for downstream projects
- Flag security or mergeability risks explicitly in reviews
- Every new or modified function must have a JSDoc header: one-line description, `@param` for each argument, `@returns` if the function returns a value

## Architecture and modularity

- Layer order is strict: **Routes → Controllers → Services → Repositories → Models**
- Controllers must not call repositories directly — always go through services
- Each module is self-contained in `modules/{name}/`
- Shared code goes in `lib/helpers/` or `lib/services/` with explicit justification
- Keep tests in `modules/*/tests/`

## Naming conventions

- Folders: kebab-case
- Controllers: `{module}[.{name}].controller.js`
- Services: `{module}[.{name}].service.js`
- Repositories: `{module}.repository.js`
- Models (Mongoose): `{module}.model.mongoose.js`
- Schemas: `{module}.schema.js`
- Policies: `{module}[.{name}].policy.js`
- Routes: `{module}.routes.js`
- Tests: `{module}.{type}.tests.js`

## Definition of done

- `npm run lint` passes
- `npm test` passes
- Cross-module impact is documented and justified when present
