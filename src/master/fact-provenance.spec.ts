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
      title: 'Senior Developer',
      org: 'Acme Corp',
      period: 'Jan 2019 – Dec 2024',
    });
  });

  it('reads an entry with no period, since Started On may be blank in a LinkedIn export', () => {
    expect(parseEntryHeading('Senior Developer — Acme Corp')).toEqual({
      title: 'Senior Developer',
      org: 'Acme Corp',
      period: null,
    });
  });

  it('keeps a hyphen inside the company name rather than splitting on it', () => {
    // The separator is an em dash; a hyphenated company must not be mistaken for one.
    expect(parseEntryHeading('Engineer — Hewlett-Packard (2010 – 2012)')).toEqual({
      title: 'Engineer',
      org: 'Hewlett-Packard',
      period: '2010 – 2012',
    });
  });

  it('keeps parentheses inside the company name when there is also a trailing period', () => {
    expect(parseEntryHeading('Engineer — Acme (Europe) Ltd (2010 – 2012)')).toEqual({
      title: 'Engineer',
      org: 'Acme (Europe) Ltd',
      period: '2010 – 2012',
    });
  });

  it('treats a lone trailing parenthesised group as the period, not part of the org', () => {
    expect(parseEntryHeading('Consultant — Beta GmbH (2021)')).toEqual({
      title: 'Consultant',
      org: 'Beta GmbH',
      period: '2021',
    });
  });

  it('returns nulls when there is no em-dash separator at all', () => {
    // Free-form markdown from a gdocs import has no guaranteed shape. Guessing that the
    // whole heading is the employer would print an invented employer onto a real CV.
    expect(parseEntryHeading('Various freelance projects')).toEqual({
      title: null,
      org: null,
      period: null,
    });
  });

  it('returns nulls when the em dash has nothing after it', () => {
    expect(parseEntryHeading('Senior Developer —')).toEqual({ title: null, org: null, period: null });
  });

  it('returns nulls when the em dash has nothing before it', () => {
    // Without a role part the shape is not the one we recognise, so we cannot claim the
    // remainder is an employer.
    expect(parseEntryHeading('— Acme Corp (2019)')).toEqual({ title: null, org: null, period: null });
  });

  it('returns nulls when more than one em dash makes the split ambiguous', () => {
    expect(parseEntryHeading('Lead — Acme — Berlin (2019)')).toEqual({ title: null, org: null, period: null });
  });

  it('leaves the org intact when the parenthesised group is unbalanced', () => {
    // "(2019" never closes, so it is not a period group; better to keep it in the org than
    // to invent a period from a broken shape.
    expect(parseEntryHeading('Engineer — Acme (2019')).toEqual({
      title: 'Engineer',
      org: 'Acme (2019',
      period: null,
    });
  });

  it('keeps the title verbatim, including a hyphen the em-dash split must not touch', () => {
    // "Full-Stack" is a hyphen inside a title, not a separator: splitting on hyphens would
    // shred a real job title into a plausible-looking wrong one.
    expect(parseEntryHeading('Full-Stack Developer — Acme (2019)')).toEqual({
      title: 'Full-Stack Developer',
      org: 'Acme',
      period: '2019',
    });
  });

  it('returns a null title for a heading with no em dash, matching org/period', () => {
    // An un-dashed heading is not provably `Role — Company`; `Various freelance projects` is
    // as likely a section label as a job title. A guessed job title is a fabrication on a
    // field an employer judges a CV by, so all three fields fall to null together.
    expect(parseEntryHeading('Data Engineer')).toEqual({ title: null, org: null, period: null });
  });

  it('returns nulls for an empty heading', () => {
    expect(parseEntryHeading('')).toEqual({ title: null, org: null, period: null });
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

  it('carries the job title from the entry heading onto every block under it', () => {
    // The title lives only in the markdown heading; nothing else in the fact graph has it,
    // and it must never be asked of the extraction model.
    const blocks = parseHeadingBlocks(MARKDOWN);
    const churn = blocks.find((b) => b.line.includes('Cut churn'));

    expect(churn).toEqual(expect.objectContaining({ title: 'Senior Developer' }));
  });

  it('leaves the title null in a section with no entry headings', () => {
    const blocks = parseHeadingBlocks(MARKDOWN);
    const python = blocks.find((b) => b.line.includes('Python'));

    expect(python).toEqual(expect.objectContaining({ title: null }));
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

  it('attaches the job title alongside section, org and period', () => {
    const [attached] = attachFactContext(MARKDOWN, [fact('Cut churn 23%', 0)]);

    expect(attached.title).toBe('Senior Developer');
  });

  it('leaves the title null when duplicate lines disagree about it', () => {
    // Same rule as org: no confident answer means null, never a majority guess.
    const markdown = [
      '## Experience',
      '',
      '### Lead — Acme Corp (2020)',
      '',
      '- Mentored juniors',
      '',
      '### Principal — Acme Corp (2020)',
      '',
      '- Mentored juniors',
    ].join('\n');

    const [attached] = attachFactContext(markdown, [fact('Mentored juniors', 0)]);

    expect(attached.title).toBeNull();
    // The org and period still agree, so they survive — fields are agreed independently.
    expect(attached.org).toBe('Acme Corp');
  });

  it('leaves the title null for a fact under no entry heading', () => {
    const [attached] = attachFactContext(MARKDOWN, [fact('Python', 0)]);

    expect(attached.title).toBeNull();
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

  it('does not change a fact id when only the job TITLE in the heading is edited', () => {
    // Same guarantee as org/period, pinned separately because `title` is a new field: a
    // promotion re-titling the heading (`Developer` -> `Senior Developer`) must not orphan
    // every fact under it and break the provenance links tailored CVs already hold.
    const { hashFactContent, matchFactIds } = require('./fact-identity');
    const withTitle = (title: string) =>
      ['## Experience', '', `### ${title} — Acme Corp (2019 – 2024)`, '', '- Cut churn 23%'].join('\n');

    const before = attachFactContext(withTitle('Developer'), [fact('Cut churn 23%', 0)]);
    const stored = before.map((f) => ({
      id: 'f1',
      contentHash: hashFactContent(f.text),
      position: f.position,
    }));

    const after = attachFactContext(withTitle('Senior Developer'), [fact('Cut churn 23%', 0)]);
    const matched = matchFactIds(stored, after);

    expect(matched[0].id).toBe('f1');
    expect(matched[0].isNew).toBe(false);
    // ...and the retitle really did land, so this is not a pass by derivation no-opping.
    expect(matched[0].title).toBe('Senior Developer');
    // And the hash itself is text-only: identical text under two different titles hashes the
    // same, which is what makes the id stable above.
    expect(hashFactContent(before[0].text)).toBe(hashFactContent(after[0].text));
  });
});
