# CV Tuning Phase 6 Implementation Plan — Cover Letters, Screening Answers, Proof-of-Work Surfacing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the grounded-generation pipeline beyond the CV itself to the other two artefacts
an application needs — a cover letter and the portal's screening answers — and finally surface
`cv_fact.kind = 'proof'` (portfolio links, repos, case studies), which has existed as a fact kind
since Phase 1 and has never once reached the user's output.

**Architecture:** Phase 6 adds **no new grounding machinery**. It generalises what Phase 3 built.
The insight that shapes the whole plan: `EntailService.validate(bullets: DraftBullet[], facts:
FactSnapshot[])` is already generic over "claims bound to facts" — it does not know or care that
its input came from a CV. A cover-letter paragraph and a screening answer are both a `DraftBullet`
with a `sourceFactId`, so both get layer 2 for free, unchanged, with no second implementation of
the anti-fabrication core to keep in sync.

Four layers:

1. **`proof.ts`** — a pure, dependency-free module that classifies and formats `proof` facts.
   Deterministic, no LLM. URL extraction is a regex over the fact text; a proof fact whose URL
   cannot be parsed is still surfaced with its text, never dropped.
2. **`cover-letter.service.ts` + `cover-letter.prompt.ts`** — layer 1 (constrained generation) for
   letter *body* paragraphs, each binding to exactly one master fact, then `EntailService` for
   layer 2. The letter's connective prose (salutation, the "I'm writing about X at Y" opening line,
   the closing) is **built in code from the job's own parsed title/company**, never generated, so
   the one-paragraph-one-fact invariant stays absolute instead of acquiring an exception.
3. **`screening.service.ts` + `screening.prompt.ts`** — the same two layers per question. Questions
   come from two sources (user-supplied and JD-parsed), which are kept **distinguishable on the
   row** rather than merged.
4. **`cv_supplement`** — one new table holding both artefact kinds, versioned per application the
   same way `cv_render` is, so a supplement stays reproducible against the facts it actually used.

**Tech Stack:** NestJS 10, TypeORM (migrations via `migrationsRun: true` at boot), Postgres, Jest.
Reuses `AiClientService`, `EntailService`, `scoreAiTell`, `MinioService`, `CvPdfService`,
`CvDocxService` unchanged.

**Spec:** `docs/specs/2026-08-22-cv-tailoring-platform-design.md` — §6.2 (proof-of-work fields),
§6 (grounding), §6.1 (anti-AI-voice), §12 (phase table, row **6**).

## Global Constraints

- **No third-party users before Phase 7 (GDPR).** Do not add an ingress manifest to
  `deploy.config.sh`. Phase 6 still runs on the owner's own data.
- **Free model tiers only** (`cheap` | `smart`). Phase 6 row of §12 says `smart`, and both new
  generators use it. `premium` stays blocked until the Phase 8 benchmark.
- **No silent failures.** Every catch re-throws or logs at error level with full context. "Not
  found" and "lookup failed" stay distinguishable. An empty completion raises; it never returns
  a blank letter.
- **The two grounding layers are not optional and not re-implemented.** Every model-authored
  sentence in a cover letter or a screening answer binds to exactly one `sourceFactId`, is
  validated against the snapshot in code, and is dropped with a recorded reason rather than shown
  if that fact does not exist. Layer 2 is `EntailService`, called with its existing signature. If
  a task tempts you to write a second entailment implementation, or to fold validation into the
  generation call, the design is wrong — a model grading its own output is not validation.
- **A degraded model refuses the completion**, exactly as `TailorService` and `ReviseService` do
  (spec §8.1). The anti-fabrication guarantee holds on every call in the pipeline.
- **Derived, never asked of the model.** Company name, job title, and the candidate's contact
  details are taken from the parsed job and the master CV in code. They must never appear in a
  generation `OUTPUT_SCHEMA` or system prompt, for the same reason `section`/`org`/`period` never
  did (recorded trap): an LLM naming the employer fabricates on a field the reader judges by.
