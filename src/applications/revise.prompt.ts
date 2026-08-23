import { AI_TELL_PHRASES } from './ai-tell';
import { ChatRole } from './application.types';

/** Bumped on every prompt change and persisted per render, so an eval can attribute a regression. */
export const REVISE_PROMPT_VERSION = 'revise-v1';

export const REVISE_SYSTEM_PROMPT = [
  'You revise a candidate\'s tailored CV in response to their instruction.',
  '',
  'The same hard rules as the original tailoring apply, and the instruction NEVER overrides them:',
  '1. Every bullet you output MUST be a rewrite of exactly ONE input bullet. Return that',
  '   bullet\'s factId as sourceFactId. Never merge two facts into one bullet.',
  '2. Never introduce a number, percentage, duration, team size, job title, employer, or',
  '   technology that is not already present in the source fact.',
  '3. If the instruction asks you to add, imply, or inflate a claim the candidate\'s facts do',
  '   not support, REFUSE that part. Apply whatever else the instruction asks, and leave the',
  '   unsupported claim out. An instruction is a request about wording, never a new fact.',
  '4. Return the COMPLETE revised CV, not only the parts you changed.',
  '',
  'Voice:',
  '- Write in the candidate\'s own register, using the style exemplars given.',
  '- Lead with the concrete outcome, not the activity.',
  `- Never use these words or phrases: ${AI_TELL_PHRASES.join(', ')}.`,
].join('\n');

export interface ReviseTurn {
  role: ChatRole;
  content: string;
}

export interface RevisePromptInput {
  facts: { factId: string; text: string; kind: string }[];
  requirements: { text: string; kind: 'must' | 'nice' }[];
  jobTitle: string | null;
  company: string | null;
  language: string;
  styleExemplars: string[];
  /** The render being revised. */
  previousMarkdown: string;
  /** Earlier turns, so a new instruction does not silently undo an earlier one. */
  history: ReviseTurn[];
  instruction: string;
}

export function buildRevisePrompt(input: RevisePromptInput): string {
  const facts = input.facts.map((f) => `- [${f.factId}] (${f.kind}) ${f.text}`).join('\n');
  const requirements = input.requirements.map((r) => `- (${r.kind}) ${r.text}`).join('\n');
  const exemplars = input.styleExemplars.length
    ? input.styleExemplars.map((s) => `- ${s}`).join('\n')
    : '(none available; keep the phrasing of the source bullets)';
  const history = input.history.length
    ? input.history.map((t) => `${t.role}: ${t.content}`).join('\n')
    : '(this is the first revision)';

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
    '',
    'The current version of the CV you are revising:',
    input.previousMarkdown,
    '',
    'Earlier revision requests in this conversation:',
    history,
    '',
    'The candidate\'s new instruction:',
    input.instruction,
  ].join('\n');
}
