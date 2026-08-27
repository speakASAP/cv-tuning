import { AI_TELL_PHRASES } from './ai-tell';
import {
  COVER_LETTER_OUTPUT_SCHEMA,
  COVER_LETTER_PROMPT_VERSION,
  COVER_LETTER_SYSTEM_PROMPT,
  buildCoverLetterPrompt,
} from './cover-letter.prompt';

const INPUT = {
  facts: [
    { factId: 'f1', text: 'Cut checkout latency from 900ms to 220ms', kind: 'achievement' },
    { factId: 'f2', text: 'Ran PostgreSQL in production for six years', kind: 'skill' },
  ],
  requirements: [{ text: 'Strong PostgreSQL', kind: 'must' as const }],
  jobTitle: 'Staff Engineer',
  company: 'Globex',
  language: 'en',
  styleExemplars: ['I like making slow things fast.'],
  tone: 'plain' as const,
};

describe('COVER_LETTER_SYSTEM_PROMPT', () => {
  it('binds every paragraph to exactly one fact', () => {
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain('exactly ONE');
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain('sourceFactId');
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain('Never merge two facts');
  });

  it('forbids introducing anything not already in the source fact', () => {
    for (const forbidden of ['number', 'percentage', 'team size', 'employer', 'technology']) {
      expect(COVER_LETTER_SYSTEM_PROMPT).toContain(forbidden);
    }
  });

  it('tells the model to write body paragraphs only', () => {
    // The salutation, the line naming role and company, and the closing are built in code.
    // Anything the model writes there is discarded, and the prompt says so — a model that
    // believes its greeting will ship writes a body that reads as a continuation of one.
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain('body');
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain('discarded');
  });

  it('prefers omission to stretching a fact', () => {
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain('Omit');
  });

  it('lists the AI-tell phrases from ./ai-tell rather than a hand-copied list', () => {
    // A hand-copied list drifts from the detector that scores the output, so a phrase could be
    // penalised at scoring time while the prompt still invited it.
    for (const phrase of AI_TELL_PHRASES) {
      expect(COVER_LETTER_SYSTEM_PROMPT).toContain(phrase);
    }
  });
});

describe('COVER_LETTER_OUTPUT_SCHEMA', () => {
  const paragraph = COVER_LETTER_OUTPUT_SCHEMA.properties.paragraphs.items;

  it('makes sourceFactId a single string, not an array', () => {
    // Singular by SCHEMA, not only by instruction: an array here would invite the model to
    // merge facts, which is exactly what the source constraint forbids.
    expect(paragraph.properties.sourceFactId.type).toBe('string');
    expect(paragraph.required).toContain('sourceFactId');
    expect(paragraph.required).toContain('text');
  });

  it('does not let the model return company or jobTitle', () => {
    // They are inputs the model reads and CODE writes. A model-returned company name is a
    // fabricated employer on a letter that goes to that employer.
    expect(Object.keys(paragraph.properties)).not.toContain('company');
    expect(Object.keys(paragraph.properties)).not.toContain('jobTitle');
  });
});

describe('buildCoverLetterPrompt', () => {
  it('carries the facts, requirements, role, company, language and exemplars', () => {
    const prompt = buildCoverLetterPrompt(INPUT);
    expect(prompt).toContain('[f1]');
    expect(prompt).toContain('Cut checkout latency');
    expect(prompt).toContain('Strong PostgreSQL');
    expect(prompt).toContain('Staff Engineer');
    expect(prompt).toContain('Globex');
    expect(prompt).toContain('en');
    expect(prompt).toContain('I like making slow things fast.');
  });

  it('states plainly when the candidate has no facts, rather than sending an empty list', () => {
    // An empty section reads as "you decide what to write", which is an invitation to invent.
    const prompt = buildCoverLetterPrompt({ ...INPUT, facts: [] });
    expect(prompt).toContain('no recorded facts');
  });

  it('states plainly when the posting lists no requirements', () => {
    const prompt = buildCoverLetterPrompt({ ...INPUT, requirements: [] });
    expect(prompt).toContain('no explicit requirements');
  });

  it('never guesses a missing job title or company', () => {
    const prompt = buildCoverLetterPrompt({ ...INPUT, jobTitle: null, company: null });
    expect(prompt).toContain('unspecified');
    expect(prompt).not.toContain('Globex');
    expect(prompt).not.toContain('Staff Engineer');
  });

  it('falls back to the source phrasing when the user has no style exemplars', () => {
    const prompt = buildCoverLetterPrompt({ ...INPUT, styleExemplars: [] });
    expect(prompt).toContain('none available');
  });

  it('changes exactly one line between the two tones', () => {
    // tone selects a register and NOTHING else. If it could vary more, it would be a second
    // way to relax the hard rules without anything in review noticing.
    const plain = buildCoverLetterPrompt({ ...INPUT, tone: 'plain' }).split('\n');
    const warm = buildCoverLetterPrompt({ ...INPUT, tone: 'warm' }).split('\n');
    expect(plain).toHaveLength(warm.length);
    const differing = plain.filter((line: string, i: number) => line !== warm[i]);
    expect(differing).toHaveLength(1);
  });

  it('is deterministic for identical input', () => {
    expect(buildCoverLetterPrompt(INPUT)).toBe(buildCoverLetterPrompt(INPUT));
  });
});

describe('COVER_LETTER_PROMPT_VERSION', () => {
  it('is a stable identifier persisted with each supplement', () => {
    // Persisted on the row so a later eval can attribute a grounding regression to the exact
    // prompt that caused it.
    expect(COVER_LETTER_PROMPT_VERSION).toBe('cover-letter-v1');
  });
});