- **`proof` surfacing is deterministic.** No LLM call selects or rewrites a proof fact. A model
  rewriting a URL is a broken link presented as a working one.
- Commit to `main`; the ecosystem deploy queue picks it up. Do not run `deploy.sh` by hand.
- Test gate before every commit: `npm test` (typecheck + build + jest). Never `npx tsc`.
- Baseline test counts from `STATE.json`: 45 suites, 518 cases, 507 passed, **11 skipped**. A skip
  count above 11 means a regression.
- The grounding eval is **not** a test and never runs in CI. Because this plan adds prompts but
  does **not** edit `tailor.prompt.ts` or `entail.prompt.ts`, the recorded baseline
  (`docs/evals/2026-08-24-grounding-baseline.md`) stays valid and needs no re-run. If a task
  changes either of those two files, that is out of scope — stop and re-run the eval first.

---

## File Structure

**New files:**

| File | Responsibility |
|---|---|
| `src/master/proof.ts` | Pure: classify a `proof` fact, extract its URL, format it for output. No I/O. |
| `src/master/proof.spec.ts` | Unit tests for the above. |
| `src/applications/supplement.types.ts` | `SupplementKind`, `CoverLetterBody`, `ScreeningAnswer`, `QuestionSource`, view types. |
| `src/applications/entities/cv-supplement.entity.ts` | One row per generated supplement revision. |
| `src/applications/cover-letter.prompt.ts` | System prompt, output schema, prompt builder, version constant. |
| `src/applications/cover-letter.service.ts` | Layer 1 for letter paragraphs + code-built connective prose. |
| `src/applications/cover-letter.service.spec.ts` | Tests over an injected fake `AiClientService`. |
| `src/applications/cover-letter-render.ts` | Pure: assembles the final letter Markdown from parts. |
| `src/applications/cover-letter-render.spec.ts` | Tests, including byte-stability. |
| `src/applications/screening.prompt.ts` | System prompt, output schema, prompt builder, version constant. |
| `src/applications/screening.service.ts` | Layer 1 per question, plus question de-duplication. |
| `src/applications/screening.service.spec.ts` | Tests over an injected fake `AiClientService`. |
| `src/applications/screening-questions.ts` | Pure: normalise, de-duplicate, and tag questions by source. |
| `src/applications/screening-questions.spec.ts` | Tests. |
| `src/applications/supplements.service.ts` | Orchestration: generate, persist, list, get, export a supplement. |
| `src/applications/supplements.service.spec.ts` | Tests over injected fakes. |
| `src/applications/dto/generate-cover-letter.dto.ts` | Body for `POST :id/cover-letter`. |
| `src/applications/dto/generate-screening.dto.ts` | Body for `POST :id/screening`. |
| `src/database/migrations/1756900000000-CreateSupplementTables.ts` | `cv_supplement` table. |
| `src/database/migrations/1757000000000-AddJobScreeningQuestions.ts` | `cv_job.screening_questions` jsonb. |

**Modified files:**

| File | Change |
|---|---|
| `src/applications/application.types.ts` | Re-export supplement types for a single import site. |
| `src/applications/applications.controller.ts` | Add the five supplement routes. |
| `src/applications/applications.module.ts` | Register the new entity, services. |
| `src/applications/tailor.prompt.ts` | **Not modified.** Listed here only to state the eval constraint above. |
| `src/jobs/job.types.ts` | Add `ScreeningQuestion` and extend `ParsedRequirements`. |
| `src/jobs/job-parser.service.ts` | Extract candidate screening questions from the posting. |
| `src/jobs/entities/cv-job.entity.ts` | Add `screeningQuestions`. |
| `src/export/cv-document.ts` | Add a letter/answers document shape both writers can render. |
| `src/export/cv-pdf.service.ts` | Render the new document shape. |
| `src/export/cv-docx.service.ts` | Render the new document shape. |
| `src/applications/render-markdown.ts` | Emit a proof block from `proof`-kind facts. |
| `STATE.json` | Phase 6 → done, new traps, updated test counts. |
| `CLAUDE.md` | Phase 6 architecture notes. |

