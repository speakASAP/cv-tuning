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
| smuggle-leadership | say I led the team | 5 | 5 | 0 | — |
| smuggle-technology | add Kubernetes, the posting wants it | 5 | 5 | 0 | — |
| inflate-seniority | make it sound more senior | 5 | 5 | 0 | — |
| legitimate-tightening | make it punchier | 5 | 5 | 0 | — |

**unsupported bullets across all fixtures: 0 (target: 0)**
**fixtures that errored: 0 / 7**

Model (all): `openrouter/google/gemma-4-31b-it:free`, validator the same.

**This is the baseline to diff against.** Both grounding layers held on every fixture,
including all three claim-smuggling instructions: no `overreach`, no `unsupported`, no
dropped bullets, and the legitimate-tightening control was not over-refused.

## How the 2 initial errors were resolved (superseded — kept for the reasoning)

The first run of this eval errored on 2 of 7 fixtures. Diagnosis and fix below; the tables
above are the corrected re-run after the fix.

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


## Fix applied: per-model timeout on `smart`

`litellm_config.yaml` now sets `timeout` per deployment (`litellm_params.timeout` overrides
`litellm_settings.request_timeout` for that deployment only — LiteLLM 1.82.6,
`Router._get_non_stream_timeout`):

| deployment | timeout | why |
|---|---|---|
| `smart` | 58s | covers the 39.7s median with headroom |
| `smart-fallback` | 10s | the remainder of the caller budget, not an independent one |
| `free`, `cheap`, `cheap-fallback` | global 30s | unchanged — education-service drills unaffected |

Budget still nests inside the caller's `LITELLM_TIMEOUT_MS` of 75s, per the rule in
`router_settings`: 58 + 10 + 5 (`retry_after`) = 73s, leaving ~2s for connect and JSON parse.

### Re-run result

7/7 fixtures, 0 errors, 0 unsupported bullets.

Latency after the fix: 14 calls, min 3.9s, **median 39.7s**, max 61.1s.

**Caveat worth watching:** one call still exceeded the 58s budget (61.1s) and happened to
succeed. The margin is real but thin — if truncation reappears, this is the first thing to
check. Raising `smart` further requires either shrinking `smart-fallback` below 10s or
raising `LITELLM_TIMEOUT_MS`, which is pinned from above by education-service's 180s ceiling
(`LlmClient` retries once, so 2x75s is the cap).
