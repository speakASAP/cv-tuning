# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`STATE.json` is the live status file: current phase, test counts, open items, and a `traps`
list of environment gotchas that have already cost time. Read it before planning anything and
update it when a phase completes.

Then, in order of depth:
- `docs/specs/2026-08-22-cv-tailoring-platform-design.md` — the authoritative design. Code
  comments cite it by section (`spec §6`, `spec §4.1`); when a comment cites a section, that
  section is the reason the code looks that way.
- `docs/superpowers/plans/` — one plan per phase, in execution order.
- `../CLAUDE.md` — the shared Statex ecosystem rules (deploy queue, serialization, prod safety).

## Commands

```bash
npm test              # typecheck + build + jest — the gate before committing
npm run typecheck     # tsc --noEmit (never `npx tsc`; use ./node_modules/.bin/tsc)
npm run test:unit     # jest only
npm run build         # nest build
npm run start:dev     # watch mode, needs CV_DATABASE_URL

npx jest src/applications/tailor.service.spec.ts        # single suite
npx jest -t 'rejects a bullet whose source fact'        # single case
```

Test discovery is `.*\.spec\.ts$` from the repo root. ~11 cases are skipped because they
need a live Postgres; a skip count above that means something regressed.

The grounding eval is **not** a test and must never be run in CI (it spends real tokens
against live models and self-guards on `CI`):

```bash
rtk npx ts-node src/applications/__evals__/run-eval.ts   # needs CV_AI_SERVICE_URL + CV_AI_JWT_SECRET
```

Run it before and after any edit to `tailor.prompt.ts` or `entail.prompt.ts` and diff the
tables — it is the only regression net for prompt changes. No baseline is recorded yet
(see `STATE.json.openItems`).

## Architecture

NestJS + TypeORM + Postgres on port 3379. Four domain modules pipeline into each other:

`master/` → `jobs/` → `applications/`, with `ai/`, `auth/`, `storage/`, `database/` as shared
infrastructure. All controllers are `@UseGuards(CvAuthGuard)` under `api/*`; only
`/health` is open.

**master/** — the user's one master CV. Markdown is the user-facing source of truth; the
fact graph is a *derived, versioned projection* (spec §4.1). On save, facts are re-extracted
and IDs re-matched by content hash + position (`fact-identity.ts`) so unchanged bullets keep
their IDs and existing provenance stays valid. A mismatch between the stored
`facts_extracted_from_markdown_sha` and the current Markdown **raises** — it never degrades
quietly. Importers (`gdocs`, `linkedin`, `document`) all normalize into the same Markdown.

**jobs/** — job-description ingest. `job-fetcher.service.ts` is SSRF-guarded: it re-checks
the resolved address at every phase, including after redirects, because a posting URL is
attacker-supplied and could otherwise reach the Kubernetes API. A blocked or thin fetch is a
distinct `FetchStatus`, not a failure — the user supplies text via the paste fallback, which
re-enters parsing. `fit-scorer.service.ts` validates every citation against real facts.

**applications/** — the anti-fabrication core, and the reason this product exists. Two
independent grounding layers (spec §6):

1. `tailor.service.ts` — constrained generation. Each output bullet binds to **exactly one**
   master fact (`TailoredBullet.sourceFactId`). The prompt requests this; the service
   *enforces* it. A bullet whose source fact does not exist in the snapshot is dropped into
   `droppedBullets` with a reason, never silently discarded and never shown to the user.
2. `entail.service.ts` — a **separate** LLM call with its own prompt and schema. A model
   grading its own output is not validation, so this must never be folded into the tailoring
   call. Verdicts are `supported | unsupported | overreach`; a non-`supported` verdict always
   carries the offending `span`.

Plus two deterministic, dependency-free checks: `ai-tell.ts` (phrases AI-content classifiers
key on) and `diff.ts` (hand-rolled word-level LCS diff — the input is a CV, so O(n·m) is free).

**Immutability rule (spec §4.2):** `cv_application.master_version_id` pins an immutable
master snapshot and never follows `is_current`; `cv_render.facts_snapshot` stores the facts
actually used. Editing the master CV can never retroactively change what the user already
reviewed or downloaded.

**ai/** — `AiClientService` mints its own HS256 service token (the `iss` claim must be
literally `ai-microservice`, regardless of caller). It returns `modelUsed` and a `degraded`
flag: a silent LiteLLM fallback is a quality collapse that still returns well-formed prose,
so an unexpected model is logged at error level and marked degraded (spec §8.1). Only the
free `cheap` and `smart` tiers are allowed; `premium` is blocked until the Phase 8 benchmark.

Migrations run via `migrationsRun: true` at boot — there is **no standalone data-source**, so
any scratch-DB check needs a direct `DataSource` script.

## Constraints that are not obvious from the code

- **No third-party users before Phase 7 (GDPR).** Phases 1–6 run on the owner's own CV data
  only, and there is deliberately no ingress manifest in `deploy.config.sh` until then.
- **No silent failures**, enforced strictly here (see the global `CLAUDE.md`). "Not found" and
  "lookup failed" must stay distinguishable: `CvAuthGuard` returns 401 for a rejected token
  and 503 for an unreachable auth service; an empty AI completion raises rather than
  returning a blank section. Every existing catch block re-throws or logs with full context —
  match that.
- **AI client timeout must stay above the LiteLLM proxy's 120s**, or the fallback chain never
  runs and the aborted attempts leave no trace in the proxy log.
- Commit to `main` and the ecosystem deploy queue picks it up; don't run `deploy.sh` by hand
  unless rolling back or explicitly asked.
