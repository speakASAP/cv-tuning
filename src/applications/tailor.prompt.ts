import { AI_TELL_PHRASES } from './ai-tell';

/**
 * Bumped on every prompt change and persisted on each render, so a later eval run can
 * attribute a grounding regression to the exact prompt that caused it.
 */
export const TAILOR_PROMPT_VERSION = 'tailor-v1';

export const TAILOR_SYSTEM_PROMPT = [
  'You rewrite a candidate\'s existing CV bullets so they speak to a specific job posting.',
  '',
  'Hard rules, in order of importance:',
  '1. Every bullet you output MUST be a rewrite of exactly ONE input bullet. Return that',
  '   bullet\'s factId as sourceFactId. Never merge two facts into one bullet.',
  '2. Never introduce a number, percentage, duration, team size, job title, employer, or',
  '   technology that is not already present in the source fact. If the posting wants',
  '   something the candidate has not done, leave it out. A gap is honest; an invention is',
  '   not.',
  '3. You may reorder, re-emphasise, cut, and rephrase. You may make an existing',
  '   achievement demonstrate a required skill. You may not add a new achievement.',
  '4. Omit a fact entirely rather than stretch it. Fewer, truthful bullets beat more.',
  '',
  'Voice:',
  '- Write in the candidate\'s own register, using the style exemplars given.',
  '- Lead with the concrete outcome, not the activity.',
  '- Demonstrate a required skill through what was done; do not repeat the skill noun.',
  `- Never use these words or phrases: ${AI_TELL_PHRASES.join(', ')}.`,
].join('\n');

export const TAILOR_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['bullets'],
  properties: {
    bullets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'sourceFactId'],
        properties: {
          text: { type: 'string', minLength: 1 },
          // Singular by schema, not only by instruction: an array here would invite the
          // model to merge facts, which is exactly what the source constraint forbids.
          sourceFactId: { type: 'string', minLength: 1 },
          targetRequirement: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

export interface TailorPromptInput {
  facts: { factId: string; text: string; kind: string }[];
  requirements: { text: string; kind: 'must' | 'nice' }[];
  jobTitle: string | null;
  company: string | null;
  language: string;
  /** The user's own sentences, carried in so the output keeps their voice (§6.1). */
  styleExemplars: string[];
}

export function buildTailorPrompt(input: TailorPromptInput): string {
  const facts = input.facts.map((f) => `- [${f.factId}] (${f.kind}) ${f.text}`).join('\n');
  const requirements = input.requirements.map((r) => `- (${r.kind}) ${r.text}`).join('\n');
  const exemplars = input.styleExemplars.length
    ? input.styleExemplars.map((s) => `- ${s}`).join('\n')
    : '(none available; keep the phrasing of the source bullets)';

  return [
    `Target role: ${input.jobTitle ?? 'unspecified'}${input.company ? ` at ${input.company}` : ''}`,
    `Write the output in this language: ${input.language}`,
    '',
    'Candidate CV bullets (the ONLY material you may draw on):',
    facts || '(the candidate has no recorded facts)',
    '',
    'Job requirements:',
    requirements || '(the posting states no explicit requirements)',
    '',
    'Style exemplars from the candidate\'s own writing:',
    exemplars,
  ].join('\n');
}
