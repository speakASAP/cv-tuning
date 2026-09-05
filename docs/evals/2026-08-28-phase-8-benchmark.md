# Phase 8 tier benchmark — infrastructure

> Status: infrastructure only. No benchmark run has been executed or recorded under this
> document. Spec §8.2: "run the same tailoring prompt across `cheap`, `smart`, and `premium`
> on five real CVs, scoring AI-tells, factual grounding ... and €/application. Its output
> decides Phase 9 (premium yes/no) and feeds Phase 10 pricing." STATE.json: "Free tiers only
> (cheap|smart) until Phase 8 benchmark. premium is BLOCKED."

This benchmark is **not** the grounding regression net (`run-eval.ts` — see its own header
comment and `docs/evals/2026-08-24-grounding-baseline.md`). That harness runs small,
synthetic, committed fixtures against whatever tier `TailorService`/`EntailService`
currently hardcode, to catch a prompt regression. This one runs the same tailoring +
entailment workload across **three tiers** on **five real, external CVs**, to answer a
one-time cost/quality question. The two never share fixtures and must not be conflated.

## Why this needs a separate script, not a flag on `run-eval.ts`

- `TailorService.tailor()` and `EntailService.validate()` hardcode `tier: 'smart'` — that is
  current production behaviour (spec §8: tailoring/entailment are `smart`-only until the
  last phase), not an oversight. Making them tier-configurable, or widening the production
  `AiTier` type (`src/ai/ai-client.service.ts`) to include `'premium'`, would let a
  production caller reach `premium` by accident — exactly the thing STATE.json says is
  blocked. `src/applications/__evals__/benchmark-client.ts` is a deliberately separate,
  benchmark-only client with its own `BenchmarkTier` type, so production typing is
  untouched.
- Real CV content must never be hardcoded into this repository. Fixtures are therefore
  loaded from an external directory at runtime, never committed (see below).

## Running it

Development uses the existing free `cheap` and `smart` routes only. Leave
`CV_BENCHMARK_PREMIUM_MODELS` unset (or set `CV_BENCHMARK_TIERS=cheap,smart`) until a
funded production rollout explicitly enables a premium route; the runner then records
premium rows as skipped rather than attempting paid calls.

```bash
CV_AI_SERVICE_URL=http://<ai-microservice clusterIP>:3380 \
CV_AI_JWT_SECRET=<matches ai-microservice's JWT_SECRET> \
CV_AI_JWT_PRIVATE_KEY=<PEM private key for RS256, optional when JWT_SECRET is available> \
CV_BENCHMARK_FIXTURES_DIR=/absolute/path/outside/this/repo/five-consented-cvs \
CV_BENCHMARK_PREMIUM_MODELS=openrouter/anthropic/claude-sonnet-4.6 \
CV_BENCHMARK_PREMIUM_HUMAN_APPROVED=true \
rtk npx ts-node src/applications/__evals__/benchmark-run.ts
```

- `CV_AI_SERVICE_URL` / `CV_AI_JWT_SECRET` — same contract as `run-eval.ts`: a reachable
  ai-microservice and its legacy HS256 secret. [`auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md`](../../auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md)
  requires an Auth-issued per-pair RS256 JWT and records no HS256 exception, so supply
  `CV_AI_JWT_PRIVATE_KEY` below rather than relying on this fallback.
- `CV_AI_JWT_PRIVATE_KEY` — RS256 signing key. When present, the benchmark client signs RS256
  tokens, which ai-microservice verifies against `JWT_PUBLIC_KEY` first.
- `CV_BENCHMARK_FIXTURES_DIR` — **required.** A directory containing exactly five fixture
  `*.json` files (format below). The loader (`benchmark-fixtures.ts`) refuses any other
  count — a partial run is not the measurement spec §8.2 asks for.
- `CV_BENCHMARK_PREMIUM_MODELS` — **optional.** Comma-separated model id(s) upstream will
  actually serve `premium` with (e.g. `openrouter/anthropic/claude-sonnet-4.6`, matching the LiteLLM route).
  Omit it and every `premium` run is recorded as `skipped`, not faked or silently dropped —
  "upstream supports it" is not something this script can discover on its own short of a
  live LiteLLM deployment probe, so it is configuration, not detection.
- `CV_BENCHMARK_PREMIUM_HUMAN_APPROVED` — must be exactly `true` for a premium request. Set it only for the explicitly approved run; the runner sends that approval on each premium call and never defaults it.
- `CV_BENCHMARK_TIERS` — optional override, comma-separated subset of `cheap,smart,premium`
  (default: all three).
- `CV_BENCHMARK_OUTPUT_DIR` — optional, default `./benchmark-output` (gitignored — see
  `.gitignore`). A timestamped `<ISO timestamp>.json` and `<ISO timestamp>.md` are written
  there on every run.

