# CV Tailoring Platform — Design

**Date:** 2026-08-22
**Status:** Approved for planning
**Service:** `cv-tuning`, port **3379**, domain `cv.alfares.cz`
**Depends on:** BPCP Workflow Executor (built first) —
`business-process-control-plane/docs/specs/2026-08-22-bpcp-workflow-executor-design.md`

---

## 1. Product thesis

A job seeker stores one master CV. They submit job-posting URLs. For each, the system
produces a CV tailored to that position, shown as a git-style diff, revisable through
voice-driven AI conversation, approved by the human, then downloaded as PDF and DOCX and
tracked to outcome.

### 1.1 The market constraint that defines the product

Research, 2026-08-22:

- LinkedIn receives **~11,000 applications/minute**; volume **+45% YoY**; a single posting
  can draw **500+ applications in hours**.
- **~40%** of applications recruiters receive show clear AI-generation signs.
- **49%** of hiring managers auto-dismiss AI resumes; **19.6%** of recruiters reject
  specifically for AI-generated CVs.
- Workday, Greenhouse, and Lever shipped AI-content classifiers in late 2025 that route
  flagged resumes to a lower-priority queue.
- Keyword stuffing is now actively penalized; semantic evidence outperforms repetition.
  `"built predictive models in Python/SQL, cut churn 23%"` outranks twelve repeats of
  `"data analysis"`.
- Tailored applications get **115% more interviews** than generic ones.
- Hiring is shifting to proof-of-work and skills-based evaluation.

**Therefore the product is not "generate a CV with AI".** Competitors (Teal, Jobscan,
Careerflow) optimize for an ATS parse layer that is commoditized, while the human layer now
penalizes exactly what they produce.

**The product is: a CV that is provably the user's own, tailored with evidence, that does
not read as AI-written.** Anti-fabrication and voice preservation are the #1 architectural
requirement, not prompt details. This is the moat — competitors cannot retrofit it, because
"generate fast" is their whole value proposition.

### 1.2 Competitive position

| Tool | Pricing | Strength | Gap |
|---|---|---|---|
| Teal | Free; $9/wk, $29/mo, $179/yr | Best free tier, tracking + builder | Template-driven tailoring, no revision loop |
| Jobscan | Free 5 scans/mo; $29.98–49.95/mo | Gold-standard ATS match score | Scan only; user rewrites by hand |
| Careerflow | Free; Pro ~$12–45/mo | LinkedIn-centric workflow | Same tailoring depth |
| Auto-apply tools | ~$10–20/mo | Volume | Produces exactly what gets auto-rejected |

Nobody combines URL-in → tailored CV → **git-diff review** → **voice AI revision** →
approve → download → outcome tracking, with **grounded, non-AI-sounding prose**.

Competitor pricing is recorded as market context only. This project's own pricing is set in
Phase 10, informed by the Phase 8 benchmark (§8.2) — not before.

## 2. Decisions (locked by owner, 2026-08-22)

| Area | Decision |
|---|---|
| Workflow | Build BPCP executor first as its own project; CV app consumes it |
| JD ingestion | Server fetch + readability, **paste fallback always available**. No headless browser in v1 |
| Output | Markdown → **both DOCX and PDF** |
| Voice | Web Speech API in browser (school-committee / statex pattern) |
| Master CV | Fact-graph JSON **and** rendered Markdown |
| Import | Paste/type, PDF/DOCX upload, Google Docs link, LinkedIn archive |
| v1 scope | Core loop + fit score/gap report + cover letter & screening answers + **proof-of-work fields** |
| Positioning | **Authenticity-first with AI-tell guard, plus proof-of-work fields** |
| Model tier | **Free models only** (`cheap` / `smart`) until the loop is proven. Premium is a **last-phase** decision |
| GDPR | Pseudonymize before LLM, explicit consent, sub-processor list + DPAs — **deferred to a late phase**, after the loop works |
| Billing / pricing / tiers | **Last phase.** Schema designed so it slots in without migration |

### 2.1 Sequencing principle (owner directive, 2026-08-22)

**Prove the loop first on free models. Add cost, compliance, and monetization last.**

Concretely: build and validate the full core loop using only the `cheap` and `smart` tiers,
which cost ~€0. Only once tailoring quality, grounding, and the review loop demonstrably
work do we introduce premium models, pseudonymization, GDPR lifecycle, payments, and
pricing. This inverts the usual instinct to design compliance in from the start, and the
tradeoff is deliberate and accepted:

