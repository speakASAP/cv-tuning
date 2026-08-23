/**
 * Bumped on every prompt change and persisted per render, alongside the tailoring version.
 */
export const ENTAIL_PROMPT_VERSION = 'entail-v1';

export const ENTAIL_SYSTEM_PROMPT = [
  'You check whether each rewritten CV bullet is fully supported by the source fact it came from.',
  '',
  'For every bullet return exactly one verdict:',
  '- "supported": every claim in the bullet is stated by, or directly follows from, the source fact.',
  '- "overreach": the bullet is related to the source fact but asserts more than it says —',
  '  a number, scale, seniority, team size, duration, or scope the fact does not establish.',
  '  Example: fact "Senior Developer at Acme" rewritten as "Led a team of 12" is overreach.',
  '- "unsupported": the bullet asserts something the source fact gives no basis for at all.',
  '',
  'When the verdict is not "supported", quote the exact offending span from the bullet.',
  'Rephrasing, reordering, and emphasis are NOT overreach. Judge claims, not style.',
  'Be strict: an unflagged invention costs the candidate the job.',
].join('\n');

export const ENTAIL_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['bulletRef', 'verdict', 'span'],
        properties: {
          /** Index into the bullets array as given, so a result cannot be mismatched by text. */
          bulletRef: { type: 'integer' },
          verdict: { type: 'string', enum: ['supported', 'overreach', 'unsupported'] },
          span: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

export interface EntailPromptBullet {
  text: string;
  sourceFactText: string;
}

export function buildEntailPrompt(bullets: EntailPromptBullet[]): string {
  const blocks = bullets.map((b, index) =>
    [`Bullet ${index}:`, `  source fact: ${b.sourceFactText}`, `  rewritten:   ${b.text}`].join('\n'),
  );

  return ['Check each bullet against its own source fact.', '', blocks.join('\n\n')].join('\n');
}
