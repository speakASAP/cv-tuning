import { buildRevisePrompt, REVISE_SYSTEM_PROMPT } from './revise.prompt';

const base = {
  facts: [{ factId: 'f1', text: 'Senior Developer at Acme, 2019-2024', kind: 'role' }],
  requirements: [{ text: 'TypeScript', kind: 'must' as const }],
  jobTitle: 'Engineer',
  company: 'Globex',
  language: 'en',
  styleExemplars: ['Cut checkout latency from 900ms to 220ms'],
  previousMarkdown: '- Senior Developer at Acme',
  history: [],
  instruction: 'make it punchier',
};

describe('buildRevisePrompt', () => {
  it('carries the previous render so the model revises rather than restarts', () => {
    expect(buildRevisePrompt(base)).toContain('- Senior Developer at Acme');
  });

  it('carries the instruction', () => {
    expect(buildRevisePrompt(base)).toContain('make it punchier');
  });

  it('includes the fact ids the rewrite must bind to', () => {
    expect(buildRevisePrompt(base)).toContain('[f1]');
  });

  it('renders prior turns so the model does not undo an earlier request', () => {
    const prompt = buildRevisePrompt({
      ...base,
      history: [{ role: 'user' as const, content: 'drop the education section' }],
    });
    expect(prompt).toContain('drop the education section');
  });

  it('refuses instructions that ask for new claims', () => {
    // Uppercase deliberately: the prompt emphasises its hardest rule as "REFUSE" to match
    // the house style of MUST/ONE/ONLY in tailor.prompt.ts. Do not lowercase this literal.
    expect(REVISE_SYSTEM_PROMPT).toContain('REFUSE');
  });
});
