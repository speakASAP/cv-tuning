# CV Tuning Phase 7 Implementation Plan — GDPR

> **For agentic workers:** this plan documents the Phase 7 GDPR gate as built. Foundations
> (pseudonymization, consent evidence) landed earlier in the phase; this plan covers the remaining
> scope — consent enforcement, hard-delete cascade, export, retention, offboarding, and the
> published sub-processor list.

**Goal:** Make the service safe for third-party users (spec §2.1 binding gate) by implementing the
GDPR requirements of spec §9 and §3.2.

**Spec:** `docs/specs/2026-08-22-cv-tailoring-platform-design.md` — §9 (GDPR), §3.2 (auth &
offboarding gap), §4 (schema already carries `consent_version`, `consent_at`, `expires_at`).

## What was already in place before this plan

- **Pseudonymization** — `src/ai/pseudonymize.ts` strips direct identifiers before every LLM call;
  local rendering keeps the original contact data (foundation commits, STATE.json).
- **Consent evidence** — `ConsentService` records the versioned CV-processing notice and timestamp
  on `cv_profile`; `GET/POST /api/master/consent` are authenticated and idempotent per version.

## Scope delivered by this plan

1. **Consent enforcement** — `ConsentGuard` (in `src/master/`) gates CV-processing routes on
   *current* consent (the stored version must equal the published notice version, so re-publishing
   the notice re-gates every processing route). Applied at method level to: master save & imports;
   job scoring; application create/regenerate/revise/confirm-claim/approve/retry-export and
   cover-letter/screening generation. Read-only routes and the data-subject-rights routes are
   deliberately **not** gated — a user who withdrew consent must still read, export, and delete.
   `ConsentGuard` runs after the controller-level `CvAuthGuard`, so it reads `req.user` and fails
   closed if it is unset.

2. **Hard-delete cascade** — `AccountDeletionService.deleteAccount(userId)` (`DELETE
   /api/privacy/account`). MinIO objects (render/supplement artifacts + `upload`/`linkedin` master
   source objects) are deleted and **verified gone** before any row is removed; row deletes run in
   one transaction across every `cv_*` table. Ordering is chosen so a mid-cascade crash leaves a
   *retryable* orphan-with-reference, never an unreferenced object. `MinioService` gains
   `deleteObject` (verified) and `objectExists` (HEAD).

3. **Export** — `DataExportService.export(userId)` (`GET /api/privacy/export`) returns profile,
   masters, fact graph, jobs, applications, renders, supplements, chats, and artifacts — both their
   references and their bytes (base64). An unreadable object is reported per-artifact
   (`dataError`), never silently dropped and never allowed to sink the whole export.

4. **Retention** — `RetentionService` (`POST /api/privacy/retention`): `expireJobRawText` nulls
   `cv_job.raw_text` past `expires_at` while keeping the derived `parsed`; `purgeOrphanedArtifacts`
   deletes artifacts whose render/supplement is gone, object-before-row. No scheduler lives here
   (AGENTS.md) — the endpoint is the trigger seam for BPCP/ops.

5. **Offboarding reconciliation** — `OffboardingService.reconcile()` (`POST /api/privacy/reconcile`)
   deletes `cv_profile`s whose auth account is gone. **Blocked by design:** auth-microservice emits
   no offboarding events and exposes no user-existence API, so the check goes through
   `IdentityProviderPort` (`AUTH_USER_LOOKUP_URL` seam). With no lookup configured it reports
   `blocked` and purges nothing; it only ever deletes on a positively CONFIRMED-gone signal, so an
   auth outage cannot cascade into deleting a live user's data. This is the documented,
   non-fabricated seam rather than an invented auth API.

6. **Sub-processor list** — `docs/privacy/subprocessors.md` publishes the processors named in spec
   §9 (OpenRouter, Google, Anthropic, self-hosted MinIO) with DPA links as `[MISSING: ...]`
   placeholders, since no authoritative project source provides the exact URLs.

## Tech stack

NestJS 10, TypeORM (migrations via `migrationsRun: true`; **no new migration** — every column used
already exists), Postgres, Jest. Reuses `MinioService`, `DataSource` transactions, `CvAuthGuard`.

## Tests

Focused unit specs per behaviour: `consent.guard.spec.ts`, `consent.service.spec.ts`
(hasCurrentConsent), `minio.service.spec.ts` (delete/verify/exists), and under `src/privacy/`:
`account-deletion`, `data-export`, `retention`, `offboarding`, `identity-provider`.

## Known blocked item

Offboarding reconciliation cannot run in production until auth exposes a user-listing/existence
capability. Tracked in STATE.json open items and `docs/privacy/subprocessors.md` "Known gap".