---

## Task 1: Proof-of-work as a pure module

Spec §6.2. `cv_fact.kind = 'proof'` has been a valid kind since Phase 1 and is produced by
`fact-extractor.service.ts`, but a search of `src/` shows it is referenced in exactly two places —
the kind list and one line of the extractor's system prompt. Nothing surfaces it. This task makes
it a first-class output, deterministically.

**Why a pure module and not a prompt instruction:** a proof fact is a URL. A model asked to
"include the candidate's portfolio links" will eventually reformat, truncate, or invent one, and a
broken link presented as a working one is worse than no link. Selection and formatting are code.

- [ ] Create `src/master/proof.ts`:
  - `PROOF_URL = /\bhttps?:\/\/[^\s<>()\[\]]+/gi` — deliberately conservative; trailing
    punctuation is stripped separately rather than baked into the pattern.
  - `export interface ProofItem { factId: string; label: string; url: string | null; text: string }`
  - `export function parseProof(fact: { factId: string; text: string }): ProofItem` —
    extracts the first URL, strips trailing `.,;:)`]` from it, and derives `label` as the fact text
    with the URL removed and whitespace collapsed. A fact with **no** URL still returns a
    `ProofItem` with `url: null` and the full text as the label. Never returns null: dropping a
    proof fact because it lacks a link would silently lose a case study the user wrote out in prose.
  - `export function selectProofFacts(facts: FactSnapshot[]): ProofItem[]` — filters
    `kind === 'proof'`, preserves array order (first appearance, for the same
    determinism-by-contract reason `buildRenderMarkdown` orders that way), de-duplicates by
    normalised URL where a URL exists and by normalised label where it does not.
- [ ] Create `src/master/proof.spec.ts` covering: a bare URL; a URL with trailing punctuation; a
  `label — url` form; a proof fact with no URL at all (must survive with `url: null`); two facts
  citing the same URL with different labels (one item, first label wins); order preservation.
- [ ] Run `npx jest src/master/proof.spec.ts`.

**Verify:** before writing the implementation, confirm the test file fails for the right reason
(module not found), not because of a typo in the import path.

---

## Task 2: Surface proof facts in the CV render

- [ ] In `src/applications/render-markdown.ts`, after the existing section loop and **before** the
  `Additional Highlights` catch-all, emit a `## Proof of Work` section from
  `selectProofFacts(facts)` — one `- ` line per item, formatted `label — url` when a URL exists and
  `label` alone when it does not.
- [ ] The section is emitted **only** when at least one proof item exists. An empty heading in a CV
  is a defect the reader sees.
- [ ] Ordering: proof items in `selectProofFacts` order, which is facts-array order. This is a new
  ordering contract; add it to the existing determinism test in `render-markdown.spec.ts` rather
  than a new file, so the byte-stability assertions stay in one place.
- [ ] **Critical:** the proof section is derived from the render's `FactSnapshot[]`, not from the
  bullets array. A proof link is not a tailored claim and has no `sourceFactId` binding — it is
  reproduced verbatim, which is exactly why it needs no entailment pass.
- [ ] Add tests to `render-markdown.spec.ts`: proof section present and correctly placed; absent
  when no proof facts; three-pass byte-stability still holds with a proof section present (the
  `confirmClaim` re-render path re-parses its own output — a new section must not perturb the
  contact-block extraction between the H1 and the first `## `).
- [ ] Run `npx jest src/applications/render-markdown.spec.ts src/applications/bullet-id-artifact-stability.spec.ts`.

**Verify:** the artifact-stability suite must stay green. If a sha256 assertion there changes, the
proof section leaked into a hash a test pins for a fixture with no proof facts — investigate rather
than re-baselining.

---

## Task 3: Supplement types and table

