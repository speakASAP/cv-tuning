# cv-tuning

```yaml
id: README-cv-tuning
status: approved
owner: project owner
created: 2026-08-30
last_updated: 2026-08-30
```

CV tailoring platform for users who want a truthful, vacancy-specific CV built from their real experience, not a generic AI rewrite.

## Status

The service is in the onboarding and validation phase. The core product scope is intentionally limited to owner-only CV work until consent and GDPR enforcement are complete.

## Documentation Authority

This repository follows the Alfares documentation authority and intent-preservation system. The product remains grounded in the approved AI-powered tailored CV concept and the service-specific adoption record.

## Capabilities

- Build a persistent master CV knowledge base from user-provided experience, project history, and career evidence.
- Analyze a target job description and identify the skills, achievements, and framing that are most relevant.
- Compare the user's evidence to the vacancy and surface missing or weak areas that need clarification.
- Tailor a truthful CV to a job while maintaining traceability to source facts and avoiding unsupported claims.
- Support review, revisions, approval, and export to PDF/DOCX.
- Track the outcome of applications while keeping the user in control of final approval.

## Interfaces

- Web application for CV intake, review, and approval.
- AI-assisted tailoring flow for vacancy understanding and content refinement.
- Export endpoints for PDF and DOCX generation.
- Dashboard and outcome tracking for the application lifecycle.
- Structured logging and monitoring integration with the ecosystem standard.

## Development

- Implementation stack: NestJS, TypeORM, Postgres, Redis, MinIO, AI orchestration, and the shared ecosystem services.
- Local development follows the repo's existing service commands and test suites.
- The current product scope is owner-only until the GDPR consent gate is complete.

## Configuration

- Service port: 3379
- Domain: cv.alfares.cz (planned public route, gated by approval)
- Model usage: existing free tiers during development; premium is deferred until the funded production rollout.
- Storage: Postgres for durable state, MinIO for document artifacts, and Redis for workflow/cache support if required by the runtime.

## Deployment

- Deploy via the shared Alfares deployment pipeline with serialized deploy execution.
- Health checks must respond on GET /health.
- No public third-party access before the GDPR consent gate is complete.

## Health and Observability

- Structured logs are emitted through the shared logging service.
- Monitoring checks use GET /health and Kubernetes probes.
- Application outcome and acknowledgement flows are observable through the application dashboard and service logs.

## Approval

Status: approved
Approved by: project owner
Approval evidence: owner-confirmation: product-concept-approved-for-cv-tuning
