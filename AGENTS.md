# Devkit Node Stack - Agent Guide

Use this guide when operating as an engineering agent in this repository.
For architecture, modularity rules, guardrails, naming, commands, and definition of done — see `CLAUDE.md`.

## Mission

- Keep the stack mergeable for downstream projects
- Keep changes secure and free of secrets
- Enforce module boundaries and layered architecture

## Preflight

- Read `ERRORS.md` before proposing changes or code reviews
- If the AI makes a new recurring mistake, append one line to `ERRORS.md` using `[YYYY-MM-DD] <scope>: <wrong> -> <right>`

## Codex prompt routing

Use `.github/prompts/*` as task playbooks:

| Task | Prompt |
| ---- | ------ |
| Verify | `.github/prompts/verify.prompt.md` |
| Feature | `.github/prompts/feature.prompt.md` |
| Create module | `.github/prompts/create-module.prompt.md` |
| Update stack | `.github/prompts/update-stack.prompt.md` |
| Naming | `.github/prompts/naming.prompt.md` |

## Review output convention

- `Critical`: must fix before merge (security, breakage, mergeability risk)
- `Warning`: should be reviewed (coupling, architecture drift)
- `Info`: non-blocking suggestion