- **Benefit:** no spend and no compliance engineering on a product that may need to change
  shape. Fastest path to knowing whether the core idea works.
- **Accepted risk:** GDPR work in a late phase means **the service must not be exposed to
  real third-party users until Phase 7 completes.** Development and testing run on the
  owner's own CV data only. This constraint is binding, not advisory — opening signup
  before the GDPR phase would process real PII without the required lifecycle.
- **Mitigation:** the data model in §4 already carries the columns the late phases need
  (`consent_version`, `consent_at`, `expires_at`), so the deferral is a matter of unbuilt
  behaviour, not a schema migration.

## 3. Architecture

```
Browser (Next.js, cv.alfares.cz)
  │  Web Speech API — voice never leaves the browser
  ▼
cv-tuning (NestJS, port 3379)
  ├─ auth-microservice 3370 ── JWT validation
  ├─ ai-microservice  3380 ── ALL LLM calls (no direct provider calls, ever)
  ├─ bpcp             3375 ── workflow instances, signals, audit
  ├─ minio            9000 ── original uploads, generated PDF/DOCX
  ├─ logging          3367 ── every phase boundary and every failure
  ├─ notifications    3368 ── review-ready alerts, outcome nudges
  └─ postgres (db-server) ── cv_* schema, own per-app role
```

**Port 3379.** Port 3378 is **not** free — it is `logging-microservice`'s `FRONTEND_PORT`
(`logging-microservice/k8s/configmap.yaml:14`, `.env:13`), merely absent from
`ECOSYSTEM_MAP.md`. The map is incomplete and must not be used to infer free ports. Add both
3378 and 3379 to the map in the same change.

### 3.1 Reuse (verified in-repo)

| Need | Reuse |
|---|---|
| JWT guard | `catalog-microservice/src/auth/catalog-auth.guard.ts` (has a `.spec.ts`) |
| MinIO wiring | `catalog-microservice/src/media/media.service.ts` + its configmap / external-secret |
| PDF generation | `invoices-microservice` `pdfkit ^0.19.1`, `src/invoices/invoice-pdf.service.ts` — returns `{content, sha256, mimeType, filename}`; reuse the sha256 for artifact idempotency |
| LLM validator pattern | `ai-microservice/src/teacher-assistant/` — `validate.prompt.ts` + `validate.schema.ts` + `validate.service.ts` + `__evals__/run-eval.ts` |
| ASR fallback (later) | `ai-microservice` `POST /voice/transcribe` (`src/voice/`), already accepts `language` |

DOCX uses the `docx` library — no ecosystem precedent, and DOCX often parses better in ATS
than PDF. **No headless Chromium**: a Chromium pod on the single node collides with the
deploy-lock serialization constraint, and pdfkit already produces a real text layer, which
is the actual ATS requirement.

### 3.2 Auth

Validate via `POST /auth/validate` — the established pattern
(`catalog-microservice/src/auth/catalog-auth.guard.ts:137`,
`domain-research/src/auth/auth-user.guard.ts:37`,
`invoices-microservice/src/common/customer-auth.guard.ts:35`).

`auth-microservice/src/auth/jwks.controller.ts` exists, and the hosted-auth migration plan
permits local verification "unless an approved repo-local local-verifier exception exists".
**Request that exception** — per-request auth round-trips on every chat turn will hurt.
Fall back to `/auth/validate` until granted.

**Offboarding gap.** `auth-microservice` emits no events (ECOSYSTEM_MAP.md:126). When a user
deletes their auth account nothing tells this service, so PII would persist indefinitely —
a GDPR violation, not an inconvenience. Two mitigations, both required:
1. Expose `DELETE /users/:id` for auth to call.
2. A reconciliation job that periodically re-validates known `user_id`s against auth and
   purges orphans. Do not wait for auth to grow events.

## 4. Data model (`cv_` schema)

