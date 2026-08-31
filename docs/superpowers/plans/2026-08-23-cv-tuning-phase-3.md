---
status: review
owner: repository-owner
last_updated: 2026-08-31
---

# cv-tuning Phase 3 — Tailoring, Grounding, and Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a scored job into a tailored CV revision the user can review as a diff, where every bullet is provably a rewrite of one master bullet and every claim has been checked for entailment against the facts it cites.

**Architecture:** Generation is *constrained*, not free-form: the model receives the master bullets and must return, for each output bullet, the single `sourceFactId` it transformed. A bullet that cites no source bullet, or more than one, is rejected before it is ever persisted — so the diff is structurally a rewrite rather than an invention. A second LLM call with its own prompt and schema then judges each surviving bullet `supported | unsupported | overreach`. Overreach becomes a product feature: a confirm-or-drop chip in review, not a silent pass.

**Tech Stack:** NestJS 10, TypeORM 0.3.17, pg 8.11.3, Jest 29. No new runtime dependencies — diffing is computed server-side with a small word-level LCS, so no `diff` package and no client bundle work in this phase.

**Spec:** `docs/specs/2026-08-22-cv-tailoring-platform-design.md` (§4 data model, §4.2 immutability, §5 state machine, §6 grounding, §6.1 anti-AI-voice, §7 diff UX, §8.0 model attribution)

## Why this phase is the product

§6 is explicit that the naive design does not work: *"Citation existence is not grounding."* A model can write "Led a team of 12 engineers" citing a fact that says only "Senior Developer at X" and pass a citation check trivially. Phase 2's fit scorer validates that cited IDs *exist*; that is necessary and not close to sufficient. This phase adds the two layers that actually bind output to truth — one-to-one source constraint, and entailment — because fabrication is the single failure that destroys the product's reason to exist (§1.1: 49% of hiring managers auto-dismiss AI resumes; 19.6% of recruiters reject specifically for AI generation).

## Global Constraints

- **Free models only.** `smart` for both generation and validation. Premium is Phase 9; the benchmark that would justify it is Phase 8.
- **The validator is a separate call with its own prompt and schema.** Never ask one call to both write and grade its own output — a self-graded bullet is not validated.
- **Degradation is fatal here, not a warning.** A tailored CV written by a silently downgraded model is exactly the auto-rejected output the product exists to prevent. Both calls refuse a degraded model, and `cv_render` records `model_used`, `validator_model_used`, `requested_tier`, and `degraded` (§8.0).
- **`master_version_id` is an immutable pin** (§4.2). It never follows `is_current`. `facts_snapshot` stores the facts as used, so a render is reproducible forever.
- **No silent failures.** A bullet that fails the source constraint is dropped *with an error log naming it*, never quietly omitted. `generation_failed` is a real state carrying the error (§5).
- **GDPR gate still binding.** No third-party users before Phase 7; service stays ClusterIP with no ingress.
- **`synchronize: false`**; migration generated offline, applied to a scratch database first.
- Never `npx tsc`; use `./node_modules/.bin/tsc` or `npm run build`.
- Never `git merge` and expect a deploy — no `post-merge` hook exists. Deploy explicitly at the end.

## File Structure

**Create:**
- `src/applications/application.types.ts` — `ApplicationState`, `TailoredBullet`, `Provenance`, `EntailmentVerdict`
- `src/applications/entities/cv-application.entity.ts` — the pinned application
- `src/applications/entities/cv-render.entity.ts` — one revision, with full model attribution
- `src/applications/tailor.prompt.ts` — generation prompt + output schema, versioned
- `src/applications/tailor.service.ts` — constrained generation, source-constraint enforcement
- `src/applications/entail.prompt.ts` — validator prompt + output schema, versioned
- `src/applications/entail.service.ts` — per-bullet entailment, downgrade discipline
- `src/applications/ai-tell.ts` — pure blocklist scorer (§6.1)
- `src/applications/diff.ts` — pure word-level unified diff
- `src/applications/applications.service.ts` — orchestration and persistence
- `src/applications/applications.controller.ts`, `src/applications/dto/*`
- `src/applications/applications.module.ts`
- `src/database/migrations/1756400000000-CreateApplicationTables.ts`
- `src/applications/__evals__/run-eval.ts` — manual grounding eval, never in CI
- Specs beside each service

**Modify:**
- `src/app.module.ts` — import `ApplicationsModule`
- `src/database/database.module.ts` — register the two new entities

Boundaries: `tailor` and `entail` are each pure over their inputs plus one AI call; `diff` and `ai-tell` are fully pure and need no mocks; only `applications.service` touches the database.

---

### Task 1: Application and render schema

**Files:**
- Create: `src/applications/application.types.ts`, `src/applications/entities/cv-application.entity.ts`, `src/applications/entities/cv-render.entity.ts`
- Create: `src/database/migrations/1756400000000-CreateApplicationTables.ts`
- Modify: `src/database/database.module.ts`

