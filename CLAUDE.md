# Devkit Node Stack - Claude Code Setup

This repository is the Node / Express / Mongoose / JWT stack from Devkit. It can run as a standalone backend or as part of a fullstack setup with companion stacks such as Vue or Swift.

It is designed to be cloned into downstream projects and kept up-to-date through upstream merges.

## How to use Claude Code here

Source of truth: `README.md` + `package.json` scripts.

The `.claude/` folder contains embedded settings, skills, and agents that are available immediately after cloning.

## Canonical commands

| Command          | Script                   | Description                                    |
| ---------------- | ------------------------ | ---------------------------------------------- |
| **Dev**          | `npm start`              | Start dev server at `http://localhost:3000/`   |
| **Dev (alias)**  | `npm run dev`            | Alias for `npm start`                          |
| **Debug**        | `npm run debug`          | Start with nodemon and inspector               |
| **Prod**         | `npm run prod`           | Start in production mode                       |
| **Test**         | `npm test`               | Run all tests (one-shot)                       |
| **Unit test**    | `npm run test:unit`      | Run unit tests once (alias of `npm test`)      |
| **Watch**        | `npm run test:watch`     | Run tests in watch mode                        |
| **Coverage**     | `npm run test:coverage`  | Generate test coverage                         |
| **Lint**         | `npm run lint`           | Check code quality                             |
| **Lint fix**     | `npm run lint:fix`       | Auto-fix linting issues                        |
| **Format**       | `npm run format`         | Format with Prettier                           |
| **Seed**         | `npm run seed:dev`       | Seed development database                      |
| **Commit**       | `npm run commit`         | Commit with commitizen                         |
| **Release**      | `npm run release`        | Manual release (standard-version)              |
| **Release (CI)** | `npm run release:auto`   | Semantic release for CI                        |
| **Docker**       | `docker-compose up`      | Start with docker-compose                      |

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

## Available embedded skills

Use `.claude/skills/*/SKILL.md` as the primary workflow source for Claude.

| Skill            | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `/verify`        | Run quality loop (lint + tests)                       |
| `/create-module` | Create a new module from the `tasks` template         |
| `/feature`       | Implement a feature while enforcing module isolation  |
| `/update-stack`  | Merge upstream stack updates into downstream projects |
| `/naming`        | Apply or audit naming conventions                     |
| `/pr`            | Full PR lifecycle: branch, commit, issue, monitor     |

## Embedded agent

- `stack-maintainer` (`.claude/agents/stack-maintainer.md`): quick review guard for mergeability, security, and modularity.

## Stack merge workflow

```bash
git remote add devkit-node https://github.com/pierreb-devkit/Node.git
git fetch devkit-node
git merge devkit-node/master
```

Resolve conflicts carefully to preserve downstream customizations and keep future merges clean.

## Definition of done

- `npm run lint` passes
- `npm test` passes
- Cross-module impact is documented and justified when present