- [ ] Create `src/applications/supplement.types.ts`:
  - `export const SUPPLEMENT_KINDS = ['cover_letter', 'screening'] as const;` + type.
  - `export const QUESTION_SOURCES = ['user', 'parsed'] as const;` + type. Kept distinguishable on
    the row: a question the user pasted from a real portal and a question the parser guessed from
    the posting have different reliability, and merging them would let a guessed question be
    presented to the user as one the employer actually asked.
  - `export interface CoverLetterParagraph { text: string; sourceFactId: string; targetRequirement: string | null; verdict: EntailmentVerdict; span: string | null }`
  - `export interface ScreeningAnswer { question: string; questionSource: QuestionSource; paragraphs: CoverLetterParagraph[]; droppedParagraphs: { text: string; reason: string }[] }`
  - `export interface SupplementProvenance { paragraphs: CoverLetterParagraph[]; droppedParagraphs: { text: string; reason: string }[]; answers?: ScreeningAnswer[] }`
- [ ] Create `src/applications/entities/cv-supplement.entity.ts`, mirroring `CvRenderEntity`'s
  discipline:
  - `id` uuid PK; `applicationId` uuid indexed; `kind` text; `revisionNo` int;
    `@Unique('uq_supplement_revision', ['applicationId', 'kind', 'revisionNo'])`.
  - `content` text — the rendered Markdown.
  - `factsSnapshot` jsonb — facts exactly as used, for the same reason `cv_render` snapshots them:
    a supplement stays reproducible after the master CV changes (spec §4.2).
  - `provenance` jsonb — `SupplementProvenance`.
  - `aiTellScore` int nullable; `modelUsed` text; `promptVersion` text; `validatorModelUsed` text
    nullable; `validatorPromptVersion` text nullable.
  - `idempotencyKey` text with a **unique** index, so a retried request cannot double-spend a
    generation — same rule as `cv_render`.
  - `createdAt` timestamptz.
- [ ] Create `src/database/migrations/1756900000000-CreateSupplementTables.ts` with `up` and a real
  `down`. Follow the exact style of `1756500000000-CreatePhase4Tables.ts` (raw SQL, explicit index
  names).
- [ ] Register the entity in `src/applications/applications.module.ts` and wherever the entity list
  is enumerated for TypeORM.
- [ ] Run `npm run typecheck`.

**Verify:** migrations run via `migrationsRun: true` at boot and there is **no standalone
data-source** (recorded trap). Do not attempt `typeorm migration:run`. To check the SQL, write a
throwaway `DataSource` script against a scratch database — never against production.

---

## Task 4: Cover letter prompt

- [ ] Create `src/applications/cover-letter.prompt.ts`:
  - `export const COVER_LETTER_PROMPT_VERSION = 'cover-letter-v1';`
  - `COVER_LETTER_SYSTEM_PROMPT` — modelled on `TAILOR_SYSTEM_PROMPT`, with the same hard rules
    renumbered for paragraphs:
    1. Every paragraph MUST be grounded in exactly ONE input fact; return that fact's `factId` as
       `sourceFactId`. Never merge two facts into one paragraph.
    2. Never introduce a number, percentage, duration, team size, job title, employer, or
       technology not already in the source fact.
    3. Write **body** paragraphs only. Do not write a greeting, an opening line naming the role or
       company, a sign-off, or a signature — those are added afterwards and anything you write
       there is discarded.
    4. Omit a fact rather than stretch it.
    - Voice block identical in spirit to the tailor prompt, including
      `` `Never use these words or phrases: ${AI_TELL_PHRASES.join(', ')}.` `` — imported from
      `./ai-tell`, never re-listed by hand.
  - `COVER_LETTER_OUTPUT_SCHEMA` — `{ paragraphs: [{ text, sourceFactId, targetRequirement }] }`,
    with `sourceFactId` singular by schema, not only by instruction, for the reason recorded in
    `tailor.prompt.ts`.
  - `export interface CoverLetterPromptInput { facts; requirements; jobTitle; company; language; styleExemplars; tone: 'plain' | 'warm' }` and
    `buildCoverLetterPrompt(input)`. `tone` selects one extra prompt line and nothing else; it must
    not relax any hard rule.
- [ ] **Do not** put `company` or `jobTitle` in the output schema. They are inputs the model reads
  and code writes — never fields the model returns.

