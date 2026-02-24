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
| Security     | [passport-jwt](https://github.com/themikenicholson/passport-jwt) - JWT Stateless <br> [bcrypt](https://en.wikipedia.org/wiki/Bcrypt) - [zxcvbn](https://github.com/dropbox/zxcvbn) - Passwords <br> SSL - Express / Reverse Proxy                                                                                     |
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

### Examples

- **Tasks** : list - get - add - edit - delete
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
npm test                  # Run all tests (one-shot)
npm run test:unit         # Run unit tests once (alias of npm test)
npm run test:watch        # Run tests in watch mode
npm run test:coverage     # Generate coverage report
```

Tests are organized per module in `modules/*/tests/`

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

Configuration files live in `config/defaults/`. The `development.js` file is the base; other files in that folder override it.

Environment variables prefixed with `DEVKIT_NODE_` are merged on top. The variable path maps directly to the config object key:

```bash
DEVKIT_NODE_app_title='my app'               # sets config.app.title
DEVKIT_NODE_db_uri='mongodb://...'           # sets config.db.uri
```

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

## :pencil2: Contribute

Open issues and pull requests on [GitHub](https://github.com/pierreb-devkit/Node).

## :scroll: History

This work is based on [MEAN.js](http://meanjs.org) and more precisely on a fork named [Riess.js](https://github.com/lirantal/Riess.js). The goal is a simple, easy-to-use toolbox to start and maintain fullstack projects across multiple languages (Vue, Node, Swift ...).

## :clipboard: Licence

[![License](https://img.shields.io/packagist/l/doctrine/orm.svg?style=flat-square)](/LICENSE.md)

## :link: Links

[![Mail](https://img.shields.io/badge/Contact-us%20by%20mail-00a8ff.svg?style=flat-square)](mailto:brisorgueilp@gmail.com?subject=Contact)
