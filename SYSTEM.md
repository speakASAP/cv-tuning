# System: cv-tuning

```yaml
id: SYSTEM-cv-tuning
status: approved
owner: project owner
created: 2026-08-30
last_updated: 2026-08-30
completeness_level: validated
upstream:
  - BUSINESS.md
  - docs/01_vision/VISION.md
downstream:
  - docs/06_architecture/INTEGRATION_CONTRACT.md
  - docs/11_tasks/TASK-001-bootstrap-service.md
```

## Purpose

The system turns a user’s career knowledge and a target job description into a tailored, evidence-grounded CV without inventing facts. It connects user input, AI analysis, document review, and export so the final output stays anchored to real experience and is suitable for a given vacancy.

## Responsibilities

- Persist a master profile of the user's career experience.
- Accept and structure user-provided CVs, job descriptions, and supporting context.
- Compare the vacancy requirements to the user's evidence and identify gaps.
- Produce a tailored CV and explain which experience is emphasized or omitted.
- Keep provenance and claim traceability for each generated result.
- Support review, approval, export, and outcome tracking.

## Non-responsibilities

- The service does not act as a general hiring platform or employment marketplace.
- The service does not manage payments, inventory, or commercial order workflows.
- This service does not create unsupported claims or infer missing credentials.
- Ecosystem concerns such as infrastructure operations, central logging, and deployment are owned by shared services.

## Inputs

- User career information, CVs, project history, role descriptions, and supporting notes.
- Job description text, vacancy URLs, and employer requirements.
- Consent metadata and GDPR-related handling state.
- Shared ecosystem inputs such as logging, AI orchestration, monitoring, and object storage endpoints.

## Outputs

- Tailored CV drafts and revisions.
- Structured evidence of what is supported by the user's experience.
- Application outcome tracking and review metadata.
- Exported PDF and DOCX artifacts.
- Audit-visible service logs and health evidence.

## Dependencies

- Auth for user access and consent enforcement.
- Postgres for persistent application state.
- Redis as needed for workflow/cache support and state coordination.
- AI service for tailoring, grounding checks, and content revision.
- Notifications for nudges and outcome messages.
- MinIO for exported document storage.
- Logging, monitoring, and docs-RAG services from the shared ecosystem.

## Upstream traceability

This system is grounded in the approved business intent in `BUSINESS.md` and the protected vision in `docs/01_vision/VISION.md`. The product remains truthful, user-centered, and specific to a target opportunity rather than serving as a generic résumé generator.

## Downstream artifacts

- `docs/06_architecture/INTEGRATION_CONTRACT.md` for capability decisions and failure modes.
- `docs/11_tasks/TASK-001-bootstrap-service.md` for the bootstrap task record.
- `docs/12_validation/VAL-TASK-001-bootstrap-service.md` for validation evidence.
- `docs/17_governance/PROJECT_INVARIANTS.md` for the project guardrails.

## Validation criteria

- The service produces a CV that remains grounded in user-provided evidence.
- AI assistance does not fabricate or exaggerate unsupported claims.
- The workflow passes the required ecosystem integration checks.
- Health, observability, and export flows remain operational.

## Open questions

- Final public deployment route remains subject to approval and readiness.
- The public compliance and DPA references for external providers remain pending authoritative owner approval.