---

## Task 5: Cover letter service (layer 1)

- [ ] Create `src/applications/cover-letter.service.ts`, structurally parallel to
  `tailor.service.ts`:
  - `constructor(private readonly ai: AiClientService) {}`
  - `async generate(input: CoverLetterPromptInput): Promise<CoverLetterResult>` where
    `CoverLetterResult = { paragraphs: DraftBullet[]; droppedParagraphs: {text, reason}[]; modelUsed: string; promptVersion: string }`.
  - Empty `input.facts` → log at warn, return no paragraphs, **never** call the model. Calling it
    here could only produce invention (copied rule from `TailorService`).
  - `tier: 'smart'`.
  - `completion.degraded` → **throw**. Same words, same reason as `TailorService`: a letter written
    by a downgraded model is the auto-rejected output this product exists to prevent.
  - Reuse the `FENCE` unwrapping and JSON parsing shape from `tailor.service.ts`. If that logic is
    copied a third time, extract it to a shared helper in this task rather than leaving three
    copies — but do **not** refactor `TailorService`'s grounding loop itself.
  - Enforce the source constraint in code: unknown `sourceFactId` → dropped with reason
    `unknown source fact`; already-used `sourceFactId` → dropped with reason `duplicate source fact`;
    empty text → dropped. Every drop is recorded in `droppedParagraphs`, never silently discarded.
