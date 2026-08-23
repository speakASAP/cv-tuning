# cv-tuning

CV tailoring platform. A job seeker stores one master CV, submits job-posting URLs, and gets
a CV tailored to each position — reviewed as a git-style diff, revised through voice-driven
AI conversation, approved by the human, then downloaded as PDF and DOCX and tracked to
outcome.

**Port:** 3379 · **Domain:** `cv.alfares.cz` *(planned)* · **Status:** design only, no code yet

## Why this is not "generate a CV with AI"

49% of hiring managers auto-dismiss AI resumes, 19.6% of recruiters reject specifically for
AI generation, and ~40% of received applications show clear AI-generation signs. Competitors
optimize for an ATS parse layer that is now commoditized, while the human layer penalizes
exactly what they produce.

The product is a CV that is **provably the user's own**, tailored with evidence, that does
not read as AI-written. Anti-fabrication and voice preservation are the primary
architectural requirements, not prompt details.

## Documents

- [Design spec](docs/specs/2026-08-22-cv-tailoring-platform-design.md)
- Depends on the [BPCP workflow executor](../business-process-control-plane/docs/specs/2026-08-22-bpcp-workflow-executor-design.md), built first

## Build order

Free models (`cheap` / `smart`, ≈€0) for Phases 0–6. GDPR lands in Phase 7, the model
benchmark in Phase 8, premium in Phase 9 only if the benchmark justifies it, and
billing/pricing in Phase 10.

> **Gate:** no third-party user may access this service before Phase 7 (GDPR) completes.
> Phases 1–6 run on the owner's own CV data only.
