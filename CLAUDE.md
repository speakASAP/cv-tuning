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
tables — it is the only regression net for prompt changes. No baseline is recorded yet: the
2026-08-23 attempt against the live ai-microservice errored on all 7 fixtures because that
deployment returns `model_used: "smart"` (a tier name, not a real model id), which
`ai-client.service.ts:127` correctly flags as degraded — `TailorService`/`ReviseService` then
correctly refuse the completion (spec §8.1). That's the anti-fabrication guard working as
intended, not an eval-harness bug, but it means the baseline is still blocked on an
ai-microservice fix (see `STATE.json.openItems`).

## Architecture

NestJS + TypeORM + Postgres on port 3379. Four domain modules pipeline into each other:

`master/` → `jobs/` → `applications/`, with `ai/`, `auth/`, `storage/`, `database/` as shared
infrastructure. All controllers are `@UseGuards(CvAuthGuard)` under `api/*`; only
`/health` is open.

**master/** — the user's one master CV. Markdown is the user-facing source of truth; the
fact graph is a *derived, versioned projection* (spec §4.1). On save, facts are re-extracted
and IDs re-matched by content hash + position (`fact-identity.ts`) so unchanged bullets keep
their IDs and existing provenance stays valid. Derived heading context
(`section`/`title`/`org`/`period`) sits deliberately **outside** `hashFactContent`: re-titling a
job heading must not orphan every fact under it and break the provenance links tailored CVs
already hold. Those columns are nullable and never backfilled — a guessed job title is
fabrication; pre-existing rows pick one up on the next master save. A mismatch between the stored
`facts_extracted_from_markdown_sha` and the current Markdown **raises** — it never degrades
quietly. Importers (`gdocs`, `linkedin`, `document`) all normalize into the same Markdown.

Each fact also carries `{section, org, period}` — **derived deterministically in code** by
walking the Markdown headings (`fact-provenance.ts`), never reported by the extraction model.
An LLM naming the employer or the date range would put a fabrication surface on exactly the
fields an employer judges a CV by (spec §6), so they must never enter
`fact-extractor.service.ts`'s `OUTPUT_SCHEMA` or system prompt. Mapping a returned fact back
to its heading block is normalised-text matching (exact, then containment with a length
floor); a fact that matches nothing, or matches blocks that disagree, gets `null` for that
field rather than a nearest-heading guess, and unmapped facts are logged at warn but never
throw — a heading-less CV is a valid input. The derived fields are deliberately **outside**
`hashFactContent`: including them would make re-titling a job heading orphan every fact under
it and break every provenance link a tailored CV already holds.

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

**Revision loop (Phase 4, spec §7)** — `revise.service.ts` + `revise.prompt.ts` behind
`POST :id/revise` and `GET :id/chat`. Revision runs through the same two-layer grounding as
initial tailoring: a revised bullet is still constrained generation, still entailment-checked,
still dropped rather than shown if it fails. The rate limit is durable and DB-backed, not
in-memory, because a restart must not reset a user's quota. `ReviseService` refuses a
completion served by an unexpected model for the same reason `TailorService` does (spec §8.1)
— the anti-fabrication guarantee has to hold on every call in the pipeline, not just the first.

**Approval gate (Phase 4, spec §7)** — `confirmClaim` lets the user resolve individual
`overreach` verdicts from the entailment validator; `approve` is blocked while any bullet has
an unresolved `overreach` verdict, and is guarded to only fire from `state === 'in_review'` so
an already-approved or already-exported application can't be re-approved into an inconsistent
state. **That guard is absolute and must stay that way** — an export failure is recovered
through a separate entry point (`retryExport`, below), never by relaxing it.

Bullets are addressed by `TailoredBullet.bulletId`, not by their text (`bullet-identity.ts`).
The id is *derived* — `b:<sourceFactId>` — not generated, which is what makes it work in three
places at once: `sourceFactId` is unique within a render by construction (both `TailorService`
and `ReviseService` drop a bullet whose source fact was already used), it survives a
`confirmClaim` re-render and a reword, and it recomputes identically for renders written
before the field existed, so `provenance`/`confirmedOverreach` jsonb already in the database
needs no migration. Always read it via `bulletIdOf(bullet)`, never as `bullet.bulletId` — a
raw read sees `undefined` on every stored render. A legacy `ConfirmedClaim` carrying only
`bulletText` still clears its claim when that text is unambiguous, and deliberately clears
nothing when two bullets share it: making the user re-decide is safe, silently clearing the
wrong twin is not. The id never reaches `buildRenderMarkdown` or either export writer, so the
spec §6.3 artifact sha256 is unaffected (pinned by `bullet-id-artifact-stability.spec.ts`).

**Export-failure recovery** — `approve` advances the state, then exports; a failing export
records `stateError: 'export failed: …'` and rethrows, and `approve` clears `stateError` only
once export has actually succeeded, so "approved and exported" and "approved but export
failed" stay distinguishable on the row. `POST :id/retry-export` → `retryExport` completes
that half-finished transition. It is an idempotent completion, never a re-approval, and is
gated on all three of: `state === 'approved'` (never `downloaded` — the user demonstrably
holds a file from that render), `stateError` set (without it there is nothing to retry, and a
second export of a healthy approval is a re-approval through a side door), and at least one
`ARTIFACT_KINDS` entry still missing (a complete set means the files may already be in the
user's hands). A retry that fails again re-records the error and rethrows; it never tidies the
state.

**export/ (Phase 4)** — one model, two writers, spec §6.3. `cv-document.ts` defines a single
document model that `cv-pdf.service.ts` and `cv-docx.service.ts` both render from, so PDF and
DOCX can never diverge in content, only in format. Artifacts are written to MinIO and served
through a download endpoint that 404s on a missing artifact and never silently regenerates one
— a regenerated file could differ from what the user actually approved. `CvPdfService` raises
on any character pdfkit's built-in Helvetica can't encode (CJK, emoji, Arabic — Helvetica is
WinAnsi-only) rather than corrupt the output, and points the caller at DOCX, which renders
those characters correctly; real embedded-font Unicode support is deferred (needs a TTF, a
licence decision, and a Docker image change). `info.CreationDate` is pinned to `new Date(0)`
because pdfkit hashes it into the PDF `/ID` trailer, and spec §6.3 reuses that sha256 for
artifact idempotency — an unpinned CreationDate would make the hash wall-clock dependent.
Export is a real multi-section CV: `render-markdown.ts#buildRenderMarkdown` takes the render's
`FactSnapshot[]` and groups tailored bullets by each source fact's derived `section`, then by its
`(title, org, period)` triple. Nulls print as nothing and are NEVER filled from a neighbouring
entry, and a bullet whose fact has a null section (or whose `sourceFactId` is unresolvable) goes
to a trailing `Additional Highlights` section rather than being dropped. Ordering is deterministic
by contract — first appearance in the bullets array, catch-all last — because spec §6.3 reuses the
artifact sha256 for idempotency. Entries carry the job title derived from the master's own
`### Role — Org (Period)` heading, so an entry reads `### Senior Developer — Acme (2019-2024)`; a
title that could not be derived keeps the title-less `### — Org (Period)` form. Nulls are values
in the grouping key, not wildcards: a promotion inside one company over the same period stays two
entries, and a title-less bullet never joins a titled one. The builder also carries the master's
own contact line(s) (email/phone/links) through into the render, joined with ` | ` — the exact
separator `cv-document.ts` splits on, which is what makes the `confirmClaim` re-render
byte-idempotent instead of duplicating or dropping the block.

**Outcome tracking (Phase 5, spec §5)** — `outcome.ts` holds the two transition rules as a pure,
dependency-free module, because they are the correctness core of the funnel. `marked_sent` follows
`downloaded` and nothing else: an `approved` application has artifacts but no evidence the user
ever took them, so accepting a send from there would let the funnel count a submission with no file
behind it. An outcome is only settable from `marked_sent`, because an outcome is a *reply to a
submission* — accepting one from `downloaded` would silently invent the missing send step and make
every conversion rate wrong. `marked_sent` is a **user assertion**, never an observation: the app
cannot see a submission on a third-party portal. `markSent` is therefore idempotent — the nudge asks
"did you send it?", and a user who taps twice must not have their original send date overwritten
with today's. `recordOutcome` deliberately allows correction and overwrite: `ghosted` is provisional
by nature, and refusing a reply three weeks later would freeze the dataset at its least accurate
reading. `sentAt`/`outcomeAt`/`nudgedAt` are nullable with no backfill — deriving a send date from
`updatedAt` would put fabricated timestamps into the very dataset the dashboard reports on.

**bpcp/** — the timer lives in BPCP, not here; cv-tuning gains **no scheduler of its own**, which is
what Phase 0 built the workflow executor for. `download` starts one outcome-watch instance per
application (guarded on `bpcpInstanceId` so a repeat download cannot queue a second nudge), and both
transitions deliver a signal that retires it. Every BPCP call is fail-soft **in one direction only**:
the user's file and the user's state change already happened and must stand, but the failure is
logged at error level with full context — a silently missing watch means a user is never nudged and
nobody finds out. `BpcpClientService` returns `null` for an unset base url and *raises* for a failed
call: "this deployment has no workflow plane" is a valid configuration, "the call failed" is not, and
collapsing both into one null would hide the second. BPCP's registry is in-memory with no create
route, so `docs/workflows/cv-application-outcome.workflow.json` reaches it as a mounted ConfigMap
(`scripts/publish-workflows.sh`) and is loaded at BPCP's boot — editing it needs a publish *and* a
BPCP restart. The wait action carries `onTimeout: 'continue'`, never `'fail'`: failing the instance
would never dispatch the nudge, which is the entire point of the timer.

**notifications/** — `NudgeController` (`POST /api/nudges/outcome`) is the BPCP action callback and
is deliberately **not** under `CvAuthGuard`: BPCP's dispatcher posts plain JSON with no user
credential, so a user-token guard would reject every call and the only symptom would be instances
stuck in BPCP. It is protected by the `x-cv-nudge-secret` shared-secret header, and by the service
having no ingress before Phase 7. The secret travels as `${env:CV_NUDGE_CALLBACK_SECRET}` in the
workflow document, resolved by BPCP's dispatcher at send time, so it never lives in a document that
is stored, listed over an API, and committed. The nudge is **sent before** `nudgedAt` is stamped:
stamping first would mark delivered a nudge that never left the building and the user would never be
asked again, whereas a crash between the two can at worst nudge twice. Unlike `BpcpClientService`, an
unset base url here *raises* — it is only ever reached when a nudge is already due.

**dashboard/** — read-only aggregation, computed **in SQL, never in JS**, so the numbers stay correct
as a user's history grows instead of loading every row to count it. The funnel is *cumulative*: an
application in `marked_sent` was necessarily downloaded and approved on the way there, so each stage
counts everything at or past it — reporting raw per-state counts would show a "downloaded" bar that
shrinks as users make progress. Every state and outcome key is present with an explicit `0`, because
a missing key renders as a hole in a UI while `0` is a real answer. `interviewRate` is `null`, never
`0`, when nothing has been sent: a rate over zero submissions is undefined, and `0%` would tell the
user their CV is failing when the honest answer is "no data yet". An `offer` counts toward it — an
offer necessarily passed the interview stage. Reply time is a **median**, not a mean: one application
answered after six months would drag a mean into fiction.

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

**Supplements (Phase 6)** — cover letters and screening answers, `SupplementsService` +
`cv_supplement`. The phase adds **no new grounding machinery**: `EntailService.validate()` is
generic over "claims bound to facts", so a cover-letter paragraph and a screening answer are both
a `DraftBullet` with a `sourceFactId` and get layer 2 unchanged. That service now has **three**
callers — a change to its signature has three call sites, not one.

The one genuinely new risk is that a letter is prose, and prose wants connective sentences no fact
supports. Resolved by construction, not by exception: the salutation, the opening line naming the
role and company, and the closing are **built in code** (`cover-letter-render.ts`) from the parsed
job, so the "every model-authored sentence binds to exactly one fact" rule keeps no carve-out and
the validator needs no "not a claim" verdict. If you find yourself adding such a verdict, the
prompt has leaked greeting generation and the cover-letter rule 3 is being violated.

Screening questions come from two sources kept **distinguishable on the row** (`questionSource`):
one the user pasted from a real portal, one this service parsed from the posting. The user wins
every tie, in the label as much as the text — presenting a guessed question as one the employer
asked would have the user answer a question nobody posed, under their own name. Verdicts are
re-attached to questions **by index**, never by `sourceFactId`, because two questions may
legitimately cite the same fact. An unanswerable question is returned present-but-empty and
rendered as explicitly unanswered; omitting it would leave the user to find the gap on the
employer's form.

Supplements have their **own document shape**: `renderToSupplementDocument`, not
`renderToDocument`. The CV parser does not raise on letter markdown — it silently collapses the
whole letter into `contact.parts`, which both writers render as one header blob. Both writers
expose `renderSupplement()`; one model, two writers still holds.

**Proof of work** — `cv_fact.kind = 'proof'` was a valid kind since Phase 1 and surfaced nowhere.
`master/proof.ts` selects and formats it **deterministically, LLM-free**: a proof fact is a URL,
and a model asked to include portfolio links will eventually reformat, truncate, or invent one.
Because the text is reproduced verbatim, it needs no entailment pass. Order is first-appearance
and is a contract — the render feeds a sha256 that spec §6.3 reuses as artifact identity.

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
- **Privacy boundary:** `AiClientService.complete()` pseudonymizes both system and user prompts
  before the request crosses into `ai-microservice`; local renderers continue to use the original
  master contact data. Keep new LLM callers behind this shared client rather than calling the
  upstream service directly.
- **Consent evidence:** `ConsentService` stores the published CV-processing notice version and
  timestamp on `cv_profile`. `GET/POST /api/master/consent` are authenticated and derive the
  user id from `CvAuthGuard`; repeated grants for the same version preserve the original
  evidence timestamp. **Consent is now ENFORCED:** `ConsentGuard` (`src/master/consent.guard.ts`,
  exported by `MasterModule`) gates CV-processing routes on *current* consent — the stored version
  must equal `CV_CONSENT_VERSION`, so re-publishing the notice re-gates every processing route. It
  is applied at method level (after the controller-level `CvAuthGuard`, whose `req.user` it reads)
  to: master save & imports, `POST /api/jobs/:id/score`, and application
  create/regenerate/revise/confirm-claim/approve/retry-export/cover-letter/screening. Read-only
  routes and the `/api/privacy` data-subject-rights routes are deliberately NOT gated — a user who
  withdrew consent must still read, export, and delete.
- **GDPR data-subject rights (`src/privacy/`, spec §9):** `GET /api/privacy/export` returns the full
  graph (profile, masters, fact graph, jobs, applications, renders, supplements, chats, artifact
  refs + base64 bytes; an unreadable object is reported per-artifact, never silently dropped).
  `DELETE /api/privacy/account` is the `user_id → cv_* → MinIO` hard-delete cascade. **Ordering is
  load-bearing:** MinIO objects are deleted and VERIFIED gone (`MinioService.deleteObject` = DELETE
  then a HEAD that must 404) BEFORE any row is removed, because a row deleted while its object
  lingers is an unreferenced orphan (unrecoverable) whereas the reverse is a retryable
  orphan-with-reference; row deletes then run in one transaction. `POST /api/privacy/retention`
  expires `cv_job.raw_text` past `expires_at` (keeping derived `parsed`) and purges orphaned
  artifacts object-before-row. No new migration — every column already existed. No scheduler here
  (timing belongs to BPCP/ops); the endpoints are the trigger seam.
- **Offboarding reconciliation is BLOCKED, by design.** `OffboardingService.reconcile()`
  (`POST /api/privacy/reconcile`) would purge `cv_profile`s whose auth account is gone, but
  auth-microservice emits no offboarding events and exposes no user-existence API. The check goes
  through `IdentityProviderPort` behind the `AUTH_USER_LOOKUP_URL` seam; unconfigured, it reports
  `blocked` and purges nothing, and it only ever deletes on a positively CONFIRMED-gone (404)
  signal — an auth outage (null/unresolved) never triggers a delete. Do not invent an auth
  endpoint; unblock only when auth grows a real one. Sub-processor list: `docs/privacy/subprocessors.md`
  (DPA links are `[MISSING: ...]` placeholders until an authoritative source provides them).
