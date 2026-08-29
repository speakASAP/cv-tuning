/**
 * PHASE 8 TIER BENCHMARK — DO NOT RUN IN CI. DO NOT IMPORT FROM ANY OTHER FILE.
 *
 * Spec §8.2: "run the same tailoring prompt across `cheap`, `smart`, and `premium` on five
 * real CVs, scoring AI-tells, factual grounding ... and €/application. Its output decides
 * Phase 9 (premium yes/no) and feeds Phase 10 pricing." This is that harness.
 *
 * It is intentionally separate from `run-eval.ts` (the grounding regression net) rather than
 * an extension of it: `run-eval.ts` always runs the CURRENT production path — whatever tier
 * `TailorService`/`EntailService` hardcode — against small synthetic fixtures committed to
 * the repo, and its job is "did a prompt edit regress grounding". This harness instead
 * measures THIS phase's specific, one-time question — cheap vs. smart vs. premium — against
 * five real, external, consented CVs that must never be committed. Folding tier-switching
 * into `run-eval.ts` or into `TailorService`/`EntailService` themselves would either weaken
 * the production `AiTier` type (see `benchmark-client.ts`'s header) or make the regression
 * net's synthetic fixtures do double duty as a cost/quality benchmark, which they were never
 * sized or worded for.
 *
 * Like `run-eval.ts`, this calls real models through ai-microservice and costs real tokens.
 * It never runs in CI: it is not `*.spec.ts` (jest's testRegex won't collect it) and it
 * refuses outright when `CI` is set.
 *
 * REQUIRED before running (see docs/evals/2026-08-28-phase-8-benchmark.md for the full
 * fixture format, consent, and privacy requirements):
 *   - Exactly five fixture JSON files in CV_BENCHMARK_FIXTURES_DIR, each derived from a real
 *     CV whose owner has given current, recorded consent to this specific processing.
 *   - CV_AI_SERVICE_URL plus either CV_AI_JWT_SECRET or CV_AI_JWT_PRIVATE_KEY, same
 *     contract as run-eval.ts. The AI service validates RS256 tokens against JWT_PUBLIC_KEY
 *     when it is configured and falls back to HS256 only when ALLOW_HS256_FALLBACK is open.
 *   - CV_BENCHMARK_PREMIUM_MODELS (optional): comma-separated model id(s) upstream will
 *     actually serve `premium` with. Omit it and premium is skipped, not faked.
 *
 * Usage — from the cv-tuning repo root, never in CI:
 *
 *   rtk npx ts-node src/applications/__evals__/benchmark-run.ts
 *
 * Output: a JSON file and a Markdown file are written under CV_BENCHMARK_OUTPUT_DIR
 * (default `./benchmark-output`, gitignored — see .gitignore). Both contain tailored bullet
 * TEXT derived from real CVs and must never be committed, attached to an issue, or pasted
 * anywhere outside the consent boundary those five CVs were given under.
 */
import { scoreAiTell } from '../ai-tell';
import { FactSnapshot } from '../application.types';
import { buildEntailPrompt, ENTAIL_OUTPUT_SCHEMA, ENTAIL_SYSTEM_PROMPT } from '../entail.prompt';
import { buildTailorPrompt, TAILOR_OUTPUT_SCHEMA, TAILOR_SYSTEM_PROMPT } from '../tailor.prompt';
import { BenchmarkAiClientService, BenchmarkTier, PremiumNotConfiguredError } from './benchmark-client';
import {
  BenchmarkRunResult,
  buildReport,
  formatReportJson,
  formatReportMarkdown,
} from './benchmark-aggregate';
import { BenchmarkFixture, loadBenchmarkFixtures } from './benchmark-fixtures';

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

