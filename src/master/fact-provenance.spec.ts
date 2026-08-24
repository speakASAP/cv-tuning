import { ExtractedFact } from './fact-identity';
import { attachFactContext, parseHeadingBlocks, parseEntryHeading } from './fact-provenance';

const fact = (text: string, position: number): ExtractedFact => ({
  text,
  position,
  kind: 'achievement',
  payload: {},
  metric: null,
});

/**
 * The `### Role — Company (period)` shape is what `linkedin.importer.ts` guarantees, but
 * gdocs/document imports pass user-authored markdown through untouched. A wrong employer on
 * a CV is worse than an absent one, so every ambiguous shape must fall back to nulls.
 */
describe('parseEntryHeading', () => {
  it('splits the canonical em-dash form the LinkedIn importer emits', () => {
    expect(parseEntryHeading('Senior Developer — Acme Corp (Jan 2019 – Dec 2024)')).toEqual({
      org: 'Acme Corp',
      period: 'Jan 2019 – Dec 2024',
    });
  });

  it('reads an entry with no period, since Started On may be blank in a LinkedIn export', () => {
    expect(parseEntryHeading('Senior Developer — Acme Corp')).toEqual({
      org: 'Acme Corp',
      period: null,
    });
  });

  it('keeps a hyphen inside the company name rather than splitting on it', () => {
    // The separator is an em dash; a hyphenated company must not be mistaken for one.
    expect(parseEntryHeading('Engineer — Hewlett-Packard (2010 – 2012)')).toEqual({
      org: 'Hewlett-Packard',
      period: '2010 – 2012',
    });
  });

  it('keeps parentheses inside the company name when there is also a trailing period', () => {
    expect(parseEntryHeading('Engineer — Acme (Europe) Ltd (2010 – 2012)')).toEqual({
      org: 'Acme (Europe) Ltd',
      period: '2010 – 2012',
    });
  });

  it('treats a lone trailing parenthesised group as the period, not part of the org', () => {
    expect(parseEntryHeading('Consultant — Beta GmbH (2021)')).toEqual({
      org: 'Beta GmbH',
      period: '2021',
    });
  });

  it('returns nulls when there is no em-dash separator at all', () => {
    // Free-form markdown from a gdocs import has no guaranteed shape. Guessing that the
    // whole heading is the employer would print an invented employer onto a real CV.
    expect(parseEntryHeading('Various freelance projects')).toEqual({ org: null, period: null });
  });

  it('returns nulls when the em dash has nothing after it', () => {
    expect(parseEntryHeading('Senior Developer —')).toEqual({ org: null, period: null });
  });

  it('returns nulls when the em dash has nothing before it', () => {
    // Without a role part the shape is not the one we recognise, so we cannot claim the
    // remainder is an employer.
    expect(parseEntryHeading('— Acme Corp (2019)')).toEqual({ org: null, period: null });
  });

  it('returns nulls when more than one em dash makes the split ambiguous', () => {
    expect(parseEntryHeading('Lead — Acme — Berlin (2019)')).toEqual({ org: null, period: null });
  });

  it('leaves the org intact when the parenthesised group is unbalanced', () => {
    // "(2019" never closes, so it is not a period group; better to keep it in the org than
    // to invent a period from a broken shape.
    expect(parseEntryHeading('Engineer — Acme (2019')).toEqual({ org: 'Acme (2019', period: null });
  });

  it('returns nulls for an empty heading', () => {
    expect(parseEntryHeading('')).toEqual({ org: null, period: null });
  });
});

