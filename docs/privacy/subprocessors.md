# Sub-processors and DPAs

> Scope: the `cv-tuning` service (spec §9). This is the published sub-processor list GDPR §9
> requires. It is generated from the authoritative product design
> ([`docs/specs/2026-08-22-cv-tailoring-platform-design.md`](../specs/2026-08-22-cv-tailoring-platform-design.md) §9).
>
> **Anti-fabrication:** DPA URLs are recorded as `[MISSING: authoritative DPA URL]` unless an
> authoritative project source provides the exact link. Do not paste a guessed or search-result URL
> here — a wrong DPA reference is a compliance claim the project cannot stand behind. Replace a
> placeholder only from an authoritative source (a signed DPA, a procurement record, or the
> processor's own published DPA that the owner has accepted).

## What personal data leaves the service, and what does not

The LLM boundary sees **pseudonymized** prompts only. `src/ai/pseudonymize.ts` strips direct
identifiers (name, address, phone, email) before any prompt crosses into `ai-microservice`; the
original contact data is re-inserted locally at render time and never sent upstream (spec §9,
CLAUDE.md "Privacy boundary"). So a model provider receives roles, achievements, skills, and dates
— enough to tailor, far less to identify.

Object storage (MinIO) holds the full rendered artifacts and original uploads, which **do** contain
direct identifiers. It is self-hosted within the owner's infrastructure.

## Sub-processors

| Sub-processor | Role | Personal data exposed | Hosting | DPA |
| --- | --- | --- | --- | --- |
| OpenRouter | LLM routing/gateway for generation and validation calls | Pseudonymized CV content only (no direct identifiers) | Third-party (US) | `[MISSING: authoritative DPA URL]` |
| Google | LLM provider reachable via the gateway | Pseudonymized CV content only | Third-party | `[MISSING: authoritative DPA URL]` |
| Anthropic | LLM provider reachable via the gateway | Pseudonymized CV content only | Third-party | `[MISSING: authoritative DPA URL]` |
| MinIO (self-hosted) | Object storage for uploads and rendered PDF/DOCX artifacts | Full CV content incl. direct identifiers | Self-hosted (owner-operated) | Self-hosted — no third-party DPA; covered by the owner's own controls |

Model access is confined to free tiers (`cheap`/`smart`) until the Phase 8 benchmark; `premium`
is blocked (STATE.json). The exact provider that served a call is recorded per render
(`cv_render.model_used` / `validator_model_used`, spec §8.0), so the processor actually used for any
given artifact is inspectable rather than assumed.

## Data-subject rights and retention (implemented in `cv-tuning`)

- **Export (portability)** — `GET /api/privacy/export` returns the full fact graph, every render
  and supplement, chats, and artifact references and bytes.
- **Erasure** — `DELETE /api/privacy/account` runs the `user_id → cv_* → MinIO` hard-delete
  cascade; MinIO objects are deleted and verified gone before any row is removed.
- **Retention** — `POST /api/privacy/retention` expires `cv_job.raw_text` past its `expires_at`
  (keeping the derived `parsed` requirements) and purges orphaned artifacts.
- **Consent** — CV-processing routes require current consent to the notice version published by
  `ConsentService` (`GET/POST /api/master/consent`).

## Known gap

- **Offboarding reconciliation** (spec §3.2) is implemented but **blocked** at runtime:
  auth-microservice emits no offboarding events and exposes no user-listing/existence API, so there
  is no authoritative signal that an auth account was deleted. The reconciliation seam
  (`AUTH_USER_LOOKUP_URL` → `IdentityProviderPort`) refuses to purge on an unconfirmed signal and
  reports `blocked`. It activates only once auth exposes such a capability.