**Interfaces:**
- Consumes: `CvJobEntity`, `CvMasterEntity`, `CvFactEntity`
- Produces: `CvApplicationEntity`, `CvRenderEntity`, `ApplicationState`

- [ ] **Step 1: Types**

```ts
export const APPLICATION_STATES = [
  'scored', 'generating', 'generation_failed', 'in_review',
  'revising', 'approved', 'downloaded', 'marked_sent',
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];

export const ENTAILMENT_VERDICTS = ['supported', 'unsupported', 'overreach'] as const;
export type EntailmentVerdict = (typeof ENTAILMENT_VERDICTS)[number];

/** One output bullet, bound to exactly one master fact. */
export interface TailoredBullet {
  text: string;
  /** The single master fact this bullet is a rewrite of. Never more than one. */
  sourceFactId: string;
  /** The JD requirement this rewrite targets, for the "why" chip in §7. */
  targetRequirement: string | null;
  verdict: EntailmentVerdict;
  /** The offending span when the verdict is not `supported`. */
  span: string | null;
}
```

- [ ] **Step 2: Entities**

`cv_application` carries `masterVersionId` (the immutable pin), `jobId`, `state`, `bpcpInstanceId`, `outcome`, `renderLanguage`. `cv_render` carries `revisionNo`, `markdown`, `factsSnapshot`, `provenance`, `fitScore`, `gaps`, `aiTellScore`, `createdBy`, `modelUsed`, `validatorModelUsed`, `requestedTier`, `degraded`, `promptVersion`, `idempotencyKey` (unique).

Unique constraint on `(applicationId, revisionNo)` — two concurrent generations must not both claim revision 2.

- [ ] **Step 3: Migration, applied to a scratch DB first**

Take the deploy lock before `docker run` (single node, single containerd). Remove the container afterwards; an orphan `cv-test-pg` blocks the next run with `name is reserved`.

- [ ] **Step 4: Verify**
  - Entities registered, `synchronize` still false
  - Migration up/down clean on scratch Postgres
  - `npm run build`

---

### Task 2: Constrained generation

**Files:**
- Create: `src/applications/tailor.prompt.ts`, `src/applications/tailor.service.ts`, `src/applications/tailor.service.spec.ts`

**Interfaces:**
- Consumes: `AiClientService`, master facts, parsed requirements
- Produces: `TailorResult { bullets: TailoredBullet[]; modelUsed: string; promptVersion: string }`

- [ ] **Step 1: Prompt, versioned**

`export const TAILOR_PROMPT_VERSION = 'tailor-v1'` — persisted on every render so a later eval can attribute a regression to a prompt change.

The prompt must state: every output bullet is a rewrite of exactly one input bullet; return its `sourceFactId`; never merge two facts into one bullet; never introduce a number, title, team size, or technology not present in the source fact. Include the anti-AI-voice blocklist from §6.1 (*leveraged, spearheaded, passionate about, results-driven, proven track record*) and pass the user's own phrasing as style exemplars.

- [ ] **Step 2: Enforce the source constraint in code, not only in the prompt**

The prompt is a request; the code is the guarantee. Drop any bullet whose `sourceFactId` is unknown or absent, and log at error level with the bullet text — a dropped bullet is a real failure, not a tidy-up.

- [ ] **Step 3: Refuse a degraded model**