```
cv_profile       user_id (auth id) pk, locale, consent_version, consent_at,
                 processing_opt_in bool, created_at

cv_master        id pk, user_id, version, source_type, source_ref,
                 markdown TEXT,                        -- SOURCE OF TRUTH
                 facts JSONB,                          -- derived projection
                 facts_extracted_from_markdown_sha TEXT,  -- drift detector
                 is_current BOOL, created_at

cv_fact          id pk, master_id, kind, payload JSONB, metric TEXT NULL,
                 period daterange, content_hash TEXT, position INT
                 -- kind: role | achievement | skill | education | certification | proof

cv_job           id pk, user_id, url, source(fetch|paste|extension),
                 raw_text, parsed JSONB, company, title, language,
                 fetch_status(ok|blocked|thin|failed), fetched_at, expires_at

cv_application   id pk, user_id, job_id,
                 master_version_id,          -- IMMUTABLE PIN, never is_current
                 state, bpcp_instance_id, outcome, render_language,
                 created_at, updated_at

cv_render        id pk, application_id, revision_no, markdown,
                 facts_snapshot JSONB,       -- facts as used, reproducible forever
                 provenance JSONB,           -- bullet -> {fact_ids, verdict, span}
                 fit_score INT, gaps JSONB, ai_tell_score INT,
                 created_by(ai|user),
                 model_used TEXT,            -- ACTUAL served model, not requested tier
                 validator_model_used TEXT,  -- entailment validator's served model
                 requested_tier TEXT,        -- cheap | smart | premium
                 degraded BOOL,              -- served model != requested tier
                 prompt_version TEXT,
                 idempotency_key TEXT UNIQUE

cv_artifact      id pk, render_id, kind(pdf|docx|cover_letter), minio_key, sha256

cv_chat          id pk, application_id, role, content, input_mode(text|voice), created_at
```

Billing tables attach later to `user_id` with no migration to the above.

### 4.1 Markdown ↔ fact graph (the conflict rule)

**Markdown is the user-facing source of truth. Facts are a derived, versioned projection.**

Without this rule, a user hand-edits their MD, facts go stale, and tailoring silently uses
the old facts — precisely the frozen-table failure class the ecosystem's no-silent-failure
rule was written about.

On Markdown save:
1. Re-extract facts from the Markdown.
2. Match fact IDs by **content hash + position**, so unchanged bullets keep their IDs and
   existing provenance stays valid.
3. Show the user a **fact-level diff** for confirmation, reusing the diff UI from §7.
4. Store `facts_extracted_from_markdown_sha`. Any later mismatch between that hash and the
   current Markdown **raises** — it never degrades quietly.

Facts are never written back to Markdown silently.

### 4.2 Master mutability vs application immutability

`cv_application.master_version_id` pins an **immutable master snapshot**; it never follows
`is_current`. `cv_render.facts_snapshot` stores the facts actually used. Editing the master
CV after generating applications therefore cannot silently change what the user already
reviewed or downloaded. Existing applications show a non-blocking "master CV updated —
regenerate?" affordance.

### 4.3 Multi-language

One **language-neutral fact graph**, language-tagged renders. JD language is auto-detected
into `cv_job.language`; render language is user-selectable per application
(`cv_application.render_language`). CZ/EN/RU are the realistic v1 set. Retrofitting this
after the fact graph ships is expensive, so it is in v1.

## 5. State machine

```
draft → queued → jd_parsing → jd_failed ──┐ (paste fallback re-enters jd_parsing)
                     │                     │
                     ▼                     │
                  scored (fit + gaps) ◀────┘
                     │
                     ▼
                 generating → generation_failed
                     │
                     ▼
                 in_review ⇄ revising        (voice/text AI loop)
                     │
                     ▼
                 approved → downloaded       ← last OBSERVED state
                     │
                     ▼
                 marked_sent                 ← USER-ASSERTED, visually distinct
                     │
                     ▼
        outcome: interview | rejected | offer | ghosted
```

`in_review` and `marked_sent` are the BPCP `wait-for-signal` states.

**`marked_sent` is user-asserted, not observed.** The app cannot see submission on a
third-party portal. It is rendered distinctly from observed states, and
`notifications-microservice` nudges a day after download ("any response?") to keep the
outcome dataset alive. Do not build pricing or B2B data claims on its precision.

`generation_failed` exists so a mid-generation `ai-microservice` failure surfaces explicitly
with the error, rather than leaving the application stuck in `generating` forever. A timeout
sweep transitions stuck instances.

## 6. Grounding: the anti-fabrication core

The naive design — "bullets cite `fact_ids`, a validator checks the IDs exist" — **does not
prevent fabrication**. Citation existence is not grounding. An LLM can write
`"Led a team of 12 engineers"` citing `fact_7 = {role: "Senior Developer", company: "X"}`
and pass trivially. Since fabrication is the one failure that destroys the product's reason
to exist, grounding is three layers:

