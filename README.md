[![CI](https://github.com/pierreb-devkit/Node/actions/workflows/CI.yml/badge.svg)](https://github.com/pierreb-devkit/Node/actions/workflows/CI.yml)
[![codecov](https://codecov.io/gh/pierreb-devkit/Node/graph/badge.svg?token=5VB61OAHQX)](https://codecov.io/gh/pierreb-devkit/Node)
[![Dependabot badge](https://img.shields.io/badge/Dependabot-enabled-2768cf.svg?style=flat-square)](https://dependabot.com)
[![Known Vulnerabilities](https://snyk.io/test/github/pierreb-devkit/node/badge.svg?style=flat-square)](https://snyk.io/test/github/pierreb-devkit/node)

# :globe_with_meridians: [Devkit](https://github.com/pierreb-devkit) Node

## :book: Presentation

A Node / Express / Mongoose / JWT stack that can be run as a standalone backend or in a fullstack setup with another repo (ex: [Vue](https://github.com/pierreb-devkit/Vue), [Swift](https://github.com/pierreb-devkit/Swift)).

Designed to be cloned into downstream projects and kept up-to-date via `git merge` from the stack repo.

## :package: Technology Overview

| Subject      | Informations                                                                                                                                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture | Layered Architecture : everything is separated in layers, and the upper layers are abstractions of the lower ones, that's why every layer should only reference the immediate lower layer (vertical modules architecture with Repository and Services Pattern)                                                          |
| Server       | [Node >= 22](https://nodejs.org/en/) - [Express](https://github.com/expressjs/express) - [Helmet](https://github.com/helmetjs/helmet) - [CORS](https://github.com/expressjs/cors) <br> [nodemon](https://github.com/remy/nodemon)                                                                            |
| Database     | [MongoDB](https://www.mongodb.com/) - [Mongoose](https://github.com/Automattic/mongoose) - GridFS upload <br> [Sequelize](https://github.com/sequelize/sequelize) - PostgreSQL, MySQL, SQLite (option) <br> [JOI](https://github.com/hapijs/joi) - Models & Repository validation                                      |
| Security     | [passport-jwt](https://github.com/themikenicholson/passport-jwt) - JWT Stateless <br> [bcrypt](https://en.wikipedia.org/wiki/Bcrypt) - [zxcvbn](https://github.com/dropbox/zxcvbn) - Passwords <br> [CASL](https://casl.js.org/) - Document-level authorization <br> SSL - Express / Reverse Proxy                     |
| API          | [jsend](https://github.com/omniti-labs/jsend) - Default response wrapper: status, message, data or error                                                                                                                                                                                                              |
| Upload       | [Mongo GridFS](https://docs.mongodb.com/manual/core/gridfs/) - [Multer](https://github.com/expressjs/multer) - [Sharp](https://github.com/lovell/sharp) - Image stream, all content types                                                                                                                             |
| Testing      | [Jest](https://github.com/facebook/jest) - [SuperTest](https://github.com/visionmedia/supertest) - Coverage & Watch                                                                                                                                                                                                   |
| CI           | [GitHub Actions](https://github.com/pierreb-devkit/Node/actions)                                                                                                                                                                                                                                                       |
| Linter       | [ESLint](https://github.com/eslint/eslint) ecmaVersion latest                                                                                                                                                                                                                                                          |
| Developer    | [Dependabot](https://dependabot.com/) - [Snyk](https://snyk.io/test/github/pierreb-devkit/node) <br> [semantic-release](https://github.com/semantic-release/semantic-release) - [commitlint](https://github.com/conventional-changelog/commitlint) - [commitizen](https://github.com/commitizen/cz-cli)               |
| Dependencies | [npm](https://www.npmjs.com)                                                                                                                                                                                                                                                                                           |
| Deliver      | Docker & Docker-compose                                                                                                                                                                                                                                                                                                 |

## :tada: Features Overview

### Core

- **User** : classic register / auth or oAuth (Google, Apple) - profile management (update, avatar upload)
- **User data privacy** : delete all - get all - send all by mail
- **Admin** : list users - get user - edit user - delete user
- **Organizations** : multi-tenant organization management - create, update, delete orgs - member invite, role management (owner/admin/member) - platform admin org listing
- **CASL v2 Authorization** : document-level permission checks via [@casl/ability](https://casl.js.org/) - replaces route-level role rules with per-document conditions (ownership, org scope)
- **Migration System** : automatic database migrations at boot - tracks executed scripts in MongoDB - idempotent reruns

### Examples

- **Tasks** : list - get - add - edit - delete (org-scoped when organization context is present)
- **File Uploads** : get stream - add - delete - image stream & sharp operations

## :pushpin: Prerequisites

- Git - [Download & Install Git](https://git-scm.com/downloads)
- Node.js (22.x or 24.x) - [Download & Install Node.js](https://nodejs.org/en/download/)
  - Recommended: Use [nvm](https://github.com/nvm-sh/nvm) for Node version management
- MongoDB - [Download & Install MongoDB](https://www.mongodb.com/try/download/community)

## :boom: Installation

```bash
git clone https://github.com/pierreb-devkit/Node.git && cd Node
npm install
```

## :runner: Running Your Application

### Development

```bash
npm start   # or: npm run dev
```

Runs the server at `http://localhost:3000/`. For auto-reload during development, use `npm run debug` (nodemon).

**CORS Note:** When connecting to the Vue stack, ensure CORS is configured:

```bash
DEVKIT_NODE_cors_origin=['http://localhost:8080'] npm start
```

### Production

```bash
npm run prod
```

### Testing

```bash
npm test                       # Run all tests (one-shot)
npm run test:unit              # Run unit tests once (alias of npm test)
npm run test:watch             # Run tests in watch mode
npm run test:coverage          # Generate coverage report
npm run test:parallel-smoke    # Regression gate for per-pid test DB isolation (#3515)
```

Tests are organized per module in `modules/*/tests/`. The `test:parallel-smoke` script spawns N concurrent jest children against the same mongod and asserts none of them trample each other — gates against accidental regression of the per-pid `NodeTest_${pid}` default in `config/defaults/test.config.js`. Off the critical path in CI (own job), so it never blocks merges.

### Code Quality

```bash
npm run lint              # Check code quality (read-only)
npm run lint:fix          # Auto-fix code quality issues
npm run format            # Format code with Prettier
```

### Database Seeding

```bash
npm run seed:dev          # Seed development database
npm run seed:prod         # Seed production database
npm run seed:user         # Seed default user/admin only (no drop)
npm run seed:mongodrop    # Drop database (with confirmation)
```

### Commits & Releases

```bash
npm run commit                                    # Commit with commitizen
GITHUB_TOKEN=xxx npm run release:auto             # Semantic release (CI)
```

## :wrench: Configuration

Configuration is split between a **global** file and **per-module** files, then merged at startup into a single config object.

### File layout

Config files follow the `module.env.kind.js` naming convention. Init files (Express middleware like passport) use `module.init.js`.

```text
config/defaults/
  development.config.js          ← infra only (app, db, api, log, cors, cookie, mailer, seedDB)
  production.config.js           ← production overrides
  test.config.js                 ← test overrides

modules/<name>/config/
  <name>.development.config.js   ← module defaults (e.g. auth.development.config.js)
  <name>.init.js                 ← module init (e.g. auth.init.js — passport setup)
```

### Merge order (priority ascending)

| Layer | Source | Example |
|-------|--------|---------|
| 1 | Module defaults | `modules/*/config/*.development.config.js` |
| 2 | Global development defaults | `config/defaults/development.config.js` |
| 3 | Global env overrides | `config/defaults/<env>.config.js` |
| 3.5 | Per-module project overrides | `modules/*/config/*.<project>.config.js` |
| 4 | `DEVKIT_NODE_*` env vars | `DEVKIT_NODE_app_title='my app'` |

Layers 3 and 3.5 are only applied when `NODE_ENV` is not `development`. Layer 3.5 is only applied for non-standard environments (i.e. downstream project names).

### Merge semantics

- **Objects** are merged recursively — keys from higher layers override lower layers, unmentioned keys are preserved.
- **Arrays are replaced entirely** — a higher-priority layer defining a 2-item array replaces a 4-item array from a lower layer. Items are never merged by index.
- **`undefined` values** are skipped — they do not overwrite existing keys.

### Environment variables

```bash
DEVKIT_NODE_app_title='my app'               # sets config.app.title
DEVKIT_NODE_db_uri='mongodb://...'           # sets config.db.uri
```

### Downstream projects

When running a downstream project that clones this stack, set `NODE_ENV` to the project name and create matching config files:

```text
config/defaults/
  myproject.config.js            ← global project overrides (all modules)

modules/<name>/config/
  <name>.myproject.config.js     ← per-module project overrides (e.g. users.trawl.config.js)
```

Both file types are optional and can be used independently or together. Per-module files take priority over the global project config, allowing fine-grained overrides per module without polluting the global file.

## :building_construction: Organizations API

| Method   | Endpoint                                                | Auth      | Description                 |
| -------- | ------------------------------------------------------- | --------- | --------------------------- |
| `GET`    | `/api/organizations`                                    | JWT       | List user's organizations   |
| `POST`   | `/api/organizations`                                    | JWT       | Create organization         |
| `GET`    | `/api/organizations/:organizationId`                    | JWT       | Get organization            |
| `PUT`    | `/api/organizations/:organizationId`                    | JWT       | Update organization         |
| `DELETE` | `/api/organizations/:organizationId`                    | JWT       | Delete organization         |
| `GET`    | `/api/organizations/:organizationId/members`            | JWT       | List members                |
| `POST`   | `/api/organizations/:organizationId/members/invite`     | JWT       | Invite member               |
| `PUT`    | `/api/organizations/:organizationId/members/:memberId`  | JWT       | Update member role          |
| `DELETE` | `/api/organizations/:organizationId/members/:memberId`  | JWT       | Remove member               |
| `GET`    | `/api/admin/organizations`                              | JWT+Admin | List all organizations      |
| `GET`    | `/api/admin/organizations/:organizationId`              | JWT+Admin | Get any organization        |
| `DELETE` | `/api/admin/organizations/:organizationId`              | JWT+Admin | Delete any organization     |

> See [MIGRATIONS.md](MIGRATIONS.md) for the full migration guide from route-level CASL to document-level CASL v2.

## :whale: Docker

```bash
docker run --env DEVKIT_NODE_db_uri=mongodb://host.docker.internal/NodeDev --env DEVKIT_NODE_host=0.0.0.0 --rm -p 3000:3000 pierreb/node
```

Build yourself:

```bash
docker build -t pierreb/node .
```

With [Vue](https://github.com/pierreb-devkit/Vue) stack as frontend:

```bash
docker-compose up
```

## :robot: AI Setup

This stack ships preconfigured instruction and prompt files for Claude Code, GitHub Copilot, and OpenAI Codex. Each tool requires its own client installation and authentication — the repository provides the configuration so it works out-of-the-box once the tool is set up.

| Tool              | Config                                                              |
| ----------------- | ------------------------------------------------------------------- |
| Claude Code       | `.claude/` — skills embedded, works on clone                        |
| GitHub Copilot    | `.github/copilot-instructions.md` + `.github/prompts/`              |
| OpenAI Codex      | `AGENTS.md`                                                         |

### Claude Code — Available Skills

Skills available via `/verify`, `/feature`, `/create-module`, `/update-stack`, `/naming`, `/pull-request` — see `.claude/skills/` for details.

### Stack Merge Workflow

```bash
git remote add devkit-node https://github.com/pierreb-devkit/Node.git
git fetch devkit-node
git merge devkit-node/master
```

> Caution: resolve conflicts manually to preserve downstream customizations before pushing.

## :pencil2: Contribute

Open issues and pull requests on [GitHub](https://github.com/pierreb-devkit/Node).

## :scroll: History

This work is based on [MEAN.js](http://meanjs.org) and more precisely on a fork named [Riess.js](https://github.com/lirantal/Riess.js). The goal is a simple, easy-to-use toolbox to start and maintain fullstack projects across multiple languages (Vue, Node, Swift ...).

## :clipboard: Licence

[![License](https://img.shields.io/packagist/l/doctrine/orm.svg?style=flat-square)](/LICENSE.md)

## :link: Links

[![Mail](https://img.shields.io/badge/Contact-us%20by%20mail-00a8ff.svg?style=flat-square)](mailto:brisorgueilp@gmail.com?subject=Contact)
