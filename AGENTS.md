# Repository Agent Instructions

This file is the entry point for coding agents working in `cv-tuning`. Keep it concise;
the detailed architecture and rationale live in [`CLAUDE.md`](CLAUDE.md).

## Read first

Read these files in order before changing code:

1. [`STATE.json`](STATE.json) — current phase, validation counts, open items, and known traps.
2. [`CLAUDE.md`](CLAUDE.md) — project architecture, invariants, anti-fabrication rules, and commands.
3. The relevant phase plan in [`docs/superpowers/plans/`](docs/superpowers/plans/).
4. [`docs/specs/2026-08-22-cv-tailoring-platform-design.md`](docs/specs/2026-08-22-cv-tailoring-platform-design.md) — authoritative product design.
5. Shared ecosystem rules in [`../CLAUDE.md`](../CLAUDE.md) and the cross-agent standard at [`/home/ssf/.ai-agent-standards/CROSS_AGENT_AUTOMATION_STANDARD.md`](file:///home/ssf/.ai-agent-standards/CROSS_AGENT_AUTOMATION_STANDARD.md).

Claude Code's official guidance is the single source of truth for its instruction and configuration
features; do not copy that documentation into this repository:

- [Memory and `CLAUDE.md` files](https://code.claude.com/docs/en/memory)
- [Settings and precedence](https://code.claude.com/docs/en/settings)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code documentation index](https://code.claude.com/docs/en/overview)

## Project facts

- NestJS + TypeORM + Postgres service on port `3379`.
- Pipeline: `master/` → `jobs/` → `applications/`; `ai/`, `auth/`, `storage/`, `database/`, `export/`, `bpcp/`, `notifications/`, and `dashboard/` provide shared or adjacent capabilities.
- The service is owner-only until Phase 7 (GDPR). Do not add public ingress or third-party access before that gate.
- `cv_application.master_version_id` and `cv_render.facts_snapshot` preserve the reviewed immutable snapshot. Never make an existing render follow the current master CV.
- Anti-fabrication is a product invariant: generated claims must bind to source facts, unsupported or overreaching output must not be shown as valid, and provenance must remain inspectable.
- Do not weaken SSRF checks, authentication, model-degradation checks, export-failure recovery, durable rate limits, or BPCP error logging.
- Do not add a scheduler here; outcome timing belongs to BPCP.

## Workflow

- Work directly in the remote checkout at `/home/ssf/Documents/Github/cv-tuning` when connected through `ssh alfares`.
- Preserve unrelated dirty changes. Do not reset, checkout, force-push, or rewrite history.
- Make surgical changes and update the relevant plan or `STATE.json` only when the phase status actually changes.
- Do not deploy manually unless explicitly requested. Committing to `main` is handled by the ecosystem deploy queue; deployment remains serialized.
- Never print secrets, tokens, raw production data, or private CV evidence. Use `[MISSING: ...]` or `[UNKNOWN: ...]` rather than inventing facts.

## Commands

Run the smallest relevant existing check, then the full gate when practical:

```bash
npm run typecheck   # tsc --noEmit -p tsconfig.json
npm run build       # Nest build
npm run test:unit   # Jest unit/integration suites
npm test            # typecheck + build + Jest; commit gate
```

For a focused Jest run, use the local binary or an existing npm/Jest command, for example:

```bash
npx jest src/applications/tailor.service.spec.ts
npx jest -t 'rejects a bullet whose source fact'
```

The grounding eval in `src/applications/__evals__/run-eval.ts` spends real model tokens and is not
CI. Run it before and after prompt changes only, with the environment described in `CLAUDE.md`.

## Change-specific rules

- Read the relevant tests before editing a service, prompt, entity, migration, or controller.
- Preserve deterministic ordering and artifact hashes; PDF and DOCX must render from the shared document model.
- Add or update focused tests for behavior changes. Keep migrations additive and inspect their effect before applying them.
- A failed lookup, unavailable dependency, empty AI completion, and valid empty input are distinct states; do not swallow errors or turn failures into silent defaults.
- For prompt changes, retain the two independent grounding layers and verify model identity/degradation behavior.
- Keep documentation links current, but prefer linking to canonical Claude Code docs over duplicating their contents.

## Handoff

Report files changed, validation commands and results, known validation debt, blockers, and the next
concrete action. Do not claim completion for work that was not persisted or validated.
