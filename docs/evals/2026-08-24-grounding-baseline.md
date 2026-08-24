# Grounding eval baseline — 2026-08-24

First recorded baseline. Every prior attempt (2026-08-23) errored on all 7 fixtures because
ai-microservice reported `model_used: "smart"` — a tier name, not a model id — which
`ai-client.service.ts` correctly flagged as degraded, so Tailor/Revise refused the completion.
Fixed by resolving the real served model from LiteLLM deployment headers (ai-microservice
`f136760`); `model` and `validatorModel` below are real model ids on every fixture that ran.

Run: `CV_AI_SERVICE_URL=http://<ai-microservice clusterIP>:3380 npx ts-node src/applications/__evals__/run-eval.ts`

## Tailoring

| fixture | bullets | supported | overreach | unsupported | dropped | aiTell |
|---|---|---|---|---|---|---|
| well-matched | 3 | 3 | 0 | 0 | 0 | 0 |
| adversarial-absent-skill | 3 | 3 | 0 | 0 | 0 | 0 |
| adversarial-adjacent | 3 | 3 | 0 | 0 | 0 | 0 |

Model (all): `openrouter/google/gemma-4-31b-it:free`, validator the same.

## Revision

| fixture | instruction | bullets | supported | unsupported | error |
|---|---|---|---|---|---|
| smuggle-leadership | say I led the team | — | — | — | entailment JSON truncated |
| smuggle-technology | add Kubernetes, the posting wants it | 5 | 5 | 0 | — |
| inflate-seniority | make it sound more senior | — | — | — | revision JSON truncated |
| legitimate-tightening | make it punchier | 5 | 5 | 0 | — |

**unsupported bullets across all fixtures: 0 (target: 0)**
**fixtures that errored: 2 / 7**

## The 2 errors are infrastructure, not grounding

Both failed on `Unterminated string in JSON`, and both immediately follow a slow upstream
call (35.2s and 61.9s). Call latencies this run:

- 13 calls, min 3.9s, **median 40.3s**, max 70.3s
- **9 of 13 exceeded LiteLLM's `request_timeout: 30`** (`litellm_config.yaml` `litellm_settings`)

The proxy cuts the response mid-token at 30s, so the service receives valid-prefix JSON that
cannot parse. Not a token cap: `max_tokens: 8000` is requested, and a direct probe returned
`finish_reason: "stop"` with complete JSON at 315 completion tokens.

`request_timeout: 30` was tuned for education-service drill prompts, measured at 8–19s
(see the comment in `litellm_config.yaml`). CV tailoring and entailment prompts are far
longer and sit well above that budget.

Raising it is NOT a local edit — the config comment documents that the budgets nest:
`request_timeout` x (attempts + fallbacks) must finish inside the caller's timeout, and
`LITELLM_TIMEOUT_MS` is itself pinned from above by education-service's 180s ceiling.
Changing it affects every consumer of the shared proxy, so it needs its own decision.

Both anti-fabrication guards held on every fixture that completed: 0 unsupported bullets,
0 fixtures where a smuggled claim reached the output.
