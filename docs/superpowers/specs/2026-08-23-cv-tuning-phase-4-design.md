# cv-tuning Phase 4 — voice revision, approval, PDF/DOCX export

Date: 2026-08-23 · Status: approved, not yet implemented
Parent spec: [`docs/specs/2026-08-22-cv-tailoring-platform-design.md`](../../specs/2026-08-22-cv-tailoring-platform-design.md)

Phase 4 closes the state machine from `in_review` to `downloaded` (parent §5). Phase 3 built
tailoring and the two grounding layers; Phase 4 adds the human loop on top of them and the
artifacts that come out the end.

Models: `smart`, free tier only. The pre-Phase-7 gate still holds — owner's own CV data only.

## 1. Decisions locked (owner, 2026-08-23)

| Question | Decision |
|---|---|
| How is a revision grounded? | **Full pipeline every turn** — constrained generation + a separate entailment call, identical to Phase 3 generation. |
| When are PDF/DOCX generated? | **On approve, both formats.** Download is a pure fetch. |
| Voice handling | **Backend accepts text only.** Browser does Web Speech API; the API takes an `input_mode` flag. Server-side ASR stays a later phase. |
| Spend bounds | **Per-application revision cap (20) + per-user chat-turn rate limit**, each raising a distinct explicit error. |
| Unresolved `overreach` at approve | **Blocks approval.** Every unconfirmed bullet must be confirmed or dropped, and the decision is recorded. |
| Export fidelity | **One fixed single-column CV template**, one document model, two writers. |

## 2. Approach

A revision turn is **a generation with more context**, not a new subsystem. It calls the
existing `TailorService` and `EntailService` unchanged and produces `cv_render` revision N+1,
so the existing diff endpoint renders it with no changes. The chat layer only persists turns
and assembles prompts.

Two approaches were rejected:

- **Patch-based revision** (model returns edit operations against the previous render). Fewer
  tokens, but any patch touching a bullet needs the same entailment check anyway, and it adds
  a new obligation — proving the patch did not rewrite a `sourceFactId`. More code guarding a
  weaker invariant.
- **A separate conversational agent** owning its own state. Splits grounding across two
  subsystems and makes "which render did this turn produce" ambiguous.

Export follows the same principle: **one document model, two writers**, never two independent
Markdown parsers that would drift apart.

## 3. Data model

Two new tables, both already declared in parent §4:

```
cv_chat      id pk, application_id, role(user|assistant), content,
             input_mode(text|voice), render_id NULL, created_at
cv_artifact  id pk, render_id, kind(pdf|docx), minio_key, sha256,
             byte_size, created_at
             UNIQUE(render_id, kind)
```

`cv_chat.render_id` ties an assistant turn to the render it produced (null on user turns), so
every turn is traceable to its output. The `cv_artifact` unique constraint is what makes
approving twice unable to produce a second PDF.

New columns:

- `cv_render.confirmed_overreach JSONB` — bullets the human explicitly accepted, each with the
  bullet text, the decision, and a timestamp. This is the audit trail proving a human accepted
  each new claim, not an advisory note.
- `cv_application.approved_at TIMESTAMPTZ NULL`
- `cv_application.revision_count INT NOT NULL DEFAULT 0` — enforces the cap without counting
  rows on every turn.

Migration follows the existing pattern in `src/database/migrations/`, run via `migrationsRun`
at boot. There is no standalone data-source (see `STATE.json.traps`).

## 4. Revision loop

`POST /api/applications/:id/revise` — body `{ instruction: string, inputMode: 'text'|'voice' }`.

1. **State guard.** Only `in_review` accepts a new revision. `revising` means a turn is
   already in flight, and a second concurrent turn would race for revision N+1 — which the
   existing `UNIQUE(application_id, revision_no)` constraint would reject with an opaque
   database error. Reject it here instead, with an explicit "a revision is already in
   progress" error. Any other state raises, naming the current state.

   A turn that dies mid-flight leaves `generation_failed`, not `revising` (see failure
   handling below), and `generation_failed` is recoverable through the existing regenerate
   path — so `revising` is never a terminal trap.
2. **Limit guard.** Per-application cap (20) and the per-user chat-turn rate limit (parent
   §8.3). Each raises its own distinct error so the UI can tell them apart — one is permanent
   for this application, the other clears with time.
3. Persist the user's `cv_chat` row.
4. State → `revising`. Assemble the prompt: previous render markdown, facts snapshot, JD
   requirements, prior chat history, the new instruction.
5. `TailorService.tailor()` — constrained generation. The one-to-one fact binding is enforced
   in code exactly as in Phase 3; a bullet whose `sourceFactId` is absent from the snapshot is
   dropped into `droppedBullets` with a reason.
6. `EntailService.validate()` — a separate call with its own prompt and schema. A model
   grading its own output is not validation; this must never be folded into step 5.
7. Write `cv_render` revision N+1 with fresh `ai_tell_score`, `model_used`,
   `validator_model_used`, `requested_tier`, `degraded`, `prompt_version`.
8. Persist the assistant `cv_chat` row pointing at that render. State → `in_review`.

**Failure handling.** Any failure between steps 4 and 8 sets `generation_failed` with
`state_error` populated, mirroring the Phase 3 generation path. An application must never be
left stuck in `revising`.

