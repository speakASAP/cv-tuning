# Project Constitution: cv-tuning

> Protected document. Human approval is required. AI agents may draft only from approved source material and must not override the approved baseline without explicit approval.

```yaml
id: CONSTITUTION-cv-tuning
status: approved
owner: project owner
created: 2026-08-30
last_updated: 2026-08-30
completeness_level: validated
upstream: []
downstream:
  - ../01_vision/VISION.md
  - ../17_governance/PROJECT_INVARIANTS.md
```

## Purpose

This constitution protects the project intent for a truthful AI-assisted CV service: create a vacancy-specific CV grounded in the user's real experience, while preserving consent, privacy, evidence, and operational discipline.

## Constitutional principles

### Intent preservation

Every implementation artifact must trace to approved project intent and remain compatible with the shared service model.

### Human-controlled change

All changes that alter the approved business scope, privacy posture, approval gate, or public access policy require human approval before implementation.

### Scope boundaries

The project is scoped to tailored CV generation, review, and export. It must not silently expand into unrelated commerce, billing, inventory, or sales workflows without explicit approval.

### Data and security

- User CV data, job descriptions, and application state remain subject to consent and access control.
- No unsupported claim, guessed credential, or fabricated experience may be presented as fact.
- Secrets and tokens must never be exposed in repository documentation or logs.
- The project must preserve proper handling of model access, exports, and retention boundaries.

### Validation

No task is complete without evidence against its acceptance criteria and upstream goal.

## Amendment process

1. Create an amendment proposal under `docs/17_governance/amendments/`.
2. Explain the change, reason, affected artifacts, and compatibility impact.
3. Obtain human approval.
4. Update dependent artifacts and rerun relevant validation.

## Approval

Status: approved
Approved by: project owner
Approval evidence: owner-confirmation: product-concept-approved-for-cv-tuning