Refuses to run when `CI` is set, exactly like `run-eval.ts`. It is not collected by
`npm test` — it lives under `__evals__/` (jest's `testRegex` is `.*\.spec\.ts$`) and is not
named `*.spec.ts`.

## Required fixture format

One JSON file per CV, five files total, directly inside `CV_BENCHMARK_FIXTURES_DIR`. The
shape mirrors `FactSnapshot` (`src/applications/application.types.ts`) and
`TailorPromptInput` (`src/applications/tailor.prompt.ts`) — the same input
`TailorService`/`run-eval.ts` use — deliberately **not** raw CV markdown, so the benchmark
measures tailoring quality itself rather than also depending on a separate fact-extraction
call succeeding.

```jsonc
{
  // A label for reports — must NOT be the candidate's real name. Use a role-based or
  // pseudonymous label, e.g. "candidate-a" or "backend-senior-1".
  "label": "candidate-a",
  "facts": [
    {
      "factId": "f1",
      "text": "Senior Developer at <employer>, 2019-2024",
      "kind": "role",
      // section/title/org/period are optional; omit or set null if unknown.
      "section": "Experience",
      "title": "Senior Developer",
      "org": "<employer>",
      "period": "2019-2024"
    }
  ],
  "requirements": [{ "text": "PostgreSQL in production", "kind": "must" }],
  "jobTitle": "Backend Engineer",
  "company": "<target company or null>",
  "language": "en",           // optional, defaults to "en"
  "styleExemplars": []        // optional, defaults to []
}
```

Validation (`parseBenchmarkFixture` in `benchmark-fixtures.ts`) rejects, with the file name
in the error, a fixture missing `label`, an empty `facts` array, a fact missing `factId`/
`text`/`kind`, or a requirement whose `kind` is not `must`/`nice`. There are no bundled
example fixture files in this repository on purpose — a shipped example is one keystroke
away from being copy-pasted into "real" use, and the whole point of this format is that
real CV content never enters version control.

## Consent and privacy — read before running with real CVs

- **Consent is a precondition, not something this script checks.** Each of the five CVs
  used must have current, recorded consent to this specific processing from its owner —
  the same standard `ConsentService`/`ConsentGuard` enforce for the production upload path
  (`src/master/consent.service.ts`, `src/master/consent.guard.ts`, spec §9). This script
  calls ai-microservice directly and is **not** behind `ConsentGuard`, so that check must be
  done by the person assembling the fixture directory, before a fixture file is created.
- **Pseudonymization still applies.** `BenchmarkAiClientService` calls
  `pseudonymizePrompt` (`src/ai/pseudonymize.ts`) on every prompt before it crosses to
  ai-microservice, exactly like production `AiClientService` — direct identifiers (name,
  email, phone) are stripped before the model boundary. Fixture `facts[].text` should
  itself avoid embedding a name/email/phone in the bullet text where possible, since
  pseudonymization is a regex safety net, not a substitute for keeping fixtures minimal.
- **Sub-processors are the same as production.** OpenRouter/Google/Anthropic see
  pseudonymized content for whichever tier is under test; see
  `docs/privacy/subprocessors.md`. Running `premium` sends pseudonymized content to
  Anthropic, already listed there.
- **Never commit the output.** `CV_BENCHMARK_OUTPUT_DIR` (default `./benchmark-output`) is
  gitignored specifically because the JSON/Markdown reports contain tailored bullet TEXT
  derived from real CVs — unlike `docs/evals/2026-08-24-grounding-baseline.md`, whose
  fixtures are synthetic and safe to publish, a Phase 8 report is not. If a finding needs to
  be recorded for the Phase 9 decision, record the **aggregated, tier-level numbers only**
  (latency, aiTell average, unsupported count, token/cost totals) in a new dated doc under
  `docs/evals/`, never the per-run detail table or any fixture content.
- **Retention.** Once the Phase 9 decision is made, delete the fixture directory and any
  local benchmark-output files; they are working data for a one-time measurement, not an
  artifact this service is designed to retain (contrast with `cv_render`, which the
  production retention job at `POST /api/privacy/retention` manages deliberately).

## What this PR does and does not do

This PR prepares the benchmark **infrastructure**: the tier-aware client, the fixture
loader/validator, the aggregation/report code, and this document. It does **not**:

- fabricate or bundle any CV data, real or synthetic-as-a-stand-in-for-real;
- call ai-microservice or any model provider;
- change `AiTier`, `AiClientService`, `TailorService`, or `EntailService` in any way;
- record a benchmark result — none has been run.

**To actually execute the benchmark, a future run needs:**

1. Five real CVs, each with current, recorded consent for this exact processing.
2. Each converted by hand into the fixture JSON format above and placed in a directory
   outside this repository (or in a path covered by `.gitignore` if kept locally).
3. Network access to a running ai-microservice and its `CV_AI_JWT_SECRET`.
4. To compare `premium`, an ai-microservice/LiteLLM deployment that actually serves it plus
   `CV_BENCHMARK_PREMIUM_MODELS` set to that model id — without it, `premium` rows report
   `skipped`, and only `cheap`/`smart` are compared.
