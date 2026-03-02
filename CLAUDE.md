# Devkit Node Stack - Claude Code Setup

This repository is the Node / Express / Mongoose / JWT stack from Devkit. It can run as a standalone backend or as part of a fullstack setup with companion stacks such as Vue or Swift.

It is designed to be cloned into downstream projects and kept up-to-date through upstream merges.

## How to use Claude Code here

Source of truth: `README.md` + `package.json` scripts.

The `.claude/` folder contains embedded settings and skills that are available immediately after cloning.

## Canonical commands

Scripts: see `package.json` → `scripts` section.

## Preflight

- Read `ERRORS.md` before proposing changes or code reviews
- If the AI makes a new recurring mistake, append one line to `ERRORS.md` using `[YYYY-MM-DD] <scope>: <wrong> -> <right>`

## Modularity rules

- Keep each module as independent as possible
- Avoid cross-module imports and coupling
- Layer order is strict: **Routes → Controllers → Services → Repositories → Models**
- Controllers must not call repositories directly — always go through services
- Keep config, routes, and business logic inside the module boundary (`modules/{name}/`)
- Put shared code in `lib/helpers/` or `lib/services/` only with explicit justification
- Keep tests organized per module: `modules/*/tests/`

## Always-on guardrails

- Never commit secrets or credentials (`.env*`, `secrets/**`, keys, tokens)
- Do not introduce cross-module coupling without explicit justification
- Avoid risky renames or moves of core stack paths used by downstream merges
- Keep changes minimal and merge-friendly for downstream projects
- Flag security or mergeability risks explicitly in reviews
- Every new or modified function must have a JSDoc header: one-line description, `@param` for each argument, `@returns` for any non-void return value (always include `@returns` for async functions to document the resolved value)
- When shipping work to a pull request, always invoke `/pull-request` — never open a PR manually. The skill drives the full lifecycle: draft → CI → monitor loop → stop condition (CI green + zero actionable comments)

## Available embedded skills

Use `.claude/skills/*/SKILL.md` as the primary workflow source for Claude.

| Skill            | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `/verify`        | Run quality loop (lint + tests)                       |
| `/create-module` | Create a new module from the `tasks` template         |
| `/feature`       | Implement a feature while enforcing module isolation  |
| `/update-stack`  | Merge upstream stack updates into downstream projects |
| `/naming`        | Apply or audit naming conventions                     |
| `/pull-request`  | Full PR lifecycle: draft, CI, monitor loop, iterate   |

## Stack merge workflow

See README — stack merge workflow section.

## Definition of done

- `npm run lint` passes
- `npm test` passes
- Cross-module impact is documented and justified when present
