import { Injectable, Logger } from '@nestjs/common';
import { AiClientService } from '../ai/ai-client.service';
import { ExtractedFact } from './fact-identity';
import { FACT_KINDS, isFactKind } from './master.types';

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

const SYSTEM_PROMPT = [
  'You extract structured facts from a CV written in Markdown.',
  'Extract only what the text actually states. Never infer, embellish, or add a fact that is not written.',
  'If the CV does not state a metric, the metric is null — do not invent one.',
  `Every fact must have one of these kinds: ${FACT_KINDS.join(', ')}.`,
  'A "proof" fact is a portfolio link, repository, case study, or work sample.',
  'Preserve the candidate\'s own wording in the text field; do not rewrite it.',
].join(' ');

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'text'],
        properties: {
          kind: { type: 'string', enum: [...FACT_KINDS] },
          text: { type: 'string' },
          payload: { type: 'object' },
          metric: { type: ['string', 'null'] },
        },
      },
    },
  },
};

interface RawFact {
  kind?: unknown;
  text?: unknown;
  payload?: unknown;
  metric?: unknown;
}

@Injectable()
export class FactExtractorService {
  private readonly logger = new Logger(FactExtractorService.name);

  constructor(private readonly ai: AiClientService) {}

  async extract(markdown: string): Promise<ExtractedFact[]> {
    if (markdown.trim().length === 0) {
      throw new Error('cannot extract facts from empty markdown');
    }

    const completion = await this.ai.complete({
      tier: 'cheap',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `Extract every fact from this CV:\n\n${markdown}`,
      outputSchema: OUTPUT_SCHEMA,
    });

    if (completion.degraded) {
      // A downgraded model silently produces a worse fact graph, and every later stage
      // trusts it as ground truth. Refuse rather than persist facts of unknown quality.
      throw new Error(
        `fact extraction ran on a degraded model (${completion.modelUsed}); refusing to persist the result`,
      );
    }

    const parsed = this.parse(completion.text);
    const rawFacts = (parsed as { facts?: unknown }).facts;

    if (!Array.isArray(rawFacts)) {
      throw new Error('model response has no facts array');
    }

    return rawFacts.map((raw, index) => this.toFact(raw as RawFact, index));
  }

  private parse(text: string): unknown {
    const unfenced = FENCE.exec(text)?.[1] ?? text;
    try {
      return JSON.parse(unfenced);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`failed to parse fact extraction output: ${message}; body=${text.slice(0, 300)}`);
      // Distinct from "no facts found": a parse failure means we do not know what the CV says.
      throw new Error(`could not parse fact extraction output: ${message}`);
    }
  }

  private toFact(raw: RawFact, index: number): ExtractedFact {
    if (!isFactKind(raw.kind)) {
      throw new Error(`fact at index ${index} has unrecognised kind: ${String(raw.kind)}`);
    }

    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (text.length === 0) {
      throw new Error(`fact at index ${index} has no text`);
    }

    return {
      kind: raw.kind,
      text,
      payload: this.isRecord(raw.payload) ? raw.payload : {},
      metric: typeof raw.metric === 'string' && raw.metric.trim().length > 0 ? raw.metric.trim() : null,
      position: index,
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
