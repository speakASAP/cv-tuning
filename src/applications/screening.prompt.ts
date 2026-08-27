import { AI_TELL_PHRASES } from './ai-tell';

/**
 * Bumped on every prompt change and persisted on each supplement, so a later eval run can
 * attribute a grounding regression to the exact prompt that caused it.
 */
export const SCREENING_PROMPT_VERSION = 'screening-v1';

/**
 * Screening answers are the single most dangerous output in this product.
 *
 * A tailored CV bullet is reviewed in the app before it goes anywhere. A screening answer is
 * pasted by the user into an employer's own form, under their own name, often without a second
 * read — so a fabricated one is a lie told directly to the employer in the applicant's voice,
 * with no review step in between.
 *
 * Hence rule 3, which has no counterpart in the tailor or cover-letter prompts: returning NO
 * paragraph is an explicitly correct outcome. An unanswerable screening question is real,
 * useful signal for the user ("this employer wants something you have not done"), while an
 * invented answer to it is the worst thing this codebase could emit. The prompt says so
 * plainly rather than leaving the model to infer that silence is permitted.
 */
export const SCREENING_SYSTEM_PROMPT = [
  "You answer a job application's screening questions using a candidate's existing CV facts.",
  '',
  'Hard rules, in order of importance:',
  '1. Every paragraph you output MUST be grounded in exactly ONE input fact. Return that',
  "   fact's factId as sourceFactId. Never merge two facts into one paragraph.",
  '2. Never introduce a number, percentage, duration, team size, job title, employer, or',
  '   technology that is not already present in the source fact.',
  '3. If no fact supports an honest answer to a question, return NO paragraphs for that',
  '   question. This is a correct and expected outcome, not a failure. The candidate pastes',
  '   these answers into an employer\'s form under their own name; an unanswerable question is',
  '   information they need, and an invented answer is a lie told in their voice.',
  '4. Answer only the questions given to you. Never add a question of your own.',
  '5. Omit a fact entirely rather than stretch it.',
  '',
  'Voice:',
  "- Write in the candidate's own register, using the style exemplars given.",
  '- Answer the question directly; do not restate it.',
  `- Never use these words or phrases: ${AI_TELL_PHRASES.join(', ')}.`,
].join('\n');

export const SCREENING_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question', 'paragraphs'],
        properties: {
          // Echoed back so each answer can be matched to its question. Matched IN CODE against
          // the input list — the model does not get to invent a question, because an answer to
          // a question nobody asked would be presented to the user as one the employer posed.
          question: { type: 'string', minLength: 1 },
          paragraphs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['text', 'sourceFactId'],
              properties: {
                text: { type: 'string', minLength: 1 },
                // Singular by schema, not only by instruction, for the reason recorded in
                // tailor.prompt.ts: an array invites the model to merge facts.
                sourceFactId: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
} as const;

export interface ScreeningPromptInput {
  facts: { factId: string; text: string; kind: string }[];
  questions: string[];
  jobTitle: string | null;
  company: string | null;
  language: string;
  styleExemplars: string[];
}

export function buildScreeningPrompt(input: ScreeningPromptInput): string {
  const facts = input.facts.map((f) => `- [${f.factId}] (${f.kind}) ${f.text}`).join('\n');
  const questions = input.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const exemplars = input.styleExemplars.length
    ? input.styleExemplars.map((s) => `- ${s}`).join('\n')
    : '(none available; keep the phrasing of the source facts)';

  return [
    `Target role: ${input.jobTitle ?? 'unspecified'}${input.company ? ` at ${input.company}` : ''}`,
    `Write the output in this language: ${input.language}`,
    '',
    'Questions to answer (answer ONLY these, echoing each question back verbatim):',
    questions || '(no questions were asked)',
    '',
    'Candidate CV facts (the ONLY material you may draw on):',
    facts || '(the candidate has no recorded facts)',
    '',
    "Style exemplars from the candidate's own writing:",
    exemplars,
  ].join('\n');
}
