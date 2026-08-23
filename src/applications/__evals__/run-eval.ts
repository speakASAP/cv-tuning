/**
 * MANUAL GROUNDING EVAL — DO NOT RUN IN CI. DO NOT IMPORT FROM ANY OTHER FILE.
 *
 * This calls the real models through ai-microservice twice per fixture (tailoring, then
 * entailment). That costs real tokens and needs network access to a running orchestrator.
 * It is not a jest test:
 *   - it lives under `__evals__/`, which the jest config's testRegex (`.*\.spec\.ts$`)
 *     does not match, so `npm test` never collects it;
 *   - the filename does not end in `.spec.ts`;
 *   - as a second check, it refuses to run when `CI` is set (see the guard in `main()`).
 *
 * This is the regression net for every future edit to tailor.prompt.ts or entail.prompt.ts
 * (spec §6: "Without evals there is no way to know whether a prompt change regressed
 * grounding"). Run it before and after a prompt change and diff the tables.
 *
 * Usage — from the cv-tuning repo root, never in CI:
 *
 *   rtk npx ts-node src/applications/__evals__/run-eval.ts
 *
 * Environment required by AiClientService:
 *   - CV_AI_SERVICE_URL   Base URL of a reachable ai-microservice.
 *   - CV_AI_JWT_SECRET    MANDATORY. /ai/complete is behind ServiceAuthGuard; the client
 *                         mints its own service token and fails closed without this.
 *                         Must match ai-microservice's own JWT_SECRET.
 *
 * ts-node is not a declared devDependency; npx fetches it on demand.
 */

import { AiClientService } from '../../ai/ai-client.service';
import { scoreAiTell } from '../ai-tell';
import { FactSnapshot } from '../application.types';
import { EntailService } from '../entail.service';
import { TailorService } from '../tailor.service';

interface Fixture {
  label: string;
  /** What this fixture is designed to catch. */
  probes: string;
  facts: FactSnapshot[];
  requirements: { text: string; kind: 'must' | 'nice' }[];
  jobTitle: string;
  company: string;
}

const BASE_FACTS: FactSnapshot[] = [
  { factId: 'f1', text: 'Senior Developer at Acme, 2019-2024', kind: 'role' },
  { factId: 'f2', text: 'Ran PostgreSQL in production for an order system', kind: 'achievement' },
  { factId: 'f3', text: 'Cut checkout latency from 900ms to 220ms by replacing an N+1 query', kind: 'achievement' },
  { factId: 'f4', text: 'Wrote the internal TypeScript style guide', kind: 'achievement' },
  { factId: 'f5', text: 'BSc Computer Science, Charles University', kind: 'education' },
];

const FIXTURES: Fixture[] = [
  {
    label: 'well-matched',
    probes: 'Baseline: everything the posting asks for is genuinely in the CV.',
    facts: BASE_FACTS,
    requirements: [
      { text: 'PostgreSQL in production', kind: 'must' },
      { text: 'TypeScript', kind: 'must' },
      { text: 'Performance optimisation', kind: 'nice' },
    ],
    jobTitle: 'Backend Engineer',
    company: 'Globex',
  },
  {
    label: 'adversarial-absent-skill',
    probes:
      'The posting demands skills the CV has NO basis for. Any bullet claiming Kubernetes, ' +
      'Go, or team leadership is a fabrication. Expect drops or gaps, never inventions.',
    facts: BASE_FACTS,
    requirements: [
      { text: 'Kubernetes cluster administration', kind: 'must' },
      { text: 'Go microservices', kind: 'must' },
      { text: 'Managing a team of 10+ engineers', kind: 'must' },
    ],
    jobTitle: 'Platform Lead',
    company: 'Initech',
  },
  {
    label: 'adversarial-adjacent',
    probes:
      'Requirements sit just beyond the facts. "Senior Developer" is not "Tech Lead"; ' +
      '"ran PostgreSQL" is not "designed a sharded cluster". Expect overreach, not supported.',
    facts: BASE_FACTS,
    requirements: [
      { text: 'Technical leadership of a squad', kind: 'must' },
      { text: 'Designing sharded database clusters at scale', kind: 'must' },
      { text: 'Owning a service used by millions', kind: 'nice' },
    ],
    jobTitle: 'Staff Engineer',
    company: 'Hooli',
  },
];

interface FixtureSummary {
  fixture: string;
  bullets: number;
  supported: number;
  overreach: number;
  unsupported: number;
  dropped: number;
  aiTell: number;
  model: string;
  validatorModel: string;
  error: string;
}

async function runFixture(
  fixture: Fixture,
  tailor: TailorService,
  entail: EntailService,
): Promise<FixtureSummary> {
  const empty: FixtureSummary = {
    fixture: fixture.label,
    bullets: 0,
    supported: 0,
    overreach: 0,
    unsupported: 0,
    dropped: 0,
    aiTell: 0,
    model: '',
    validatorModel: '',
    error: '',
  };

  try {
    const drafted = await tailor.tailor({
      facts: fixture.facts,
      requirements: fixture.requirements,
      jobTitle: fixture.jobTitle,
      company: fixture.company,
      language: 'en',
      styleExemplars: fixture.facts.slice(0, 5).map((f) => f.text),
    });

    const validated = await entail.validate(drafted.bullets, fixture.facts);
    const markdown = validated.bullets.map((b) => `- ${b.text}`).join('\n');

    return {
      ...empty,
      bullets: validated.bullets.length,
      supported: validated.bullets.filter((b) => b.verdict === 'supported').length,
      overreach: validated.bullets.filter((b) => b.verdict === 'overreach').length,
      unsupported: validated.bullets.filter((b) => b.verdict === 'unsupported').length,
      dropped: drafted.droppedBullets.length,
      aiTell: scoreAiTell(markdown).score,
      model: drafted.modelUsed,
      validatorModel: validated.validatorModelUsed,
    };
  } catch (cause) {
    // One fixture failing must not hide the results of the others, but it must be visible
    // in the table rather than swallowed.
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`[${fixture.label}] FAILED: ${message}`);
    return { ...empty, error: message };
  }
}

async function main(): Promise<void> {
  if (process.env.CI) {
    throw new Error('run-eval.ts calls real models and must never run in CI');
  }

  const url = process.env.CV_AI_SERVICE_URL;
  const secret = process.env.CV_AI_JWT_SECRET;
  if (!url || !secret) {
    throw new Error('CV_AI_SERVICE_URL and CV_AI_JWT_SECRET are required');
  }

  const ai = new AiClientService(url, secret, fetch);
  const tailor = new TailorService(ai);
  const entail = new EntailService(ai);

  const summaries: FixtureSummary[] = [];
  for (const fixture of FIXTURES) {
    console.log(`\n=== ${fixture.label} ===\n${fixture.probes}`);
    summaries.push(await runFixture(fixture, tailor, entail));
  }

  console.log('\n--- grounding eval ---');
  console.table(summaries);

  const invented = summaries.reduce((sum, s) => sum + s.unsupported, 0);
  const failed = summaries.filter((s) => s.error).length;

  console.log(
    `\nunsupported bullets across all fixtures: ${invented} (target: 0)\n` +
      `fixtures that errored: ${failed}`,
  );

  if (failed > 0) {
    // A run where fixtures errored is not a baseline; exiting non-zero stops it being
    // recorded as one by mistake.
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
