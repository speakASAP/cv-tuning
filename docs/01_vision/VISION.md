# Vision: cv-tuning

> Protected intent baseline. Human approval is required before changes to the approved project direction.

```yaml
id: VISION-cv-tuning
status: approved
owner: project owner
created: 2026-08-30
last_updated: 2026-08-30
completeness_level: validated
upstream:
  - ../00_constitution/CONSTITUTION.md
downstream:
  - ../../BUSINESS.md
  - ../17_governance/PROJECT_INVARIANTS.md
  - ../22_goal_impact/GOAL-IMPACT-TASK-001.md
```

## One-sentence vision

Create a truthful, evidence-backed AI career agent that turns one user knowledge base into the strongest CV for a specific opportunity without fabricating experience.

## Problem statement

Users have a rich professional history, but their experience is often scattered across CVs, LinkedIn information, projects, and conversational notes. Generic AI CV tools either flatten that experience into a template or fabricate unsupported detail. The result is a weak application that fails to represent the user's real strengths.

## Target users

- Job seekers preparing for a specific role.
- Career changers who need to reposition their experience for a different job family.
- Users who want to keep one career knowledge base but generate multiple tailored CVs.
- Product owners and operators responsible for privacy, grounded generation, and consent.

## Core user need

The user needs a system that understands their real background and can present it in the strongest truthful way for a target role, with guidance when they need to fill evidence gaps.

## Key outcomes

- A reusable master profile of the user's career data.
- A vacancy-specific analysis that highlights the strongest relevant evidence.
- Clarifying questions when the user's background does not yet show sufficient proof.
- A tailored CV that preserves the user's voice and remains grounded in fact.
- Exportable outputs and review feedback for the final document.

## Non-goals

- Generic AI rewrite without evidence.
- Fabrication of credentials, achievements, or experience.
- Unapproved product expansion into unrelated domains.
- Public access before consent and privacy gates are complete.

## Success criteria

- The service produces a tailored CV that traces back to verifiable user evidence.
- It can identify missing evidence and ask follow-up questions when needed.
- No unsupported claim is rendered as valid evidence.
- The user can review, revise, and export the final document with confidence.

## Approval

Status: approved
Approved by: project owner
Approval evidence: owner-confirmation: product-concept-approved-for-cv-tuning