describe('parseHeadingBlocks', () => {
  const MARKDOWN = [
    '# Jane Doe',
    '',
    '## Experience',
    '',
    '### Senior Developer — Acme Corp (2019 – 2024)',
    '',
    '- Cut churn 23%',
    '- Led the payments migration',
    '',
    '### Junior Developer — Beta GmbH (2016 – 2019)',
    '',
    '- Shipped the first mobile client',
    '',
    '## Skills',
    '',
    '- Python',
    '- TypeScript',
  ].join('\n');

  it('gives each body line the section and entry heading above it', () => {
    const blocks = parseHeadingBlocks(MARKDOWN);
    const churn = blocks.find((b) => b.line.includes('Cut churn'));

    expect(churn).toEqual(
      expect.objectContaining({
        section: 'Experience',
        org: 'Acme Corp',
        period: '2019 – 2024',
      }),
    );
  });

  it('switches entry when a later H3 appears', () => {
    const blocks = parseHeadingBlocks(MARKDOWN);
    const mobile = blocks.find((b) => b.line.includes('mobile client'));

    expect(mobile).toEqual(
      expect.objectContaining({ section: 'Experience', org: 'Beta GmbH', period: '2016 – 2019' }),
    );
  });

  it('clears the entry context when a new H2 starts, so Skills never inherits an employer', () => {
    // Carrying `Acme Corp` down into the Skills section would attribute a skill to an
    // employer the CV never connected it to.
    const blocks = parseHeadingBlocks(MARKDOWN);
    const python = blocks.find((b) => b.line.includes('Python'));

    expect(python).toEqual(expect.objectContaining({ section: 'Skills', org: null, period: null }));
  });

  it('does not treat the H1 name as a section', () => {
    const blocks = parseHeadingBlocks(MARKDOWN);

    expect(blocks.every((b) => b.section !== 'Jane Doe')).toBe(true);
  });

  it('returns null context for markdown with no headings at all', () => {
    // A pasted plain-text CV is a real, expected input; it must not crash or invent one.
    const blocks = parseHeadingBlocks('Cut churn 23%\nLed the payments migration');

    expect(blocks.map((b) => b.section)).toEqual([null, null]);
    expect(blocks.map((b) => b.org)).toEqual([null, null]);
  });

  it('ignores headings inside fenced code, which are literal text not structure', () => {
    const blocks = parseHeadingBlocks(
      ['## Experience', '', '```', '## Not A Section', '```', '', '- Cut churn 23%'].join('\n'),
    );
    const churn = blocks.find((b) => b.line.includes('Cut churn'));

    expect(churn?.section).toBe('Experience');
  });

  it('strips list markers and emphasis so a body line matches the fact text a model returns', () => {
    const blocks = parseHeadingBlocks('## Experience\n\n- **Cut churn 23%**');

    expect(blocks[0].line).toBe('Cut churn 23%');
  });

  it('returns no blocks for empty markdown rather than throwing', () => {
    expect(parseHeadingBlocks('   ')).toEqual([]);
  });
});

