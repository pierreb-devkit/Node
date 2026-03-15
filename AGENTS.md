# Devkit Node Stack - Agent Guide

Use this guide when operating as an engineering agent in this repository.
For architecture, modularity rules, guardrails, naming, commands, and definition of done — see `CLAUDE.md`.

## Mission

- Keep the stack mergeable for downstream projects
- Keep changes secure and free of secrets
- Enforce module boundaries and layered architecture

## Codex prompt routing

Use `.github/prompts/*` as task playbooks:

| Task | Prompt |
| ---- | ------ |
| Verify | `.github/prompts/verify.prompt.md` |
| Feature | `.github/prompts/feature.prompt.md` |
| Create module | `.github/prompts/create-module.prompt.md` |
| Update stack | `.github/prompts/update-stack.prompt.md` |
| Naming | `.github/prompts/naming.prompt.md` |
| PR | `.github/prompts/pull-request.prompt.md` |

## Workflow rules

- After any user correction, evaluate if the mistake pattern belongs in `ERRORS.md`
- Investigate and fix bugs autonomously — don't ask for hand-holding
- For non-trivial tasks, plan before coding
