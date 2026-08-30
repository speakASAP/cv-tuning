import {
  classifySection,
  deterministicExtract,
  extractMetric,
  isDeterministicSufficient,
} from './deterministic-extractor';

const MARKDOWN_CV = `# Jane Doe

## Experience

### Senior Developer — Acme Corp (2019 - 2023)

- Cut checkout latency by 40% across the payments path
- Led a team of 6 engineers through a platform migration

### Developer — Beta Ltd (2016 - 2019)

- Built the reporting pipeline used by 2000 customers

## Skills

- TypeScript
- PostgreSQL

## Education

- MSc Computer Science, Imperial College

## Projects

- https://github.com/janedoe/parser
`;

/** What `?format=txt` actually returns: no markdown, bullet glyphs, bare section labels. */
const PLAIN_TEXT_CV = `Jane Doe
jane@example.com

Experience

Senior Developer — Acme Corp (2019 - 2023)
\u2022 Cut checkout latency by 40% across the payments path
\u2022 Led a team of 6 engineers through a platform migration

Developer — Beta Ltd (2016 - 2019)
\u2022 Built the reporting pipeline used by 2000 customers

Skills
\u2022 TypeScript
\u2022 PostgreSQL

Education
\u2022 MSc Computer Science, Imperial College
`;

describe('classifySection', () => {
  it('recognises the common CV section labels', () => {
    expect(classifySection('Experience')).toBe('achievement');
    expect(classifySection('Work Experience')).toBe('achievement');
    expect(classifySection('Technical Skills')).toBe('skill');
    expect(classifySection('Education')).toBe('education');
    expect(classifySection('Certifications')).toBe('certification');
    expect(classifySection('Projects')).toBe('proof');
  });

  it('tolerates a trailing colon, which plain-text exports keep', () => {
    expect(classifySection('Skills:')).toBe('skill');
  });

  it('does not treat a sentence that merely mentions a section word as a heading', () => {
    expect(classifySection('Experience with distributed systems and Kafka')).toBeNull();
    expect(classifySection('Led the education platform rewrite')).toBeNull();
  });
});

describe('extractMetric', () => {
  it('captures the quantity verbatim', () => {
    expect(extractMetric('Cut checkout latency by 40% across the payments path')).toBe('40%');
    expect(extractMetric('Served 2000 customers')).toBe('2000 customers');
  });

  it('returns null rather than inventing a metric', () => {
    expect(extractMetric('Led a platform migration')).toBeNull();
  });
});

describe('deterministicExtract on a structured markdown CV', () => {
  const result = deterministicExtract(MARKDOWN_CV);

  it('reads the CV without a model', () => {
    expect(isDeterministicSufficient(result)).toBe(true);
  });

  it('classifies each fact from the section it sits under', () => {
    const kinds = new Set(result.facts.map((fact) => fact.kind));
    expect(kinds).toContain('achievement');
    expect(kinds).toContain('skill');
    expect(kinds).toContain('education');
  });

  it('attributes an achievement to the employer whose entry it sits under', () => {
    const fact = result.facts.find((f) => f.text.includes('checkout latency'));
    expect(fact).toMatchObject({ org: 'Acme Corp', title: 'Senior Developer', period: '2019 - 2023' });
  });

  it('never carries an employer into a later section', () => {
    const skill = result.facts.find((f) => f.text === 'TypeScript');
    expect(skill?.org).toBeNull();
    expect(skill?.kind).toBe('skill');
  });

  it('copies the candidate wording verbatim, without the list marker', () => {
    expect(result.facts.some((f) => f.text === 'Cut checkout latency by 40% across the payments path')).toBe(true);
  });

  it('records the role stated by the entry heading', () => {
    const role = result.facts.find((f) => f.kind === 'role' && f.text.includes('Acme Corp'));
    expect(role).toBeDefined();
  });

  it('treats a link as evidence regardless of its section', () => {
    const proof = result.facts.find((f) => f.text.includes('github.com'));
    expect(proof?.kind).toBe('proof');
  });

  it('assigns positions in document order with no gaps', () => {
    expect(result.facts.map((f) => f.position)).toEqual(result.facts.map((_, index) => index));
  });
});

describe('deterministicExtract on a Google Docs plain-text export', () => {
  const result = deterministicExtract(PLAIN_TEXT_CV);

  it('reads a CV that lost every markdown marker', () => {
    expect(isDeterministicSufficient(result)).toBe(true);
  });

  it('recovers section structure from bare heading lines', () => {
    const skill = result.facts.find((f) => f.text === 'TypeScript');
    expect(skill?.kind).toBe('skill');
  });

  it('recovers the employer from a bare entry line', () => {
    const fact = result.facts.find((f) => f.text.includes('checkout latency'));
    expect(fact).toMatchObject({ org: 'Acme Corp', period: '2019 - 2023' });
  });

  it('strips the bullet glyph the export emits', () => {
    expect(result.facts.every((f) => !f.text.startsWith('\u2022'))).toBe(true);
  });
});

describe('deterministicExtract on an unstructured CV', () => {
  const prose = `I have worked in software for twelve years, mostly on payment systems.
I enjoy mentoring and have led several migrations to cloud infrastructure.
Most recently I rebuilt a checkout flow that had grown difficult to maintain.`;
  const result = deterministicExtract(prose);

  it('reports that it could not read the document rather than guessing', () => {
    expect(isDeterministicSufficient(result)).toBe(false);
  });

  it('emits no facts it cannot attribute to a section', () => {
    expect(result.facts).toHaveLength(0);
  });
});

describe('deterministicExtract safety properties', () => {
  it('ignores structure written inside a code fence', () => {
    const withFence = ['## Skills', '', '```', '## Experience', '```', '', '- TypeScript'].join('\n');
    const result = deterministicExtract(withFence);

    expect(result.facts.every((f) => f.section === 'Skills')).toBe(true);
  });

  it('leaves the entry context null when a heading does not prove its own shape', () => {
    const ambiguous = ['## Experience', '', '### Lead — Acme — Berlin', '', '- Shipped the billing rewrite'].join('\n');
    const result = deterministicExtract(ambiguous);
    const fact = result.facts.find((f) => f.text.includes('billing'));

    // `Lead — Acme — Berlin` cannot be split confidently, and a wrong employer on a CV is
    // worse than an absent one.
    expect(fact?.org).toBeNull();
    expect(fact?.title).toBeNull();
  });

  it('never emits a fact under a section it does not recognise', () => {
    const unknown = ['## Hobbies', '', '- Long distance running'].join('\n');
    const result = deterministicExtract(unknown);

    expect(result.facts).toHaveLength(0);
  });
});
