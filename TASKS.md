This file is the concise human-readable work queue. Detailed task contracts live under `docs/11_tasks/`; execution plans and validation reports remain linked from those task documents.


# Tasks: cv-tuning


## Active

- **Manual end-to-end testing on free tiers, owner's own data.** The owner is validating the
  full pipeline by hand: master CV import → job ingest → tailoring → revision → approve →
  PDF/DOCX export → outcome tracking → cover letter / screening answers. Runs against `cheap`
  and `smart` only. Goal is confidence that the product is genuinely good before money enters
  the picture. Findings from this pass become the next work items.


## Ready next

- Fix whatever manual testing surfaces. Nothing else is queued ahead of it.
- Replace the `[MISSING: ...]` DPA placeholders in `docs/privacy/subprocessors.md`, only from
  authoritative owner-approved sources.
- Run the deployment preflight when the repo is ready for rollout (`delivery.last_deployment_commit`
  in STATE.json is still null). The service already runs in-cluster; this is the formal gate, not
  first deployment.
- **Confirm the intended exposure of `cv.alfares.cz`.** The service is already public:
  `k8s/ingress.yaml` is deployed, `deploy.config.sh` post-verifies the public URL, and as of
  2026-09-05 `/health` returns 200 and `/api/*` is reachable from the internet (guarded — an
  unauthenticated nudge POST gets 403). The Phase 7 GDPR gate is satisfied, so this is legitimate,
  but it means manual testing happens on an internet-facing deployment, not an isolated one.
  Decide whether that is intended for the free-tier validation period; if not, the ingress can be
  pulled while testing continues in-cluster.


## Blocked

- **Phase 8 — `premium` benchmark arm.** Blocked on owner go (see Owner gate). The cheap/smart
  arms are done: 2026-08-30, five consented external fixtures, evidence in
  `docs/evals/2026-08-30-phase-8-benchmark-result.md`. The outstanding outputs — spec §8.2's
  €/application figure and the AI-tell tier comparison — need paid models and are deferred with
  the rest of monetization.
- **Phase 9 — premium enablement.** Blocked on owner go, then on Phase 8's premium evidence; per
  spec §8.2 the decision is evidence-driven. Also requires lifting the per-call approval on
  `premium` in ai-microservice.
- **Phase 10 — billing, pricing, free-tier limits** via payments-microservice. Blocked on owner
  go, then on Phase 8 feeding the pricing model. Schema already accommodates it; no plan document
  written, and none should be written before the go.
- Offboarding reconciliation (`POST /api/privacy/reconcile`). Blocked by design: it only deletes on
  a positively CONFIRMED-gone (404) signal from `IdentityProviderPort`. Do not invent an auth
  endpoint; unblock only when auth-microservice grows a real one.
- Authoritative DPA references for external providers remain pending owner approval.


## Completed


- `TASK-001-bootstrap-service` — onboarding and governance baseline completed, including business/system/vision, integration contract, task records, execution plan, validation record, and state metadata.
- Phases 0-7 — all plan documents under `docs/superpowers/plans/` carry `status: done`. Verified
  2026-09-05: `npm test` green at 68 suites, 766 passed, 11 skipped (the 11 are integration tests
  needing a live Postgres; a higher skip count means a regression). This is the complete product
  pipeline; what remains unbuilt is monetization only.


## Handoff


Machine-readable Wave projection: `STATE.json` (projection contract only — no phase or status
narrative; the former status block is archived at `docs/orchestrator/legacy-state-archive.md`).
Per-phase status: the `status:` front matter in each `docs/superpowers/plans/` document.
Validation records: `docs/evals/`.
Detailed bootstrap task: `docs/11_tasks/TASK-001-bootstrap-service.md`.

**Before starting anything monetization-related, read "Owner gate" at the end of this file.**


## Owner gate — monetization is NOT started

**No monetization work begins without the owner's explicit "go".** Recorded 2026-09-05 at the
owner's instruction. This covers Phase 8's `premium` arm, Phase 9 (premium enablement), and
Phase 10 (billing/pricing/tiers) — all three are listed under Blocked above.

The reason is deliberate and is not a scheduling accident: the product must be proven to work
end-to-end on the **free tiers** (`cheap`/`smart`), on the owner's own data, before any paid
service is used or any pricing decision is made. A good result on free models is the
precondition for spending money, not the other way round.

Agents: do not start these phases, do not run `premium` benchmark arms, do not set
`CV_BENCHMARK_PREMIUM_HUMAN_APPROVED`, and do not treat "Phase 8 is incomplete" as a reason to
proceed. Incomplete here is intended.