- [ ] **Step 4: Tests (write first, watch them fail)**
  - rewrites a master bullet toward a requirement
  - **drops a bullet citing an unknown `sourceFactId`** ← disable the check, must go red
  - **drops a bullet citing no source at all** ← same
  - a bullet claiming a number absent from its source fact is still emitted but flagged for the validator (generation does not judge entailment; that is Task 3's job — this test pins the boundary)
  - raises on a degraded model
  - handles a master CV with no facts without crashing
  - never emits more bullets than there are master facts

---

### Task 3: Entailment validator

**Files:**
- Create: `src/applications/entail.prompt.ts`, `src/applications/entail.service.ts`, `src/applications/entail.service.spec.ts`

House shape to copy: `ai-microservice/src/teacher-assistant/validate.{prompt,schema,service}.ts`.

**Interfaces:**
- Consumes: `AiClientService`, `TailoredBullet[]`, the facts each cites
- Produces: bullets with `verdict` and `span` populated, plus `validatorModelUsed`

- [ ] **Step 1: Prompt and schema, separate from generation**

Per bullet: *is this claim fully supported by these facts?* → `supported | unsupported | overreach`, plus the offending span. `overreach` means the claim goes beyond the fact while staying adjacent to it ("Senior Developer" → "Led a team of 12"); `unsupported` means no basis at all.

- [ ] **Step 2: Downgrade discipline — copy the house rule**

`validate.service.ts:149` is explicit that *a downgrade must never destroy the reason for it*. When the model returns a non-supported verdict with no span, synthesize one naming the bullet, rather than dropping the reason.

**A bullet the validator skipped is `unsupported`, never `supported`.** This mirrors the Phase 2 scorer, where a skipped requirement counts as missing. Fail-closed: an unvalidated claim reaching the user as validated is the exact failure this phase exists to prevent.

- [ ] **Step 3: Refuse a degraded validator model**

A degraded *validator* is worse than a degraded generator: it silently stops catching fabrication while still reporting verdicts.

- [ ] **Step 4: Tests (write first, watch them fail)**
  - marks a faithful rewrite `supported`
  - marks an invented team size `overreach` with the span
  - marks a wholly invented claim `unsupported`
  - **a bullet the model skipped becomes `unsupported`** ← disable, must go red
  - **a non-supported verdict with no span gets a synthesized one** ← disable, must go red
  - raises on a degraded model
  - malformed JSON raises rather than passing everything

---

### Task 4: AI-tell score and word-level diff (both pure)

**Files:**
- Create: `src/applications/ai-tell.ts`, `src/applications/ai-tell.spec.ts`, `src/applications/diff.ts`, `src/applications/diff.spec.ts`

- [ ] **Step 1: `ai-tell.ts`** — blocklist from §6.1, count per 100 words, 0–100. Pure, no AI call. Shown before download.

- [ ] **Step 2: `diff.ts`** — unified line diff with word-level granularity inside changed lines (§7). Baseline for revision 1 is the master CV markdown, so the first generation is reviewable as a diff too.

- [ ] **Step 3: Tests** — identical input yields no hunks; a single changed word marks only that word; revision 1 diffs against master; empty-to-content and content-to-empty both work.

Pure functions, so these tests need no mocks and run in milliseconds.

---

### Task 5: Orchestration, persistence, endpoints

**Files:**
- Create: `src/applications/applications.service.ts`, `applications.controller.ts`, `dto/*`, `applications.module.ts`, specs
- Modify: `src/app.module.ts`

**Endpoints:**
- `POST /api/applications` — `{ jobId }` → pins current master, generates revision 1
- `GET /api/applications` / `GET /api/applications/:id`
- `GET /api/applications/:id/renders/:revisionNo/diff` — diff vs previous revision (or master for revision 1)
- `POST /api/applications/:id/regenerate` — new revision, same pin

- [ ] **Step 1: Pin the master at creation.** Read `is_current` once, store the id, never re-read it.

- [ ] **Step 2: Snapshot facts into the render** so it is reproducible after the master changes.

- [ ] **Step 3: Record full model attribution** — both models, tier, degraded flag, prompt version (§8.0).

- [ ] **Step 4: `generation_failed` carries the error** (§5), never a stuck `generating`.

- [ ] **Step 5: Idempotency key** on `(applicationId, revisionNo, promptVersion)` so a retried request does not double-spend a generation.

- [ ] **Step 6: Tenancy** — every query scoped by token `userId`; test cross-tenant read *and* write.

- [ ] **Step 7: Tests**
  - creates an application and pins the master version
  - **a later master edit does not change an existing render** ← the §4.2 guarantee; disable the pin, must go red
  - regenerate produces revision 2 without repinning
  - generation failure sets `generation_failed` with the error, not `generating`
  - 409 when the job was never scored
  - cross-tenant read and write both 404

---

### Task 6: Eval harness (manual, never in CI)

**Files:**
- Create: `src/applications/__evals__/run-eval.ts`

Copy the house harness at `ai-microservice/src/teacher-assistant/__evals__/run-eval.ts`, including its guards: lives under `__evals__/`, filename does not end `.spec.ts` so `testRegex` never collects it, and it refuses to run when `CI` is set.

- [ ] **Step 1: Fixture set** — a small master CV plus postings, including **adversarial cases**: a posting demanding experience the CV does not have (the model must not invent it), and one where a fact is adjacent but not equal to the requirement (must come back `overreach`, not `supported`).

- [ ] **Step 2: Report** — per fixture, counts of `supported | unsupported | overreach`, dropped-bullet count, `ai_tell_score`, and both model ids.

- [ ] **Step 3: Record a baseline** in the plan file so a future prompt edit can be diffed against it.

§6: *"Without evals there is no way to know whether a prompt change regressed grounding."* The harness is the regression net for every later prompt edit, including Phase 8's benchmark.

---

### Task 7: Verify and deploy

- [ ] Full suite green; confirm the new count against the Phase 2 baseline of 159
- [ ] `npm run build` clean
- [ ] Migration applied to scratch Postgres, container removed
- [ ] For each load-bearing guard, disable it and confirm red: source constraint, skipped-bullet fail-closed, span synthesis, master pin
- [ ] Take the deploy lock; deploy once at the end
- [ ] Verify by **pod age against commit time**, not by a banner
- [ ] Confirm `cv_application` and `cv_render` in the production `cv` database via `kubectl exec` into the pod — `port-forward svc/db-server-postgres` fails, the Service has no selector

---

## Out of scope for Phase 3

Voice revision, approval, and PDF/DOCX export are Phase 4. The diff is computed and served here; the *rendered* review UI with confirm-or-drop chips lands with the voice loop in Phase 4, since both belong to the same review surface. Cover letters are Phase 6.
