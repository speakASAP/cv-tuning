# Phase 8 benchmark — result (cheap / smart), 2026-08-30

Run of `src/applications/__evals__/benchmark-run.ts` against five real, externally-supplied
CV fixtures, each with current recorded consent for this processing (spec §8.2). Harness,
fixture format, and privacy rules: `docs/evals/2026-08-28-phase-8-benchmark.md`.

This document records **aggregated, tier-level numbers only**. The per-run detail table and
all fixture content are deliberately excluded — they contain tailored bullet text derived
from real CVs, which is exactly what the harness doc forbids committing.

## Result

| Tier | Fixtures completed | Supported bullets | Overreach | Unsupported |
|---|---|---|---|---|
| `cheap` | 5/5 | 21 | 1 | 0 |
| `smart` | 5/5 | 21 | 0 | 0 |
| `premium` | skipped | — | — | — |

`premium` was not run. The development LiteLLM router intentionally does not expose it, so
the runner recorded those rows as `skipped` rather than attempting paid calls — the
designed behaviour when `CV_BENCHMARK_PREMIUM_MODELS` is unset, not a failure.

## What this does and does not settle

**Settles:** both free tiers complete the full tailoring + entailment workload on real CVs
with zero unsupported bullets. `smart` produced no overreach verdicts; `cheap` produced one,
which the approval gate surfaces to the user rather than shipping (`confirmClaim`, spec §7).
Grounding holds on real input, not only on the synthetic fixtures `run-eval.ts` covers.

**Does not settle:** the €/application figure and the AI-tell tier comparison that spec §8.2
names as Phase 8's outputs. Both need the `premium` arm to be a comparison rather than a
single-tier reading, and the cost side needs a funded deployment that actually serves
premium. Until then Phase 8 stays open and **Phase 9 (premium enablement) stays blocked** —
per spec §8.2 the premium decision is evidence-driven, and there is no premium evidence yet.

Any €/month or €/application figure quoted before that run is a hypothesis, not a measurement.

## Retention

The fixture directory and `benchmark-output/` contents from this run are working data for a
one-time measurement, not artifacts this service retains. Delete them once the Phase 9
decision is made; the numbers above are the record that survives.