**Fact pinning.** The snapshot comes from the pinned `master_version_id`, never `is_current`
(parent §4.2). A revision cannot pull in facts added to the master CV after generation.

**Idempotency.** The parent §8.3 key does not apply to revisions — an instruction is new
content by definition. The cap and the rate limit are what bound spend here.

## 5. Approval

### 5.1 Confirm-on-new-claim

`POST /api/applications/:id/renders/:revisionNo/confirm-claim` — body
`{ bulletText: string, decision: 'confirm'|'drop' }`.

This is parent §6 layer 3 made real. `confirm` appends to `confirmed_overreach` with a
timestamp; `drop` removes the bullet. Either decision produces a new render, so the diff chain
stays an honest record of what changed and why.

Neither decision spends an LLM call — the text is already written and already validated — so
neither increments `revision_count` and neither counts against the cap or the rate limit. A
user must never be blocked from resolving a claim by a limit that exists to bound model spend.
The new render carries `created_by = 'user'`, distinguishing it from AI-authored revisions.

### 5.2 Approve

`POST /api/applications/:id/approve`:

1. Collect every bullet in the latest render whose verdict is `overreach` and which does not
   appear in `confirmed_overreach`.
2. If any remain, **raise**, listing every unresolved bullet. Approval is a gate, not a warning.
3. Otherwise state → `approved`, `approved_at` set.
4. Run export (§6).

An unresolved-overreach rejection and an export failure are different outcomes and stay
distinguishable to the caller.

## 6. Export

### 6.1 Document model

`renderToDocument(markdown) → CvDocument` parses a render into a narrow typed model:

```
CvDocument   contact: { name, email, phone?, links[] }
             sections: [{ heading, entries: [{ title?, org?, period?, bullets[] }] }]
```

The renders are a known narrow shape, so this parser is deliberately not a general Markdown
implementation. Input it cannot parse **raises** — it never emits a partial document, because a
CV silently missing a section is exactly the failure class this codebase exists to prevent.

### 6.2 Writers

Two writers over that one model, both returning the house shape used by
`invoices-microservice/src/invoices/invoice-pdf.service.ts` —
`{ content: Buffer, sha256: string, mimeType, filename }`:

- **`CvPdfService`** — `pdfkit`, A4, single column, real text layer. No headless Chromium: a
  Chromium pod on the single node collides with the deploy-lock serialization constraint, and
  pdfkit already produces the text layer that is the actual ATS requirement (parent §3.1).
- **`CvDocxService`** — the `docx` library. **New dependency, no ecosystem precedent** —
  acknowledged in parent §3.1. The alternative is hand-writing OOXML. DOCX often parses better
  in ATS than PDF, so it is not optional.

Single column with a real text layer is the ATS-optimal shape. No user-facing template choice
in Phase 4.

### 6.3 Storage and download

Both artifacts upload via the existing `MinioService.putObject` under
`cv/{userId}/{applicationId}/r{revisionNo}.{pdf|docx}`, then write `cv_artifact` rows carrying
the sha256 (reused for artifact idempotency, parent §3.1).

`GET /api/applications/:id/renders/:revisionNo/download/:kind` streams from MinIO. A missing
artifact raises 404 — it never silently regenerates, because a download that quietly produces a
different file than the one approved breaks the approval guarantee.

Export failure at approve time raises and leaves the application `approved` with an explicit
error. The CV is approved and the file is not ready; those are distinct, recoverable states.

## 7. Testing

TDD per parent §11. Confirm each test fails when the behaviour is broken before trusting a pass.

Critical coverage:

- A revision re-runs **both** grounding layers.
- A revision cannot cite a fact outside the pinned snapshot.
- A revision instruction that tries to smuggle a claim is caught (see evals below).
- Approve blocks on unconfirmed `overreach`, and the error names every unresolved bullet.
- Approve is idempotent: no duplicate `cv_artifact` rows.
- The revision cap and the rate limit raise distinct errors.
- A failure during `revising` lands in `generation_failed` with `state_error` set.
- The Markdown→document parser handles a real CV, and raises on input it cannot parse.
- The generated PDF contains an extractable text layer.
- sha256 is stable across identical input.

**Evals.** `revise.prompt.ts` is a new prompt, and no new prompt escapes the harness (parent
§6). Add fixtures to `src/applications/__evals__/run-eval.ts` for instructions that attempt to
smuggle claims — "say I led the team", "add Kubernetes", "make it sound more senior". The
harness stays manual and CI-guarded; it spends real tokens.

## 8. Prerequisite

`STATE.json.openItems` records that the Phase 3 eval harness has **no recorded baseline**.
Phase 4 adds a third prompt to a harness that has never been run.

**Run the existing harness against a live ai-microservice and record the table before writing
any Phase 4 prompt.** Without that baseline there is no way to tell whether a Phase 4 change
regressed Phase 3 grounding — which is the entire reason the harness exists. This is a
prerequisite task, not part of the build.

## 9. Out of scope

- Server-side ASR (`POST /voice/transcribe`) — later phase.
- User-selectable templates, fonts, or density.
- Cover letters and screening answers — Phase 6.
- Outcome tracking and notification nudges — Phase 5.
- Any exposure to third-party users — gated on Phase 7 (GDPR).
