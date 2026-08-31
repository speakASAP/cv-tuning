---
status: review
owner: repository-owner
last_updated: 2026-08-31
---

# cv-tuning Phase 2 — JD Ingest and Fit Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user submit a job-posting URL (or paste its text), extract the requirements, and see a fit score with a gap report before any CV is generated.

**Architecture:** A job is fetched server-side, reduced to readable text, and parsed into structured requirements by `ai-microservice` at the `cheap` tier. Fetch failures are an explicit state, never an empty job — the UI falls back to paste. Scoring compares parsed requirements against the master CV fact graph and returns per-requirement evidence, so the gap report says *why* rather than only *how much*.

**Tech Stack:** NestJS 10, TypeORM 0.3.17, pg 8.11.3, Jest 29. No new runtime dependencies except an HTML-to-text reducer.

**Spec:** `docs/specs/2026-08-22-cv-tailoring-platform-design.md` (§4 data model, §5 state machine, §10 failure handling)

## Global Constraints

- **Free models only.** `cheap` for JD parsing and scoring. `free` is a 0.5B code model and must never be used for prose or reasoning. Premium is Phase 9.
- **Every LLM call goes through `AiClientService`**, which already rejects silent tier downgrades. A degraded scoring result must not be persisted as if trustworthy.
- **No silent failures.** A blocked or empty fetch sets an explicit `fetchStatus` and surfaces the paste fallback. "No requirements found" and "parsing failed" must stay distinguishable.
- **No headless browser.** Server fetch plus paste fallback only, per the owner's decision; a Chromium pod also collides with the single-node deploy lock.
- **GDPR gate still binding.** No third-party users before Phase 7; the service stays ClusterIP with no ingress.
- **`synchronize: false`**; migrations generated offline and applied to a scratch database first.
- Never `npx tsc`; use `./node_modules/.bin/tsc` or `npm run build`.

## File Structure

**Create:**
- `src/jobs/entities/cv-job.entity.ts` — the posting and its parse state
- `src/jobs/job.types.ts` — `FetchStatus`, `ParsedRequirements`, `Requirement`
- `src/jobs/job-fetcher.service.ts` — fetch + readability reduction, failure classification
- `src/jobs/job-parser.service.ts` — text → structured requirements via `cheap`
- `src/jobs/fit-scorer.service.ts` — requirements × fact graph → score and gaps
- `src/jobs/jobs.service.ts` — persistence and orchestration
- `src/jobs/jobs.controller.ts`, `src/jobs/dto/*`
- `src/jobs/jobs.module.ts`
- `src/database/migrations/1756300000000-CreateJobTables.ts`
- Specs beside each service

**Modify:**
- `src/app.module.ts` — import `JobsModule`

Boundaries: the fetcher knows nothing about parsing, the parser nothing about scoring, and the scorer is pure over its inputs. Only `jobs.service` touches the database.

---

### Task 1: Job schema and types

**Files:**
- Create: `src/jobs/job.types.ts`, `src/jobs/entities/cv-job.entity.ts`
- Create: `src/database/migrations/1756300000000-CreateJobTables.ts`
- Modify: `src/database/database.module.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `CvJobEntity`; `FetchStatus = 'ok' | 'blocked' | 'thin' | 'failed'`; `JobSource = 'fetch' | 'paste'`; `Requirement = { text: string; kind: 'must' | 'nice'; category: string }`

- [ ] **Step 1: Write the types**

```ts
export const FETCH_STATUSES = ['ok', 'blocked', 'thin', 'failed'] as const;
export type FetchStatus = (typeof FETCH_STATUSES)[number];

export const JOB_SOURCES = ['fetch', 'paste'] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

export interface Requirement {
  text: string;
  /** A "must" missing from the CV costs far more in the fit score than a "nice". */
  kind: 'must' | 'nice';
  category: string;
}

export interface ParsedRequirements {
  title: string | null;
  company: string | null;
  language: string;
  requirements: Requirement[];
}
```

- [ ] **Step 2: Write the entity**

`cv_job` per spec §4: `id`, `userId`, `url` (nullable — a pasted job has none), `source`, `rawText`, `parsed jsonb`, `company`, `title`, `language`, `fetchStatus`, `fetchedAt`, `expiresAt`.

`expiresAt` exists from the start: `rawText` is third-party copyrighted content and Phase 7 must be able to expire it while keeping the derived `parsed` requirements.

- [ ] **Step 3: Write the migration and register the entity**

Raw SQL, matching `1756200000000-CreateMasterTables.ts`. Index `userId` and `fetchStatus`. Add `CvJobEntity` to `CV_ENTITIES`.

- [ ] **Step 4: Verify the build**

```bash
npm run build
```

Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/jobs src/database
git commit -m "feat: job posting schema with explicit fetch status"
```

