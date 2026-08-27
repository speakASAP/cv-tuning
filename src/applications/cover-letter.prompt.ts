import { AI_TELL_PHRASES } from './ai-tell';

/**
 * Bumped on every prompt change and persisted on each supplement, so a later eval run can
 * attribute a grounding regression to the exact prompt that caused it.
 */
export const COVER_LETTER_PROMPT_VERSION = 'cover-letter-v1';

/**
 * Modelled on `TAILOR_SYSTEM_PROMPT` with the hard rules renumbered for paragraphs, because a
 * cover-letter paragraph is the same kind of assertion as a tailored bullet: a claim bound to
 * exactly one fact. Keeping the rules verbatim-parallel is deliberate — two prompts that state
 * the grounding contract differently will eventually be enforced differently.
 *
 * Rule 3 is the one rule with no counterpart in the tailor prompt. Prose wants connective
 * sentences no fact supports, so the salutation, the opening line naming the role and company,
 * and the closing are built in code from the parsed job (`cover-letter-render.ts`). The model
 * is told its own attempts at those are DISCARDED rather than merely unwanted: a model that
 * believes its greeting will ship writes a first body paragraph that reads as a continuation
 * of one, and that paragraph arrives here as a claim to validate.
 */
export const COVER_LETTER_SYSTEM_PROMPT = [
  "You write the body of a cover letter from a candidate's existing CV facts.",
  '',
  'Hard rules, in order of importance:',
  '1. Every paragraph you output MUST be grounded in exactly ONE input fact. Return that',
  "   fact's factId as sourceFactId. Never merge two facts into one paragraph.",
  '2. Never introduce a number, percentage, duration, team size, job title, employer, or',
  '   technology that is not already present in the source fact. If the posting wants',
  '   something the candidate has not done, leave it out. A gap is honest; an invention is',
  '   not.',
  '3. Write body paragraphs ONLY. Do not write a greeting, an opening line naming the role or',
  '   the company, a sign-off, or a signature. Those are added afterwards, and anything you',
  '   write in their place is discarded.',
  '4. Omit a fact entirely rather than stretch it. Fewer, truthful paragraphs beat more.',
  '',
  'Voice:',
  "- Write in the candidate's own register, using the style exemplars given.",
  '- Lead with the concrete outcome, not the activity.',
  '- Demonstrate a required skill through what was done; do not repeat the skill noun.',
  `- Never use these words or phrases: ${AI_TELL_PHRASES.join(', ')}.`,
].join('\n');

export const COVER_LETTER_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['paragraphs'],
  properties: {
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'sourceFactId'],
        properties: {
          text: { type: 'string', minLength: 1 },
          // Singular by schema, not only by instruction: an array here would invite the
          // model to merge facts, which is exactly what the source constraint forbids.
          // `company` and `jobTitle` are deliberately absent — they are inputs the model
          // reads and CODE writes, never fields the model returns, because a model-returned
          // employer name is a fabrication on a letter addressed to that employer.
          sourceFactId: { type: 'string', minLength: 1 },
          targetRequirement: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

export interface CoverLetterPromptInput {
  facts: { factId: string; text: string; kind: string }[];
  requirements: { text: string; kind: 'must' | 'nice' }[];
  jobTitle: string | null;
  company: string | null;
  language: string;
  /** The user's own sentences, carried in so the output keeps their voice (§6.1). */
  styleExemplars: string[];
  /**
   * Selects ONE register line and nothing else. Scoped this narrowly on purpose: a tone that
   * could vary more of the prompt would be a second route to relaxing a hard rule, and one
   * that nothing in review would think to check.
   */
  tone: 'plain' | 'warm';
}

const TONE_LINE: Record<CoverLetterPromptInput['tone'], string> = {
  plain: 'Register: direct and factual. State what was done and what it produced.',
  warm: 'Register: direct and factual, with a little warmth. State what was done and what it produced.',
};

export function buildCoverLetterPrompt(input: CoverLetterPromptInput): string {
  const facts = input.facts.map((f) => `- [${f.factId}] (${f.kind}) ${f.text}`).join('\n');
  const requirements = input.requirements.map((r) => `- (${r.kind}) ${r.text}`).join('\n');
  const exemplars = input.styleExemplars.length
    ? input.styleExemplars.map((s) => `- ${s}`).join('\n')
    : '(none available; keep the phrasing of the source facts)';

  return [
    `Target role: ${input.jobTitle ?? 'unspecified'}${input.company ? ` at ${input.company}` : ''}`,
    `Write the output in this language: ${input.language}`,
    TONE_LINE[input.tone],
    '',
    'Candidate CV facts (the ONLY material you may draw on):',
    // Never an empty section: a blank list reads as "you decide what to write", which is an
    // invitation to invent exactly where invention is most costly.
    facts || '(the candidate has no recorded facts)',
    '',
    'Job requirements:',
    requirements || '(the posting states no explicit requirements)',
    '',
    "Style exemplars from the candidate's own writing:",
    exemplars,
  ].join('\n');
}
