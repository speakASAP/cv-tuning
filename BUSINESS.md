# Business: cv-tuning

> Protected business baseline. Human approval is required before changes to the approved business intent.

```yaml
id: BUSINESS-cv-tuning
status: approved
owner: project owner
created: 2026-08-30
last_updated: 2026-08-30
completeness_level: validated
upstream:
  - docs/01_vision/VISION.md
  - docs/00_constitution/CONSTITUTION.md
downstream:
  - SYSTEM.md
  - docs/22_goal_impact/GOAL-IMPACT-TASK-001.md
```

## Problem

Users often struggle to convert a rich personal work history into a CV that is specifically relevant to a target opportunity. Generic AI resume tools tend to either overfit to a template, invent unsupported claims, or fail to preserve the real signal of the user's experience. The result is a weak application that is less persuasive than the user's real background.

## Target users and stakeholders

- Job seekers who need a tailored CV for a specific vacancy.
- Recruiters and hiring managers who need a better-matched, evidence-based document.
- The product owner and technical operators responsible for privacy, consent, and data handling.
- The Alfares ecosystem services that provide logging, monitoring, AI assistance, and deployment support.

## Value proposition

The product creates a truthful, vacancy-specific CV from the user's real experience and evidence while preserving the ability to reuse one career knowledge base across many applications. The value is not a faster template rewrite; it is a better, more honest, and more relevant application package.

## Goals

- Capture and maintain a reusable master profile of the user's experience.
- Understand the target role from the job description or vacancy data.
- Identify the strongest relevant experience and highlight evidence-backed achievements.
- Ask clarifying questions when the user's background does not yet provide enough evidence.
- Generate a tailored CV without inventing experience, skills, or credentials.
- Support user review, revision, approval, and export to standard document formats.

## Non-goals

- Generating a CV without grounding in the user's actual experience.
- Fabricating certifications, achievements, or roles.
- Building a generic ATS-only optimizer with no evidence traceability.
- Expanding to unrelated commerce, payments, or inventory workflows in this onboarding scope.

## Success metrics

- A CV is generated from source evidence and can be traced back to the user's actual experience.
- The service identifies missing evidence and asks clarifying questions when needed.
- The final CV remains truthful, readable, and specific to the target role.
- The user can review, revise, and export the document without losing the underlying provenance.

## Business constraints

- Product intent must protect truthfulness and anti-fabrication by design.
- User consent and GDPR-compliant handling are required before third-party access or wider rollout.
- Development uses only approved and supported infrastructure and model tiers.
- No unsupported claims may be introduced in job-tailored outputs.
- Changes to business intent require owner approval and traceability.

## Approval

Status: approved
Approved by: project owner
Approval evidence: owner-confirmation: product-concept-approved-for-cv-tuning