---

### Task 2: Job fetcher

**Files:**
- Create: `src/jobs/job-fetcher.service.ts`, `src/jobs/job-fetcher.service.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `JobFetcherService.fetch(url: string): Promise<FetchResult>` where `FetchResult = { status: FetchStatus; text: string; reason?: string }`

- [ ] **Step 1: Write the failing tests**

Cover, at minimum:

```ts
it('returns ok with reduced text for a normal posting', ...);
it('classifies 403 as blocked, not failed', ...);        // actionable: paste instead
it('classifies 429 as blocked', ...);
it('classifies a 500 as failed', ...);
it('classifies a transport error as failed', ...);
it('classifies a page with almost no text as thin', ...); // JS-rendered shells
it('strips script and style content before measuring length', ...);
it('never returns ok with empty text', ...);
it('rejects a non-http URL scheme', ...);                 // no file:// or data:
it('does not follow a redirect to a private address', ...); // SSRF guard
```

- [ ] **Step 2: Run to verify they fail**

```bash
./node_modules/.bin/jest src/jobs/job-fetcher
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Reduce HTML by stripping `<script>`, `<style>`, `<nav>`, `<footer>`, then collapsing tags to text. Under ~400 characters is `thin` — a JS-rendered shell, not a real posting. 401/403/429 is `blocked`; 5xx and transport errors are `failed`. **`ok` with empty text is impossible by construction.**

**SSRF guard:** this endpoint takes a user-supplied URL and fetches it from inside the cluster. Reject non-`http(s)` schemes and any host resolving to a private or loopback range, before and after redirects.

- [ ] **Step 4: Run to verify they pass, then commit**

```bash
./node_modules/.bin/jest src/jobs/job-fetcher
git add src/jobs/job-fetcher.service.ts src/jobs/job-fetcher.service.spec.ts
git commit -m "feat: job fetcher with explicit failure classification and SSRF guard"
```

---

### Task 3: Job parser

**Files:**
- Create: `src/jobs/job-parser.service.ts`, `src/jobs/job-parser.service.spec.ts`

**Interfaces:**
- Consumes: `AiClientService`
- Produces: `JobParserService.parse(text: string): Promise<ParsedRequirements>`

- [ ] **Step 1: Write the failing tests**

Mirror `fact-extractor.service.spec.ts`, which is the proven shape:

```ts
it('extracts requirements with must/nice classification', ...);
it('uses the cheap tier', ...);
it('detects the posting language', ...);
it('raises on unparseable model output rather than returning no requirements', ...);
it('raises when the payload has no requirements array', ...);
it('rejects a requirement with an unrecognised kind', ...);
it('tolerates a fenced JSON code block', ...);
it('raises when parsing ran on a degraded model', ...);
it('raises rather than parsing empty text', ...);
```

- [ ] **Step 2–4: Fail, implement, pass**

Prompt instructs: extract only stated requirements, never infer; classify `must` vs `nice` from the posting's own wording; detect language. Same degraded-model refusal as the fact extractor — a downgraded parse yields requirements every later stage trusts.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: parse job postings into structured requirements"
```

---

### Task 4: Fit scorer

The product differentiator in this phase: the score must explain itself.

**Files:**
- Create: `src/jobs/fit-scorer.service.ts`, `src/jobs/fit-scorer.service.spec.ts`

**Interfaces:**
- Consumes: `AiClientService`, `CvFactEntity[]`, `Requirement[]`
- Produces: `FitScorerService.score(requirements, facts): Promise<FitReport>` where
  `FitReport = { score: number; matches: RequirementMatch[]; gaps: RequirementMatch[] }` and
  `RequirementMatch = { requirement: Requirement; factIds: string[]; verdict: 'met' | 'partial' | 'missing'; evidence: string | null }`

- [ ] **Step 1: Write the failing tests**

```ts
it('marks a requirement met when a fact supports it and cites the factId', ...);
it('marks a requirement missing when no fact supports it', ...);
it('weights an unmet must far more heavily than an unmet nice', ...);
it('scores 100 when every requirement is met', ...);
it('scores 0 when nothing is met', ...);
it('never cites a factId that is not in the supplied facts', ...);  // fabrication guard
it('raises when scoring ran on a degraded model', ...);
it('returns every requirement across matches and gaps, losing none', ...);
it('handles a CV with no facts without crashing', ...);
```

- [ ] **Step 2–4: Fail, implement, pass**

The model returns a verdict and cited `factIds` per requirement. **Post-validate every cited id against the supplied fact set and drop unknown ones** — the same anti-fabrication discipline Phase 3 will formalise. Score is a weighted ratio: `must` counts 3, `nice` counts 1; `partial` earns half credit.

- [ ] **Step 5: Verify the fabrication guard can fail**

Temporarily accept unvalidated ids; the "never cites a factId that is not in the supplied facts" test must go red. Restore.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: fit scoring with per-requirement evidence and citation validation"
```

