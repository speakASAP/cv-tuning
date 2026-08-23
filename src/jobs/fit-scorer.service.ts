import { Injectable, Logger } from '@nestjs/common';
import { AiClientService } from '../ai/ai-client.service';
import { CvFactEntity } from '../master/entities/cv-fact.entity';
import { Requirement } from './job.types';

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

export type Verdict = 'met' | 'partial' | 'missing';

export interface RequirementMatch {
  requirement: Requirement;
  /** Stable cross-version cv_fact.factId values, never row ids. Validated, never trusted. */
  factIds: string[];
  verdict: Verdict;
  evidence: string | null;
}

export interface FitReport {
  score: number;
  matches: RequirementMatch[];
  gaps: RequirementMatch[];
}

/** An unmet "must" should dominate the score; an unmet "nice" should barely dent it. */
const WEIGHTS: Record<Requirement['kind'], number> = { must: 3, nice: 1 };
const CREDIT: Record<Verdict, number> = { met: 1, partial: 0.5, missing: 0 };

const SYSTEM_PROMPT = [
  'You assess how well a candidate\'s CV facts satisfy each requirement of a job posting.',
  'For every requirement return a verdict: "met" when the facts clearly demonstrate it,',
  '"partial" when they show adjacent or partial experience, "missing" when they do not show it.',
  'Cite the factId of every fact you relied on. Never cite a factId that was not given to you.',
  'Never treat a requirement as met without citing at least one fact.',
  'Judge only what the facts state. Do not assume unstated experience.',
].join(' ');

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['assessments'],
  properties: {
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['requirement', 'verdict', 'factIds'],
        properties: {
          requirement: { type: 'string' },
          verdict: { type: 'string', enum: ['met', 'partial', 'missing'] },
          factIds: { type: 'array', items: { type: 'string' } },
          evidence: { type: ['string', 'null'] },
        },
      },
    },
  },
};

interface RawAssessment {
  requirement?: unknown;
  verdict?: unknown;
  factIds?: unknown;
  evidence?: unknown;
}

@Injectable()
export class FitScorerService {
  private readonly logger = new Logger(FitScorerService.name);

  constructor(private readonly ai: AiClientService) {}

  async score(requirements: Requirement[], facts: CvFactEntity[]): Promise<FitReport> {
    if (requirements.length === 0) {
      // Nothing to fail against. Calling the model here would spend tokens to learn nothing.
      return { score: 100, matches: [], gaps: [] };
    }

    const completion = await this.ai.complete({
      tier: 'smart',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: this.buildPrompt(requirements, facts),
      outputSchema: OUTPUT_SCHEMA,
    });

    if (completion.degraded) {
      throw new Error(
        `fit scoring ran on a degraded model (${completion.modelUsed}); refusing to report the result`,
      );
    }

    const assessments = this.parseAssessments(completion.text);
    const knownFactIds = new Set(facts.map((fact) => fact.factId));
    const byRequirement = new Map<string, RawAssessment>();
    for (const raw of assessments) {
      if (typeof raw.requirement === 'string') {
        byRequirement.set(raw.requirement.trim().toLowerCase(), raw);
      }
    }

    const evaluated = requirements.map((requirement) =>
      this.toMatch(requirement, byRequirement.get(requirement.text.trim().toLowerCase()), knownFactIds),
    );

    return {
      score: this.weightedScore(evaluated),
      matches: evaluated.filter((m) => m.verdict !== 'missing'),
      gaps: evaluated.filter((m) => m.verdict === 'missing'),
    };
  }

  private toMatch(
    requirement: Requirement,
    raw: RawAssessment | undefined,
    knownFactIds: Set<string>,
  ): RequirementMatch {
    if (!raw) {
      // A requirement the model skipped is not evidence of a match. Dropping it would
      // silently inflate the score.
      this.logger.warn(`model returned no assessment for requirement "${requirement.text}"; treating as missing`);
      return { requirement, factIds: [], verdict: 'missing', evidence: null };
    }

    const citedIds = Array.isArray(raw.factIds) ? raw.factIds.filter((id): id is string => typeof id === 'string') : [];
    const validIds = citedIds.filter((id) => knownFactIds.has(id));

    if (validIds.length !== citedIds.length) {
      const invented = citedIds.filter((id) => !knownFactIds.has(id));
      this.logger.error(
        `model cited unknown factIds ${JSON.stringify(invented)} for "${requirement.text}"; dropping them`,
      );
    }

    let verdict: Verdict =
      raw.verdict === 'met' || raw.verdict === 'partial' || raw.verdict === 'missing' ? raw.verdict : 'missing';

    // A claim resting only on invented citations is not a claim at all.
    if (verdict !== 'missing' && validIds.length === 0) {
      this.logger.error(`"${requirement.text}" was marked ${verdict} with no valid citation; downgrading to missing`);
      verdict = 'missing';
    }

    return {
      requirement,
      factIds: validIds,
      verdict,
      evidence: typeof raw.evidence === 'string' && raw.evidence.trim() ? raw.evidence.trim() : null,
    };
  }

  private weightedScore(matches: RequirementMatch[]): number {
    const total = matches.reduce((sum, m) => sum + WEIGHTS[m.requirement.kind], 0);
    if (total === 0) return 100;

    const earned = matches.reduce((sum, m) => sum + WEIGHTS[m.requirement.kind] * CREDIT[m.verdict], 0);
    return Math.round((earned / total) * 100);
  }

  private buildPrompt(requirements: Requirement[], facts: CvFactEntity[]): string {
    const factLines = facts.length
      ? facts.map((f) => `- [${f.factId}] ${f.text}`).join('\n')
      : '(the candidate has no recorded facts)';
    const requirementLines = requirements.map((r) => `- (${r.kind}) ${r.text}`).join('\n');

    return `CV facts:\n${factLines}\n\nJob requirements:\n${requirementLines}`;
  }

  private parseAssessments(text: string): RawAssessment[] {
    const unfenced = FENCE.exec(text)?.[1] ?? text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(unfenced);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`failed to parse fit assessment: ${message}; body=${text.slice(0, 300)}`);
      throw new Error(`could not parse fit assessment: ${message}`);
    }

    const assessments = (parsed as { assessments?: unknown }).assessments;
    if (!Array.isArray(assessments)) {
      throw new Error('model response has no assessments array');
    }

    return assessments as RawAssessment[];
  }
}
