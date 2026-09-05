# Repository Agent Instructions

This file is the entry point for coding agents working in `cv-tuning`. Keep it concise, and preserve the project invariants in `STATE.json`, `CLAUDE.md`, and the governance docs.

## Required reading

Read these files in order before changing code:

1. `TASKS.md` — the live work queue: active, ready-next, and blocked items. (`STATE.json` is the
   ecosystem Wave projection only; it no longer carries phase status, validation counts, open
   items, or traps — that block is archived at `docs/orchestrator/legacy-state-archive.md`.)
2. `CLAUDE.md` — project architecture, invariants, anti-fabrication rules, and commands.
3. `docs/specs/2026-08-22-cv-tailoring-platform-design.md` — authoritative product design.
4. `BUSINESS.md`, `SYSTEM.md`, and `docs/01_vision/VISION.md` — approved intent and system boundaries.
5. The relevant phase plan in `docs/superpowers/plans/`.
6. Shared ecosystem rules in `../CLAUDE.md` and the cross-agent standard at `/home/ssf/.ai-agent-standards/CROSS_AGENT_AUTOMATION_STANDARD.md`.

## Authority

The project owner approves the business and product scope. Agents must not redefine business intent, add unapproved integrations, or introduce unsupported claims.

## Service-to-service authentication
Any call this service makes to, or receives from, another service is governed by
[`auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md`](../auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md).
Read it before writing or debugging a machine call — including a 401 from an internal
endpoint. New machine paths use an Auth-issued per-pair RS256 service JWT; a shared static
token is legacy and closed to new adopters. This repository has a **documented legacy
exception** recorded in that standard — do not treat the existing pattern as the model for
new work.

## Intent Preservation System

Preserve the chain of intent across:

Vision → Goal Impact → System → Feature → Task → Execution Plan → Coding Prompt → Code → Validation

## Safety and operations

- Preserve unrelated dirty changes.
- Do not reset, checkout, force-push, or rewrite history.
- Keep changes surgical and traceable to the active task.
- Never print secrets, tokens, raw production data, or private CV evidence.
- Use `[UNKNOWN: ...]` or `[MISSING: ...]` rather than inventing facts when a detail is not verified.
- Do not deploy manually unless explicitly requested.

## Project-specific rules

- Anti-fabrication is a product invariant: generated claims must remain grounded in real user evidence.
- Never present inferred or guessed experience as fact.
- Keep the service scoped to truthful job-tailoring rather than generic AI writing.
- Treat consent, retention, and user-control requirements as part of the product contract.
- Preserve the master CV provenance and avoid rebasing or rewriting the user's approved render history.

## Required final report

Every task ends with a brief handoff covering files changed, validation commands and results, validation debt, blockers, and the next concrete action.

## Commands

Run the smallest relevant existing check before broader validation:

```bash
npm run typecheck
npm run build
npm test
```

For a focused Jest run, use the local project binary or an available npm/Jest command.
