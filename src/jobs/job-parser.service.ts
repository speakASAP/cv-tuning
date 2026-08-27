import { Injectable, Logger } from '@nestjs/common';
import { AiClientService } from '../ai/ai-client.service';
import { ParsedRequirements, REQUIREMENT_KINDS, Requirement, isRequirementKind } from './job.types';

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

export const SYSTEM_PROMPT = [
  'You extract hiring requirements from a job posting.',
  'Extract only requirements the posting actually states. Never infer or invent one.',
  'Classify each as "must" when the posting presents it as required, or "nice" when it is',
  'presented as preferred, bonus, or optional. When the wording is ambiguous, use "nice".',
  'Detect the language of the posting and return it as an ISO 639-1 code.',
  'Keep each requirement short and specific, in the posting\'s own words where possible.',
  'Also return screeningQuestions: questions the posting EXPLICITLY asks the applicant to',
  'answer, in the posting\'s own wording. Return an empty array if it asks none — most',
  'postings ask none, and that is the expected answer, not a failure to find any. Never turn a',
  'requirement into a question, and never write a question the posting does not ask.',
].join(' ');

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['requirements'],
  properties: {
    title: { type: ['string', 'null'] },
    company: { type: ['string', 'null'] },
    language: { type: 'string' },
    screeningQuestions: { type: 'array', items: { type: 'string' } },
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'kind'],
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: [...REQUIREMENT_KINDS] },
          category: { type: 'string' },
        },
      },
    },
  },
};

interface RawRequirement {
  text?: unknown;
  kind?: unknown;
  category?: unknown;
}

@Injectable()
export class JobParserService {
  private readonly logger = new Logger(JobParserService.name);

  constructor(private readonly ai: AiClientService) {}

  async parse(text: string): Promise<ParsedRequirements> {
    if (text.trim().length === 0) {
      throw new Error('cannot parse an empty job posting');
    }

    const completion = await this.ai.complete({
      tier: 'cheap',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `Extract the requirements from this job posting:\n\n${text}`,
      outputSchema: OUTPUT_SCHEMA,
    });

    if (completion.degraded) {
      // Every later stage treats these requirements as ground truth for scoring and
      // tailoring, so requirements of unknown quality must not be persisted.
      throw new Error(
        `job parsing ran on a degraded model (${completion.modelUsed}); refusing to persist the result`,
      );
    }

    const parsed = this.parseJson(completion.text);
    const rawRequirements = (parsed as { requirements?: unknown }).requirements;

    if (!Array.isArray(rawRequirements)) {
      throw new Error('model response has no requirements array');
    }

    const payload = parsed as Record<string, unknown>;
    return {
      title: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : null,
      company: typeof payload.company === 'string' && payload.company.trim() ? payload.company.trim() : null,
      language: typeof payload.language === 'string' && payload.language.trim() ? payload.language.trim() : 'en',
      requirements: rawRequirements.map((raw, index) => this.toRequirement(raw as RawRequirement, index)),
      screeningQuestions: this.toScreeningQuestions(payload.screeningQuestions),
    };
  }

  /**
   * A posting that asks no screening questions is the common case, so a missing or malformed
   * field yields an empty list rather than raising — unlike `requirements`, nothing downstream
   * treats an empty question list as a failure, and there is no ambiguity to preserve: the
   * user's own pasted questions are merged in separately either way.
   */
  private toScreeningQuestions(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((q): q is string => typeof q === 'string')
      .map((q) => q.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  private parseJson(text: string): unknown {
    const unfenced = FENCE.exec(text)?.[1] ?? text;
    try {
      return JSON.parse(unfenced);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`failed to parse job requirements: ${message}; body=${text.slice(0, 300)}`);
      // Distinct from "no requirements stated": we do not know what the posting asks for.
      throw new Error(`could not parse job requirements: ${message}`);
    }
  }

  private toRequirement(raw: RawRequirement, index: number): Requirement {
    if (!isRequirementKind(raw.kind)) {
      throw new Error(`requirement at index ${index} has unrecognised kind: ${String(raw.kind)}`);
    }

    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (text.length === 0) {
      throw new Error(`requirement at index ${index} has no text`);
    }

    return {
      text,
      kind: raw.kind,
      category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'general',
    };
  }
}