---

### Task 5: Jobs service and endpoints

**Files:**
- Create: `src/jobs/jobs.service.ts`, `src/jobs/jobs.service.spec.ts`
- Create: `src/jobs/jobs.controller.ts`, `src/jobs/jobs.controller.spec.ts`
- Create: `src/jobs/dto/submit-job.dto.ts`, `src/jobs/dto/paste-job.dto.ts`
- Create: `src/jobs/jobs.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: everything above, plus `MasterCvService`
- Produces: `POST /api/jobs` (url), `POST /api/jobs/:id/text` (paste fallback), `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/score`

- [ ] **Step 1: Write the failing tests**

```ts
it('persists a job with fetchStatus blocked and no parsed requirements', ...);
it('returns the paste-fallback hint when a fetch is blocked', ...);  // never a bare failure
it('parses and stores requirements when the fetch succeeds', ...);
it('accepts pasted text for a previously blocked job and re-parses it', ...);
it('scores against the current master CV', ...);
it('409s scoring when the user has no master CV', ...);              // actionable, not 500
it('404s a job belonging to another user', ...);                     // tenancy
it('never reads userId from the request body', ...);
```

- [ ] **Step 2–4: Fail, implement, pass**

Tenancy is enforced in every query by `userId` from the token. A blocked fetch is a **successful request** returning a job whose status tells the UI to ask for a paste — not an error.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: job submission, paste fallback, and scoring endpoints"
```

---

### Task 6: Deploy

- [ ] **Step 1: Verify the migration on a scratch database**

```bash
docker run -d --name cv-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=cv_test -p 5435:5432 postgres:16-alpine
CV_DATABASE_URL=postgresql://postgres:postgres@localhost:5435/cv_test npm run start:prod
```

Expected: `cv_job` created alongside the existing tables. Check the deploy lock first — `shared/scripts/with-deploy-lock.sh --status` — before creating any container.

- [ ] **Step 2: Merge, push, deploy**

`git merge` does **not** trigger auto-deploy (there is no `post-merge` hook), so run `./scripts/deploy.sh` explicitly after pushing.

- [ ] **Step 3: Verify by pod age, not the deploy banner**

```bash
kubectl get pods -n statex-apps -l app=cv-tuning \
  -o custom-columns='READY:.status.containerStatuses[0].ready,START:.status.startTime' --no-headers
git log -1 --format=%cI
```

The pod's start time must be later than the commit time. Then confirm `cv_job` exists in the production `cv` database.

## Self-Review

**Spec coverage:** §4 `cv_job` → Task 1. §5 `jd_parsing`/`jd_failed` states → Tasks 2, 5. §4.3 language detection → Task 3. Fit score and gap report (§2 v1 scope) → Task 4. §10 failure handling → every task. §9 retention groundwork (`expiresAt`) → Task 1.

**Deliberately out of scope:** tailoring and the grounding validator (Phase 3), the diff UI (Phase 3), cover letters (Phase 6). The BPCP workflow instance is not created until Phase 3, when there is a multi-step lifecycle worth driving.

**Type consistency:** `Requirement` and `ParsedRequirements` defined in Task 1, consumed unchanged in 3, 4, 5. `FetchStatus` defined in Task 1, produced by Task 2, persisted in Task 5. `RequirementMatch.factIds` refers to `cv_fact.factId` — the stable cross-version identity from Phase 1, never the row `id`.
