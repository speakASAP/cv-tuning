# Integration Contract

## Purpose

This project participates in the Alfares ecosystem as a runtime service that provides truthful CV tailoring, job-fit analysis, document review, and export workflows. It relies on shared ecosystem capabilities for authentication, logging, monitoring, AI, notifications, storage, and documentation retrieval while keeping its domain logic scoped to the CV workflow.

## Capability decisions

The machine-readable decisions live in `ips-adoption.json`. This document adds the human-readable architecture and contract links.

| Capability | Component | Decision | Contract/API/event | Configuration | Failure mode | Validation evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Auth | `auth-microservice` | required | User access and consent enforcement | Service token or authenticated user session | Access denied and no draft generation for unauthorized flows | User access and consent checks pass |
| PostgreSQL | `db-server-postgres` | required | Durable relational state for CV, application, consent, and export metadata | Service database configuration and migrations | Service fails closed and surfaces storage errors | DB-backed lifecycle tests pass |
| Redis | `db-server-redis` | required | Caching and workflow state coordination | Shared Redis configuration | Temporary degradation with graceful fallback | Key workflow tests remain stable |
| Logging | `logging-microservice` | required | Structured log payloads to the shared logging endpoint | Central service metadata and log shape | Service logs remain available but operation continues with degraded visibility | Log emission and monitoring checks are recorded |
| Notifications | `notifications-microservice` | required | Outcome and reminder dispatch for application tracking | Notification channel configuration | User reminders fail without blocking the CV approval flow | Notification path is exercised and observed |
| AI | `ai-microservice` | required | Tailoring, claim grounding, and review assistance | Model and prompt policy configuration | The service degrades safely without fabricating claims | Grounded generation and eval harness remain passing |
| Payments | `payments-microservice` | not-applicable | None in the current onboarding scope | Not used | No payment flow in this service | Out of scope |
| Catalog | `catalog-microservice` | not-applicable | None in the current onboarding scope | Not used | No catalog dependency in this project | Out of scope |
| Orders | `orders-microservice` | not-applicable | None in the current onboarding scope | Not used | No order-processing dependency | Out of scope |
| Warehouse | `warehouse-microservice` | not-applicable | None in the current onboarding scope | Not used | No inventory dependency | Out of scope |
| Invoices | `invoices-microservice` | not-applicable | None in the current onboarding scope | Not used | No invoice dependency | Out of scope |
| Object storage | `minio-microservice` | required | PDF and DOCX exports and uploaded stored assets | Object storage bucket configuration | Export fails without silently deleting user data | Export and storage checks remain stable |
| Events | RabbitMQ | not-applicable | No direct RabbitMQ consumer/publisher workflow in the current scope | Not used | No event-driven loop required | Out of scope |
| Documentation retrieval | `docs-rag-microservice` | required | Direct Git ingestion | Repository catalog | Git fallback | Retrieval source check |
| Monitoring | `monitoring-microservice` | required | `GET /health` and probes | K8s manifests | Readiness blocks rollout | Health evidence |
| Backups | `backups-microservice` | required | Backup policy for persisted user and document state | Retention and backup schedule | Data loss is surfaced and triaged before public availability expansion | Backup posture is defined and reviewed |

## Data ownership

- User CV data, application state, and consent state are owned by the cv-tuning application and remain under the service's access controls.
- Exported artifacts are owned by the service until a user explicitly manages or removes them.
- Shared ecosystem services own their own operating telemetry and monitoring data.
- The job-tailoring response remains tied to source evidence and is never treated as an external source of truth.

## Authentication and authorization

- User authentication is enforced through the shared auth boundary.
- Consent gating remains part of the application workflow before third-party access is allowed.
- Service-to-service calls remain locked to the approved ecosystem boundary and tokens.

## Synchronous dependencies

- Postgres for persistence.
- Auth for identity and consent checks.
- AI service for generation and validation.
- MinIO for export storage.
- Logging and monitoring services for platform observability.
- Timeouts remain short and degrade gracefully instead of causing hidden failures.

## Asynchronous dependencies

- Notifications are triggered for user-relevant outcome updates and reminder workflow events.
- The project does not currently depend on RabbitMQ message consumption for its primary domain logic.
- Any workflow coordination remains contained within the service or the shared BPCP pattern, not a new parallel event bus.

## Degraded operation

When a required dependency is unavailable, the application should fail explicitly and surface the condition rather than silently continuing with invalid state. For non-required dependencies, the system remains safe and out-of-scope without making assumptions.

## Validation

Required integration evidence is recorded in `docs/12_validation/VAL-TASK-001-bootstrap-service.md` and the service-level gating checks in the repository's adoption and deployment validations.
