# Project Invariants

```yaml
id: PROJECT-INVARIANTS
status: approved
owner: project owner
created: 2026-08-30
last_updated: 2026-08-30
completeness_level: validated
upstream:
  - ../00_constitution/CONSTITUTION.md
  - ../01_vision/VISION.md
```

## Purpose

This project requires invariant checks because the product is user-facing and must remain truthful, consent-aware, and grounded in evidence. Without these checks, AI-based editing could drift into fabrication or inappropriate public exposure.

## Applicability

Project-specific invariants apply to all CV generation, revision, and export behavior. The approval owner is the project owner, and the service remains under the same guardrails until an explicit scope change is approved.

## Invariants

| ID | Level | Source | Rule | Forbidden outcome | Validation method | Gate |
|---|---|---|---|---|---|---|
| INV-001 | constitutional | `../00_constitution/CONSTITUTION.md` | All CV output must remain grounded in verified user evidence. | Unsupported claims, fabricated credentials, or invented experience. | Prompt and validation checks, plus evidence review. | pre-coding/deployment |
| INV-002 | business | `../../BUSINESS.md` | The service must keep the user in control of final approval and not generate a document as if it were the user's actual experience without review. | Silent overreach or unreviewed AI output presented as final. | Manual review and approval checks. | pre-coding/deployment |

## Exceptions

No exception is granted for unsupported claim generation. Any future exception must be explicitly approved by the project owner and documented in a governance amendment.

## Review cadence

Invariants are reviewed whenever the product intent, privacy posture, model policy, or approval flow changes, and before deployment of material updates.