describe('attachFactContext', () => {
  const MARKDOWN = [
    '# Jane Doe',
    '',
    '## Experience',
    '',
    '### Senior Developer — Acme Corp (2019 – 2024)',
    '',
    '- Cut churn 23%',
    '',
    '### Junior Developer — Beta GmbH (2016 – 2019)',
    '',
    '- Shipped the first mobile client',
    '',
    '## Skills',
    '',
    '- Python',
  ].join('\n');

  it('attaches section, org and period to a fact whose text matches its source line exactly', () => {
    const [attached] = attachFactContext(MARKDOWN, [fact('Cut churn 23%', 0)]);

    expect(attached.section).toBe('Experience');
    expect(attached.org).toBe('Acme Corp');
    expect(attached.period).toBe('2019 – 2024');
  });

  it('matches despite case and whitespace differences the model introduces', () => {
    // The prompt asks the model to copy the wording verbatim; it does not always comply
    // exactly. Normalised matching is the same normalisation `hashFactContent` uses.
    const [attached] = attachFactContext(MARKDOWN, [fact('  cut   churn 23%  ', 0)]);

    expect(attached.org).toBe('Acme Corp');
  });

  it('matches a fact the model trimmed to a prefix of the source line', () => {
    const markdown = '## Experience\n\n### Lead — Acme Corp (2020)\n\n- Cut churn 23% in six months';
    const [attached] = attachFactContext(markdown, [fact('Cut churn 23%', 0)]);

    expect(attached.org).toBe('Acme Corp');
  });

  it('matches a fact the model expanded around the source line', () => {
    const markdown = '## Experience\n\n### Lead — Acme Corp (2020)\n\n- Cut churn 23%';
    const [attached] = attachFactContext(markdown, [fact('Cut churn 23% at Acme', 0)]);

    expect(attached.org).toBe('Acme Corp');
  });

  it('leaves context null when the fact matches no line, rather than guessing the nearest heading', () => {
    // A rewritten or hallucinated fact has no provable home. A wrong employer on a CV is
    // worse than an absent one, so this must stay null.
    const [attached] = attachFactContext(MARKDOWN, [fact('Won an unrelated award', 0)]);

    expect(attached.section).toBeNull();
    expect(attached.org).toBeNull();
    expect(attached.period).toBeNull();
  });

  it('leaves context null when the same text appears under two different employers', () => {
    // Two candidate blocks disagree about the employer, so no confident answer exists.
    const markdown = [
      '## Experience',
      '',
      '### Lead — Acme Corp (2020)',
      '',
      '- Mentored juniors',
      '',
      '### Lead — Beta GmbH (2018)',
      '',
      '- Mentored juniors',
    ].join('\n');

    const [attached] = attachFactContext(markdown, [fact('Mentored juniors', 0)]);

    expect(attached.org).toBeNull();
    expect(attached.period).toBeNull();
  });

  it('still attaches the shared section when duplicate lines agree on it', () => {
    // The blocks disagree about the employer but agree the fact lives under Experience;
    // that part is unambiguous and withholding it would lose real information.
    const markdown = [
      '## Experience',
      '',
      '### Lead — Acme Corp (2020)',
      '',
      '- Mentored juniors',
      '',
      '### Lead — Beta GmbH (2018)',
      '',
      '- Mentored juniors',
    ].join('\n');

    const [attached] = attachFactContext(markdown, [fact('Mentored juniors', 0)]);

    expect(attached.section).toBe('Experience');
  });

  it('prefers the exact match when one line matches exactly and another only loosely', () => {
    const markdown = [
      '## Experience',
      '',
      '### Lead — Acme Corp (2020)',
      '',
      '- Cut churn 23%',
      '',
      '### Lead — Beta GmbH (2018)',
      '',
      '- Cut churn 23% across all plans',
    ].join('\n');

    const [attached] = attachFactContext(markdown, [fact('Cut churn 23%', 0)]);

    expect(attached.org).toBe('Acme Corp');
  });

  it('returns nulls for every fact when the markdown has no headings', () => {
    const facts = attachFactContext('Cut churn 23%\nLed the migration', [
      fact('Cut churn 23%', 0),
      fact('Led the migration', 1),
    ]);

    expect(facts.map((f) => f.section)).toEqual([null, null]);
    expect(facts.map((f) => f.org)).toEqual([null, null]);
    expect(facts.map((f) => f.period)).toEqual([null, null]);
  });

  it('preserves every other field and the fact order untouched', () => {
    const input = [fact('Cut churn 23%', 0), fact('Python', 1)];
    const attached = attachFactContext(MARKDOWN, input);

    expect(attached.map((f) => f.text)).toEqual(['Cut churn 23%', 'Python']);
    expect(attached.map((f) => f.position)).toEqual([0, 1]);
    expect(attached[0].kind).toBe('achievement');
  });

  it('does not let a very short fact match a long line by containment', () => {
    // "Python" is a substring of a hundred lines. Containment matching on a two-character
    // token would attach an arbitrary employer to a skill.
    const markdown = '## Experience\n\n### Lead — Acme Corp (2020)\n\n- Rewrote the Python data pipeline';
    const [attached] = attachFactContext(markdown, [fact('Py', 0)]);

    expect(attached.org).toBeNull();
  });

  it('returns an empty array for no facts', () => {
    expect(attachFactContext(MARKDOWN, [])).toEqual([]);
  });
});

/**
 * The identity guarantee: `hashFactContent` hashes normalised TEXT only. If org or period
 * entered the hash, re-titling a job heading would orphan every fact under it and break
 * every provenance link a tailored CV holds.
 */
describe('derived context and fact identity', () => {
  const withOrg = (org: string) =>
    ['## Experience', '', `### Senior Developer — ${org} (2019 – 2024)`, '', '- Cut churn 23%'].join('\n');

  it('does not change a fact id when only the org/period heading is edited', () => {
    // Asserted through matchFactIds, the real consumer, not by inspecting the hash.
    const { hashFactContent, matchFactIds } = require('./fact-identity');

    const before = attachFactContext(withOrg('Acme Corp'), [fact('Cut churn 23%', 0)]);
    const stored = before.map((f) => ({
      id: 'f1',
      contentHash: hashFactContent(f.text),
      position: f.position,
    }));

    const after = attachFactContext(withOrg('Acme Corporation GmbH'), [fact('Cut churn 23%', 0)]);
    const matched = matchFactIds(stored, after);

    expect(matched[0].id).toBe('f1');
    expect(matched[0].isNew).toBe(false);
    // ...and the new context did land, so this is not passing because derivation no-opped.
    expect(matched[0].org).toBe('Acme Corporation GmbH');
  });
});