**1. Constrained generation.** Every tailored bullet must be a transformation of exactly one
master bullet. The diff is then provably a rewrite, not an invention.

**2. Entailment validator.** A second LLM call with its own prompt and schema, asked per
bullet: *is this claim fully supported by these facts?* → `supported | unsupported |
overreach`, plus the offending span. Copy the proven house shape at
`ai-microservice/src/teacher-assistant/` (`validate.prompt.ts`, `validate.schema.ts`,
`validate.service.ts`, `__evals__/run-eval.ts`).

**3. Confirm-on-new-claim.** Anything flagged `overreach` surfaces in the review UI as an
explicit chip: *"you have not claimed this before — confirm or drop"*. This converts the
hardest technical problem into a product feature that fits the human-in-the-loop design.

**Eval harness is mandatory.** Copy `__evals__/run-eval.ts`. Without evals there is no way
to know whether a prompt change regressed grounding.

### 6.1 Anti-AI-voice

- Blocklist the GPT tells that classifiers key on: *leveraged, spearheaded, passionate
  about, results-driven, proven track record*.
- Carry the user's own phrasing from the master CV as style exemplars in the prompt.
- Rewrite achievements to **demonstrate** a JD's required skill; never inject the skill noun
  repeatedly.
- **`ai_tell_score`** is computed per render and shown before download.

### 6.2 Proof-of-work fields

`cv_fact.kind = 'proof'` holds portfolio links, repositories, case studies, and work
samples as first-class facts, surfaced in tailored output. This matches the 2026 shift to
skills-based hiring and is part of the authenticity-first positioning.

## 7. Diff UX

Unified git-style diff between `cv_render.revision_no` N and N−1, rendered client-side with
word-level granularity within lines. The baseline for revision 1 is the master CV Markdown,
so the first generation is reviewable as a diff too. Each changed bullet carries a "why"
chip sourced from provenance plus the JD requirement it targets, and an entailment verdict
badge.

The same diff component renders the fact-level diff from §4.1.

## 8. LLM usage and cost

Verified in `ai-microservice/litellm_config.yaml:23-56` and `AGENTS.md:45-82`:

```
free:           ollama/qwen2.5-coder:0.5b                          # 0.5B CODE model — unusable for CV prose
cheap:          openrouter/google/gemma-4-26b-a4b-it:free
cheap-fallback: openrouter/nvidia/nemotron-3-nano-30b-a3b:free
smart:          openrouter/google/gemma-4-31b-it:free
smart-fallback: openrouter/nvidia/nemotron-3-super-120b-a12b:free
premium:        anthropic/claude-sonnet-4-6                        # BLOCKED — last phase only
```

> Doc drift between `litellm_config.yaml` and `AGENTS.md` was corrected in
> `ai-microservice/AGENTS.md` on 2026-08-22. Config remains authoritative.

**All phases before the last use free tiers only.** Marginal LLM cost ≈ €0.

| Operation | Tier (Phases 1–6) | Last phase |
|---|---|---|
| CV/JD parsing, fact extraction | `cheap` | unchanged |
| Fit score + gap report | `cheap` | unchanged |
| **Tailoring generation** | `smart` | premium evaluated |
| **Entailment validation** | `smart` — short, high volume | unchanged |
| Revision chat turns | `smart` | premium evaluated |
| Cover letter, screening answers | `smart` | premium evaluated |

`free` is never used for prose: it is a 0.5B **code** model.

### 8.0 Model attribution is mandatory in results

Every generated artifact records and displays which model produced it. This is required
both as engineering evidence (the benchmark in §8.2 is meaningless without it) and as user-
facing transparency.

- `cv_render.model_used` stores the **actually served** model string, not the requested
  tier — read from `model_used` in the ai-microservice response
  (`llm.client.ts:193` returns it as `model`).
- `cv_render.prompt_version` stores the prompt revision, so output is reproducible.
- The API returns both on every render, and the review UI displays the model beside each
  generated revision and in the diff header.
- When generation and entailment validation use different models, both are recorded:
  `model_used` (generation) and `validator_model_used`.
- A render whose served model does not match the requested tier is marked `degraded` and
  the UI says so explicitly (§8.1).

### 8.1 Silent tier degradation is a first-class failure