function parseJsonBody(text: string, what: string): unknown {
  const unfenced = FENCE.exec(text)?.[1] ?? text;
  try {
    return JSON.parse(unfenced);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not parse ${what} response: ${message}; body=${text.slice(0, 300)}`);
  }
}

interface DraftBullet {
  text: string;
  sourceFactId: string;
}

/**
 * Deliberately mirrors `TailorService.parseBullets` + its dedup/source-validation loop
 * (`tailor.service.ts`) so all three tiers are held to the exact same grounding rule the
 * production tailoring path enforces: one bullet per known, unused source fact. Kept as a
 * separate copy rather than an import because `TailorService` hardcodes `tier: 'smart'`
 * internally (spec §8: tailoring is `smart`-only in phases 1–6) — reusing it here would
 * mean either changing that hardcoding (weakening the one place production pins the tier)
 * or calling private methods across a class boundary. If this drop/dedup logic changes in
 * `tailor.service.ts`, mirror the change here too.
 */
function parseTailorBullets(text: string, facts: FactSnapshot[]): { bullets: DraftBullet[]; dropped: number } {
  const parsed = parseJsonBody(text, 'tailoring');
  const raw = (parsed as { bullets?: unknown }).bullets;
  if (!Array.isArray(raw)) throw new Error('tailoring response has no bullets array');

  const knownFactIds = new Set(facts.map((f) => f.factId));
  const usedFactIds = new Set<string>();
  const bullets: DraftBullet[] = [];
  let dropped = 0;

  for (const candidate of raw as { text?: unknown; sourceFactId?: unknown }[]) {
    const bulletText = typeof candidate.text === 'string' ? candidate.text.trim() : '';
    const sourceFactId = typeof candidate.sourceFactId === 'string' ? candidate.sourceFactId.trim() : '';

    if (!bulletText || !sourceFactId || !knownFactIds.has(sourceFactId) || usedFactIds.has(sourceFactId)) {
      dropped += 1;
      continue;
    }

    usedFactIds.add(sourceFactId);
    bullets.push({ text: bulletText, sourceFactId });
  }

  return { bullets, dropped };
}

type Verdict = 'supported' | 'overreach' | 'unsupported';

/** Mirrors `EntailService`'s result parsing and the fail-closed "unsupported if the
 * validator skipped a bullet" rule (`entail.service.ts#toValidated`) for the same reason
 * `parseTailorBullets` mirrors `TailorService`. */
function parseEntailVerdicts(text: string, bulletCount: number): Verdict[] {
  const parsed = parseJsonBody(text, 'entailment');
  const raw = (parsed as { results?: unknown }).results;
  if (!Array.isArray(raw)) throw new Error('entailment response has no results array');

  const byRef = new Map<number, unknown>();
  for (const result of raw as { bulletRef?: unknown; verdict?: unknown }[]) {
    if (typeof result.bulletRef === 'number' && result.bulletRef >= 0 && result.bulletRef < bulletCount) {
      byRef.set(result.bulletRef, result.verdict);
    }
  }

  return Array.from({ length: bulletCount }, (_, index) => {
    const verdict = byRef.get(index);
    return verdict === 'supported' || verdict === 'overreach' || verdict === 'unsupported' ? verdict : 'unsupported';
  });
}

async function runFixtureOnTier(
  fixture: BenchmarkFixture,
  tier: BenchmarkTier,
  ai: BenchmarkAiClientService,
): Promise<BenchmarkRunResult> {
  const empty: BenchmarkRunResult = {
    fixture: fixture.label,
    tier,
    model: '',
    degraded: false,
    tailorLatencyMs: 0,
    entailLatencyMs: 0,
    totalLatencyMs: 0,
    bullets: 0,
    supported: 0,
    overreach: 0,
    unsupported: 0,
    dropped: 0,
    aiTell: 0,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    costUsd: null,
    error: '',
    skipped: false,
  };

  if (!ai.supportsTier(tier)) {
    return { ...empty, error: 'premium not configured (CV_BENCHMARK_PREMIUM_MODELS unset)', skipped: true };
  }

  try {
    const tailorCompletion = await ai.complete({
      tier,
      systemPrompt: TAILOR_SYSTEM_PROMPT,
      userPrompt: buildTailorPrompt({
        facts: fixture.facts,
        requirements: fixture.requirements,
        jobTitle: fixture.jobTitle,
        company: fixture.company,
        language: fixture.language,
        styleExemplars: fixture.styleExemplars,
      }),
      outputSchema: TAILOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });

    if (tailorCompletion.degraded) {
      return {
        ...empty,
        model: tailorCompletion.modelUsed,
        degraded: true,
        tailorLatencyMs: tailorCompletion.latencyMs,
        totalLatencyMs: tailorCompletion.latencyMs,
        error: `tailoring ran on a degraded model (${tailorCompletion.modelUsed})`,
      };
    }

    const { bullets, dropped } = parseTailorBullets(tailorCompletion.text, fixture.facts);

    if (bullets.length === 0) {
      return {
        ...empty,
        model: tailorCompletion.modelUsed,
        dropped,
        tailorLatencyMs: tailorCompletion.latencyMs,
        totalLatencyMs: tailorCompletion.latencyMs,
      };
    }

    const factsById = new Map(fixture.facts.map((f) => [f.factId, f]));
    const entailCompletion = await ai.complete({
      tier,
      systemPrompt: ENTAIL_SYSTEM_PROMPT,
      userPrompt: buildEntailPrompt(
        bullets.map((b) => ({ text: b.text, sourceFactText: factsById.get(b.sourceFactId)?.text ?? '' })),
      ),
      outputSchema: ENTAIL_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });

    const totalLatencyMs = tailorCompletion.latencyMs + entailCompletion.latencyMs;

    if (entailCompletion.degraded) {
      return {
        ...empty,
        model: tailorCompletion.modelUsed,
        tailorLatencyMs: tailorCompletion.latencyMs,
        entailLatencyMs: entailCompletion.latencyMs,
        totalLatencyMs,
        error: `entailment ran on a degraded model (${entailCompletion.modelUsed})`,
      };
    }

    const verdicts = parseEntailVerdicts(entailCompletion.text, bullets.length);
    const markdown = bullets.map((b) => `- ${b.text}`).join('\n');

    const sumNullable = (a: number | null, b: number | null): number | null =>
      a === null && b === null ? null : (a ?? 0) + (b ?? 0);

    return {
      ...empty,
      model: tailorCompletion.modelUsed,
      tailorLatencyMs: tailorCompletion.latencyMs,
      entailLatencyMs: entailCompletion.latencyMs,
      totalLatencyMs,
      bullets: bullets.length,
      supported: verdicts.filter((v) => v === 'supported').length,
      overreach: verdicts.filter((v) => v === 'overreach').length,
      unsupported: verdicts.filter((v) => v === 'unsupported').length,
      dropped,
      aiTell: scoreAiTell(markdown).score,
      promptTokens: sumNullable(tailorCompletion.promptTokens, entailCompletion.promptTokens),
      completionTokens: sumNullable(tailorCompletion.completionTokens, entailCompletion.completionTokens),
      totalTokens: sumNullable(tailorCompletion.totalTokens, entailCompletion.totalTokens),
      costUsd: sumNullable(tailorCompletion.costUsd, entailCompletion.costUsd),
    };
  } catch (cause) {
    if (cause instanceof PremiumNotConfiguredError) {
      return { ...empty, error: cause.message, skipped: true };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`[${fixture.label}:${tier}] FAILED: ${message}`);
    return { ...empty, error: message };
  }
}

function parseTierList(raw: string | undefined): BenchmarkTier[] {
  if (!raw || !raw.trim()) return ['cheap', 'smart', 'premium'];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is BenchmarkTier => s === 'cheap' || s === 'smart' || s === 'premium');
}

async function main(): Promise<void> {
  if (process.env.CI) {
    throw new Error('benchmark-run.ts calls real models and must never run in CI');
  }

  const url = process.env.CV_AI_SERVICE_URL;
  const secret = process.env.CV_AI_JWT_SECRET;
  const privateKey = process.env.CV_AI_JWT_PRIVATE_KEY ?? process.env.JWT_PRIVATE_KEY;
  const fixturesDir = process.env.CV_BENCHMARK_FIXTURES_DIR;
  if (!url || (!secret && !privateKey) || !fixturesDir) {
    throw new Error(
      'CV_AI_SERVICE_URL, one of CV_AI_JWT_SECRET or CV_AI_JWT_PRIVATE_KEY, and CV_BENCHMARK_FIXTURES_DIR are all required; ' +
        'see docs/evals/2026-08-28-phase-8-benchmark.md',
    );
  }

  const premiumModels = (process.env.CV_BENCHMARK_PREMIUM_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const tiers = parseTierList(process.env.CV_BENCHMARK_TIERS);
  const outputDir = process.env.CV_BENCHMARK_OUTPUT_DIR ?? './benchmark-output';

  const fixtures = loadBenchmarkFixtures(fixturesDir);
  const ai = new BenchmarkAiClientService({
    aiServiceUrl: url,
    jwtSecret: secret,
    jwtPrivateKey: privateKey,
    premiumModels,
  });

  const results: BenchmarkRunResult[] = [];
  for (const fixture of fixtures) {
    for (const tier of tiers) {
      console.log(`\n=== ${fixture.label} :: ${tier} ===`);
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose: rate limits and
      // per-tier LiteLLM timeouts are tuned around one in-flight CV call at a time (see the
      // 2026-08-24 baseline doc); parallelising would invalidate the latency comparison anyway.
      results.push(await runFixtureOnTier(fixture, tier, ai));
    }
  }

  const report = buildReport(results, fixtures.length);

  console.log('\n--- Phase 8 tier benchmark: per-tier summary ---');
  console.table(report.aggregates);

  const fs = await import('fs');
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = `${outputDir}/${stamp}.json`;
  const mdPath = `${outputDir}/${stamp}.md`;
  fs.writeFileSync(jsonPath, formatReportJson(report));
  fs.writeFileSync(mdPath, formatReportMarkdown(report));

  console.log(`\nWrote ${jsonPath} and ${mdPath}.`);
  console.log(
    'These files contain tailored bullet text derived from real, consented CVs. Do not ' +
      'commit them, attach them to an issue, or move them outside the consent boundary those ' +
      'CVs were given under (docs/evals/2026-08-28-phase-8-benchmark.md).',
  );

  const failed = results.filter((r) => r.error && !r.skipped).length;
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