- [ ] Create `src/applications/cover-letter.service.spec.ts` over a fake `AiClientService`:
  - happy path: three paragraphs, three known facts, none dropped;
  - a paragraph citing a fact absent from the snapshot is dropped with a reason and does not reach
    the output;
  - two paragraphs citing the same fact — second dropped;
  - `degraded: true` → rejects, and the rejection message names the model;
  - zero facts → no model call at all (assert the fake was never invoked);
  - a fenced ```` ```json ```` completion parses.
- [ ] Run `npx jest src/applications/cover-letter.service.spec.ts`.

---

## Task 6: Cover letter assembly (the code-built prose)

This is the task that keeps the "every model sentence binds to a fact" invariant absolute.

- [ ] Create `src/applications/cover-letter-render.ts`:
  - `export interface LetterParts { candidateName: string; contactLine: string | null; jobTitle: string | null; company: string | null; paragraphs: string[]; language: string }`
  - `export function buildCoverLetterMarkdown(parts: LetterParts): string`
  - Salutation, opening line, and closing are **built here, in code**, from `jobTitle`/`company`
    which came from the job parser — never from the model.
  - Null handling follows the house rule exactly: a null `company` prints nothing and is **never**
    filled from a neighbouring value. The opening degrades to a form that names only what is known
    (`I'm writing about the ${jobTitle} role.` / `I'm writing about the role you advertised.`), it
    never guesses.
  - Deterministic output by contract: paragraphs in array order, fixed separators, no timestamp,
    no locale-dependent formatting. The letter is exported as a PDF whose sha256 is used for
    artifact identity exactly as in spec §6.3, so a wall-clock or `Intl`-dependent string here
    would break idempotency the same way an unpinned `CreationDate` did (recorded trap).
  - `candidateName` and `contactLine` come from the master CV's own H1 and contact block, via the
    same extraction `render-markdown.ts` already performs. Reuse that helper; do not re-implement
    the parse.
- [ ] Create `src/applications/cover-letter-render.spec.ts`: full letter; null company; null job
  title; both null; a paragraph containing an em dash (must survive — this is prose, not a heading,
  so the `normalizeHeadingField` rewrite does **not** apply here); two identical calls produce
  byte-identical output.
- [ ] Run `npx jest src/applications/cover-letter-render.spec.ts`.

---

## Task 7: Screening questions — two sources, kept distinct

- [ ] In `src/jobs/job.types.ts` add:
  - `export interface ScreeningQuestion { text: string; source: QuestionSource }` (import the type
    from `supplement.types.ts`, or define `QUESTION_SOURCES` here and re-export — pick one home and
    keep it single).
  - Extend `ParsedRequirements` with `screeningQuestions: string[]`.
- [ ] In `src/jobs/job-parser.service.ts`, add screening-question extraction to the existing parse
  call — extend the existing `OUTPUT_SCHEMA` and system prompt rather than making a second LLM call
  for it. The instruction must be conservative: *return only questions the posting explicitly asks
  the applicant to answer; return an empty array if it asks none.* A posting that asks nothing is
  the common case and must not be padded.
- [ ] Add `screeningQuestions` jsonb (default `'[]'`) to `src/jobs/entities/cv-job.entity.ts` and
  migration `1757000000000-AddJobScreeningQuestions.ts`.
- [ ] Create `src/applications/screening-questions.ts`:
  - `export function mergeQuestions(user: string[], parsed: string[]): ScreeningQuestion[]` —
    normalises (trim, collapse whitespace, strip a trailing `?` for comparison only), drops empties,
    de-duplicates case-insensitively, and **user wins on a tie**, keeping the user's original
    casing and punctuation. A question the user actually saw on the portal is evidence; a parsed
    one is an inference.
  - Order: all user questions in their given order, then parsed questions not already present. The
    user's list is the one they will paste answers back into.
- [ ] Create `src/applications/screening-questions.spec.ts`: user-only; parsed-only; overlap with
  different casing and a stray `?` (one entry, `source: 'user'`); empty inputs → empty array;
  whitespace-only entries dropped.
- [ ] Run `npx jest src/applications/screening-questions.spec.ts` and the jobs parser suite.

**Verify:** extending an existing prompt's schema is a prompt change. `job-parser.service.ts` is
**not** covered by the grounding eval (which fixtures tailoring and entailment only), so no eval
re-run is required — but do re-run the full jobs suite, since `fit-scorer.service.ts` consumes
`ParsedRequirements` and validates citations against it.

---

## Task 8: Screening prompt and service

- [ ] Create `src/applications/screening.prompt.ts`, same shape as the cover-letter prompt:
  - `SCREENING_PROMPT_VERSION = 'screening-v1'`.
  - System prompt hard rules: one answer paragraph binds to exactly one fact; never introduce
    facts not present; **if no fact supports an honest answer, return no paragraph for that
    question** — an unanswerable screening question is a real signal for the user, and a fabricated
    answer to it is the single most dangerous output in the product, since the user pastes it into
    an employer's form under their own name.
  - Output schema `{ answers: [{ question, paragraphs: [{ text, sourceFactId }] }] }`.
  - The `question` the model echoes back is matched against the input list in code; an answer whose
    question is not in the list is dropped with a reason. The model does not get to invent
    questions.
- [ ] Create `src/applications/screening.service.ts`:
  - One model call for all questions (they share the same fact set; N calls would N-fold the cost
    and the timeout exposure for no grounding benefit).
  - Same degraded-model refusal, same fenced-JSON parsing, same enforce-in-code source constraint
    as Task 5 — but `sourceFactId` uniqueness is scoped **per question**, not across the whole
    response: two different questions legitimately draw on the same achievement.
  - A question with zero surviving paragraphs is returned with an empty `paragraphs` array and its
    drops recorded. It is **shown to the user as unanswered**, never omitted from the response —
    silently dropping it would leave the user to discover the gap on the employer's form.
- [ ] Create `src/applications/screening.service.spec.ts`: happy path over three questions; an
  echoed question not in the input list is dropped; the same fact used by two different questions
  is allowed; the same fact twice within one question is dropped; a question with no supportable
  answer returns present-but-empty; degraded → rejects; zero facts → no model call.
- [ ] Run `npx jest src/applications/screening.service.spec.ts`.

---

## Task 9: Supplements orchestration

- [ ] Create `src/applications/supplements.service.ts`. It owns the pipeline both kinds share:
  1. Load the application, assert ownership by `userId` (404 for another user's row — the same
     shape the existing service uses; do not invent a 403).
  2. Load the pinned `masterVersionId` snapshot — **never** `is_current` (spec §4.2, immutability
     rule). A supplement is generated against the same facts the CV was.
  3. Layer 1: `CoverLetterService.generate` or `ScreeningService.generate`.
  4. Layer 2: `EntailService.validate(paragraphs, facts)` — **unchanged signature, unchanged
     service**. This is the reuse the whole plan rests on. For screening, validate all questions'
     paragraphs in one call and re-attach verdicts by `sourceFactId` per question.
  5. Drop any paragraph with a non-`supported` verdict into `droppedParagraphs` with the verdict
     and span as the reason, exactly as the CV path drops a failing bullet. A non-`supported`
     verdict always carries a `span`; assert that rather than tolerating null.
  6. Assemble Markdown (`buildCoverLetterMarkdown`, or a question/answer list for screening).
  7. `scoreAiTell(content)` → `aiTellScore` (spec §6.1 applies to every prose artefact, not only
     the CV).
  8. Persist a new `cv_supplement` row at `revisionNo = max + 1` for that `(applicationId, kind)`,
     with the facts snapshot, provenance, both model ids, and both prompt versions.
  - `idempotencyKey`: derive it from `(applicationId, kind, revisionNo, sha256 of the request
    body)`, matching how `cv_render` does it. A retried POST must not double-spend a generation.
  - **The application's `state` is not touched.** A supplement is an accompanying artefact, not a
    step in the CV state machine; advancing `in_review` → anything from here would corrupt a
    machine Phases 4 and 5 built guards around.
- [ ] `list(userId, applicationId)`, `get(userId, applicationId, kind, revisionNo)`.
- [ ] `export(userId, applicationId, kind, revisionNo, artifactKind)`: render through
  `cv-document.ts` and the existing PDF/DOCX writers, store in MinIO, record a `cv_artifact` row.
  Reuse `CvPdfService`'s existing raise-on-unencodable-character behaviour untouched — it already
  points the caller at DOCX.
- [ ] Create `src/applications/supplements.service.spec.ts` over injected fakes covering: cover
  letter end to end; an `overreach` verdict drops its paragraph and records the span; screening
  with one unanswerable question; a second POST with the same body returns the existing row rather
  than generating again; another user's application → 404; a supplement generated against the
  pinned master, not the current one (assert with a master that has since changed).
- [ ] Run `npx jest src/applications/supplements.service.spec.ts`.

---

## Task 10: Controller, DTOs, export shape

- [ ] `src/applications/dto/generate-cover-letter.dto.ts`: optional `tone` (`plain` | `warm`,
  validated against the union), optional `language` (defaults to the render language).
- [ ] `src/applications/dto/generate-screening.dto.ts`: `questions?: string[]` (each non-empty
  after trim, capped at a sane count — 25 — so a paste accident cannot build an unbounded prompt),
  optional `language`.
- [ ] Routes on `applications.controller.ts`, all under the existing `@UseGuards(CvAuthGuard)`:
  - `POST :id/cover-letter`
  - `POST :id/screening`
  - `GET :id/supplements`
  - `GET :id/supplements/:kind/:revisionNo`
  - `GET :id/supplements/:kind/:revisionNo/download/:artifactKind`
- [ ] Validate `:kind` against `SUPPLEMENT_KINDS` and `:revisionNo` as a positive integer **before**
  the lookup, returning 400. Recorded trap: `cv_application.id` is a uuid column and a malformed
  path segment reaching Postgres surfaces as a bare 500, which callers classify as transient and
  retry. Malformed request must stay a permanent 4xx.
- [ ] Extend `src/export/cv-document.ts` with a second document shape (a titled block of
  paragraphs, plus an optional question/answer list) and render it in both
  `cv-pdf.service.ts` and `cv-docx.service.ts`. **One model, two writers** — the existing rule.
  Never let one writer grow a field the other lacks.
- [ ] The download endpoint 404s on a missing artifact and **never regenerates one** — a
  regenerated file could differ from what the user approved. Same rule as the CV download.
- [ ] Add controller tests to the existing applications controller spec.
- [ ] Run `npm test`.

---

## Task 11: Full gate, config, and documentation

- [ ] `npm test` — full gate. Expect suites and cases up from the 45/518 baseline; **skipped must
  still be exactly 11**. A higher skip count means an integration test regressed.
- [ ] No new environment variables are required: this phase adds no outbound integration. If a task
  introduced one, it must be added to `k8s/configmap.yaml` **and** documented here — do not leave
  it implicit.
- [ ] Update `STATE.json`: phase 6 → `done`, phase 7 → `next`, new test counts, and any trap this
  work discovered. Record explicitly that `EntailService` is now shared by three generators, so a
  change to its signature has three call sites.
- [ ] Update `CLAUDE.md` with a Phase 6 architecture paragraph: the `EntailService` reuse, the
  code-built connective prose, the two question sources kept distinguishable, and the
  deterministic proof surfacing.
- [ ] Commit to `main` and let the deploy queue pick it up. Confirm with
  `shared/scripts/deploy-queue/queuectl.sh status`, do **not** run `deploy.sh` by hand.
- [ ] Probe the new routes from inside the pod **via its podIP, not localhost** (recorded trap —
  the app does not bind loopback):

```bash
POD=$(rtk kubectl get pod -n statex-apps -l app=cv-tuning -o jsonpath='{.items[0].metadata.name}')
IP=$(rtk kubectl get pod -n statex-apps $POD -o jsonpath='{.status.podIP}')
rtk kubectl exec -n statex-apps $POD -- curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST http://$IP:3379/api/applications/00000000-0000-0000-0000-000000000000/cover-letter
```

Expected: `401` — the guard rejecting an unauthenticated call proves the route is mounted. A `404`
means the route was not wired.

---

## Self-Review

**Spec coverage.** §12 row 6 lists three items and all three are here: cover letters (Tasks 4–6, 9,
10), screening answers (Tasks 7–10), proof-of-work surfacing (Tasks 1–2). §6.2's "surfaced in
tailored output" is Task 2 specifically — the fact kind already existed, so the gap was surfacing,
not modelling. §6.1's `ai_tell_score` is applied to the new artefacts in Task 9 step 7 rather than
left as a CV-only measure. The `smart` tier in that row is used by both new generators.

**What this plan deliberately does not do.** It does not add a revision/chat loop for supplements.
`ReviseService` is CV-shaped (it re-renders bullets into a `cv_render`), and generalising it is a
larger refactor than Phase 6 needs — regenerating a supplement produces a new revision, which
covers the same user need at a fraction of the risk. It also does not put supplements into the
approval gate: `approve` guards the CV artifact the user is accountable for, and widening that
guard would let a cover-letter verdict block a CV export. Both are omissions by decision, not by
oversight; record them in `STATE.json.openItems`.

**Grounding integrity.** The one genuinely new risk in this phase is that a cover letter is prose,
and prose wants connective sentences no fact supports. Task 6 resolves that by construction rather
than by exception: connective text is code, so the "every model-authored sentence binds to exactly
one fact" rule needs no carve-out, and `EntailService` needs no new verdict for "this sentence is
not a claim". If an implementer finds themselves adding such a verdict, the prompt has leaked
greeting/closing generation and Task 5 rule 3 is being violated.

**Type consistency.** `EntailService.validate(bullets: DraftBullet[], facts: FactSnapshot[]):
Promise<EntailResult>` is used with that exact signature in Task 9 (verified at
`entail.service.ts:41`). `DraftBullet` is `{ text, sourceFactId, targetRequirement }` from
`tailor.service.ts:13`. `TailoredBullet` carries `verdict`/`span`, which is what
`CoverLetterParagraph` mirrors. `scoreAiTell(text: string): AiTellResult` from `ai-tell.ts:54`.
`FACT_KINDS` already contains `'proof'` (`master.types.ts:1`), so Task 1 adds no kind. The
`ApplicationsService` constructor currently takes 13 parameters ending in `bpcp`
(`applications.service.ts:62-79`); `SupplementsService` is a **new sibling service**, not a 14th
parameter — the existing constructor is not touched by this plan.