`litellm_config.yaml:62-67` defines `smart → smart-fallback → Ollama`. A Gemini/OpenRouter
outage would therefore return a CV written by a **0.5B code model** — plausible-looking
garbage — violating the ecosystem's no-silent-degradation rule.

`ai-microservice/src/teacher-assistant/llm.client.ts:193` already returns
`model: payload.model_used ?? 'unknown'`, so detection needs no new capability.

**Requirement:** for generation-quality operations the CV service asserts the served model
matches the requested tier, and **rejects and surfaces `degraded`** rather than accepting a
fallback. Parsing and scoring may accept fallback.

The `router_settings` comment (lines 68-74) documents a production incident where nested
timeouts meant fallbacks never fired at all — budget the CV service's timeout **above** the
proxy's, not below.

### 8.2 Unit economics — measured in Phase 8, not assumed

No €/application figure exists, and none is needed until Phase 8. Phases 1–6 run entirely
on free tiers at ≈€0 marginal cost.

**Phase 8 benchmark:** run the same tailoring prompt across `cheap`, `smart`, and `premium`
on five real CVs, scoring AI-tells, factual grounding (via the §6 eval harness), and
€/application. Its output decides Phase 9 (premium yes/no) and feeds Phase 10 pricing.
Any €/month figure stated before Phase 8 is a hypothesis, not a plan.

### 8.3 Idempotency and rate limiting

- Idempotency key = `hash(master_version_id, job_id, prompt_version, render_language)`.
  Identical inputs return the existing render instead of re-billing.
- Server-side per-user rate limits on generation and chat turns — these map directly to
  spend.

## 9. GDPR — Phase 7

> **Deferred by owner directive (§2.1).** Everything in this section is built in Phase 7,
> after the core loop is proven. **Binding consequence: no third-party user may access the
> service before Phase 7 completes.** Phases 1–6 process the owner's own CV data only.
> The §4 schema already carries `consent_version`, `consent_at`, and `expires_at`, so this
> is deferred behaviour, not a deferred migration.

CV data is name, address, phone, full employment history, and education — unambiguously
personal data, for EU/CZ users. ICO/EDPS guidance indicates 6–12 months retention without
further consent.

**Pseudonymize before every LLM call.** Strip direct identifiers (name, address, phone,
email) and re-insert them locally at render time. The LLM sees roles, achievements, skills,
and dates — enough to tailor, far less to leak.

Also required:

- **Explicit, separate consent** at signup — not bundled into the terms checkbox.
  `cv_profile.consent_version` / `consent_at`.
- **Published sub-processor list** (OpenRouter, Google, Anthropic, MinIO-self-hosted) with
  DPAs where available.
- **Hard-delete cascade** `user_id → cv_* → MinIO objects` as one transactional operation
  that **verifies object deletion succeeded** — never fire-and-forget.
- **Export endpoint** returning fact graph, all renders, and artifacts.
- **Retention job**: `cv_job.raw_text` is third-party content — expire via
  `cv_job.expires_at`, keeping derived `parsed` requirements longer than `raw_text`.
  Purge orphaned artifacts.
- The offboarding reconciliation job from §3.2.

## 10. Failure handling (no silent failures)

Per the mandatory ecosystem rule:

- JD fetch failure sets an explicit `fetch_status` and surfaces the paste-fallback UI. It
  **never** yields an empty CV.
- "Not found" and "lookup failed" are distinguishable to every caller.
- Every catch either re-throws or logs at error level with full context (function, URL,
  params, status, body).
- Every phase boundary logs to `logging-microservice` with timing.
- Failures surface in the UI. A user never stares at an empty list with no message.

## 11. Testing

TDD per ecosystem standard. Critical coverage:

- Grounding evals (`__evals__` harness) — the product's core claim
- Fact-ID stability across Markdown edits (§4.1)
- `facts_extracted_from_markdown_sha` mismatch raises
- Application immutability when the master CV changes (§4.2)
- Tier-fallback detection rejects degraded generation (§8.1)
- Idempotency: identical inputs produce no second LLM spend
- Hard-delete cascade verifies MinIO object removal
- JD fetch failure surfaces paste fallback, never an empty CV

Confirm each test fails when the behaviour is broken before trusting a pass. Never
`npx tsc`; use the service's own compiler.

## 12. Phasing

Free models throughout Phases 0–6. Cost, compliance, and monetization land in Phase 7+
(§2.1).

| Phase | Content | Models |
|---|---|---|
| **0** | BPCP executor (`business-process-control-plane/docs/specs/2026-08-22-bpcp-workflow-executor-design.md`) | — |
| **1** | Service scaffold, auth, master CV import + MD/fact graph + conflict rule | `cheap` |
| **2** | JD ingest + fit score/gap report | `cheap` |
| **3** | Tailoring + grounding validator + eval harness + diff UI | `smart` |
| **4** | Voice revision loop, approve, PDF/DOCX export | `smart` |
| **5** | Dashboard, outcome tracking, notification nudges | `smart` |
| **6** | Cover letters, screening answers, proof-of-work surfacing | `smart` |
| **7** | **GDPR**: pseudonymization layer, consent, delete-cascade, export, retention, offboarding reconciliation | — |
| **8** | **Model benchmark** (§8.2): measure quality and €/application across tiers on real CVs | all tiers |
| **9** | **Premium enablement** — only if Phase 8 proves free tiers insufficient. Requires lifting the per-call approval block in ai-microservice | `premium` |
| **10** | **Billing / pricing / tiers** (payments-microservice), free-tier limits | — |

**Gate before Phase 7:** the service must not be exposed to real third-party users until
the GDPR phase completes (§2.1). Phases 1–6 run on the owner's own CV data.

**Gate before Phase 9:** the premium decision is evidence-driven. If Phase 8 shows `smart`
produces acceptable grounding and AI-tell scores, premium is not adopted and the cost model
stays at ≈€0.

## 13. Open items

1. **JWKS exception request** for local token verification (§3.2) — needed by Phase 1.
2. **Model benchmark** (Phase 8) — gates the premium decision and all pricing.
3. **Premium unblock mechanics** (Phase 9, only if Phase 8 justifies it) — `premium`
   requires per-call human approval; a metered path needs that policy lifted in
   `ai-microservice`.
Closed 2026-08-23:

- ~~Remote repo~~ — `git@github.com:speakASAP/cv-tuning.git`. The service was renamed from
  `cv-microservice` to `cv-tuning` on 2026-08-23; the name is used uniformly for the repo,
  the K8s deployment, and the Vault path `secret/prod/cv-tuning`.

Closed 2026-08-22:

- ~~`ECOSYSTEM_MAP.md` ports~~ — 3378 (logging frontend) and 3379 (cv) added, plus a
  cv-tuning service row.
- ~~`ai-microservice` doc drift~~ — `AGENTS.md` corrected against `litellm_config.yaml`:
  `cheap`/`smart` slugs, both fallback targets (Nemotron, not Ollama), plus new notes on
  silent degradation and timeout nesting.

## 14. Sources

Market and ATS research, 2026-08-22:
[Jobscan — best AI resume builders](https://www.jobscan.co/blog/best-ai-resume-builders/) ·
[Jobscan vs Teal 2026](https://resumeup.ai/jobscan-vs-teal) ·
[Best AI resume tailoring tools 2026](https://blog.fastapply.co/best-ai-resume-tailoring-tools-2026) ·
[Can ATS detect AI-written resumes](https://stylingcv.com/blog/can-ats-detect-ai-written-resumes-2026-research-10-systems/) ·
[ATS resume best practices 2026](https://resumeoptimizerpro.com/blog/ats-friendly-resume-tips) ·
[ATS keywords guide 2026](https://www.uppl.ai/ats-resume-keywords) ·
[The resume illusion — why AI resumes backfire](https://blog.theinterviewguys.com/why-ai-resumes-are-backfiring-in-2026/) ·
[AI resumes 2026 — do hiring managers reject them](https://www.kraftcv.com/blog/ai-resumes-2026-what-hiring-managers-think) ·
[Surviving the AI application flood](https://www.herohunt.ai/blog/surviving-the-ai-application-flood-2026-playbook/) ·
[AI hiring statistics](https://enhancv.com/blog/ai-hiring-statistics/) ·
[The rise of proof-based hiring](https://peerlist.io/whykislay/articles/the-rise-of-proofbased-hiring) ·
[GDPR candidate data retention](https://www.yena.ai/blog/gdpr-candidate-data-retention-recruitment-2026) ·
[GDPR in recruitment 2026](https://recruitee.com/blog/gdpr-in-recruitment)
