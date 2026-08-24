import { LinkedinImporter, splitDescription } from './linkedin.importer';
import { extractH1Name } from '../../applications/render-markdown';

const csv = (rows: string[]) => rows.join('\n');

const PROFILE = csv(['First Name,Last Name', 'Ada,Lovelace']);

describe('LinkedinImporter', () => {
  const importer = new LinkedinImporter();

  const archive = (entries: Record<string, string>) => ({
    getEntries: () => Object.entries(entries).map(([entryName, body]) => ({
      entryName,
      isDirectory: false,
      getData: () => Buffer.from(body),
    })),
  });

  it('converts positions into markdown role sections', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': csv([
        'Company Name,Title,Description,Started On,Finished On',
        'Acme,Senior Developer,Built things,Jan 2020,Dec 2022',
      ]),
    });

    const markdown = importer.toMarkdown(zip as never);

    expect(markdown).toContain('Senior Developer');
    expect(markdown).toContain('Acme');
    expect(markdown).toContain('Built things');
  });

  it('includes skills when the archive has them', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': csv(['Company Name,Title', 'Acme,Dev']),
      'Skills.csv': csv(['Name', 'TypeScript', 'PostgreSQL']),
    });

    const markdown = importer.toMarkdown(zip as never);

    expect(markdown).toContain('TypeScript');
    expect(markdown).toContain('PostgreSQL');
  });

  it('raises naming the missing file when Positions.csv is absent', () => {
    const zip = archive({ 'Skills.csv': csv(['Name', 'TypeScript']) });

    expect(() => importer.toMarkdown(zip as never)).toThrow(/Positions\.csv/);
  });

  it('raises on an archive with no entries at all', () => {
    expect(() => importer.toMarkdown(archive({}) as never)).toThrow(/Positions\.csv/);
  });

  it('raises when Positions.csv has a header but no rows', () => {
    const zip = archive({ 'Profile.csv': PROFILE, 'Positions.csv': csv(['Company Name,Title']) });

    // An export with no positions must not silently become an empty CV.
    expect(() => importer.toMarkdown(zip as never)).toThrow(/no positions/i);
  });

  it('emits the candidate name as the single H1 so generate() can read it', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': csv(['Company Name,Title', 'Acme,Dev']),
      'Skills.csv': csv(['Name', 'TypeScript']),
    });

    const markdown = importer.toMarkdown(zip as never);

    // The real regression: a LinkedIn import used to emit `# Experience` / `# Skills` and
    // no name, so the first generate() died on MissingMasterNameError. Asserting through
    // extractH1Name pins the actual downstream contract, not just the string shape.
    expect(extractH1Name(markdown)).toBe('Ada Lovelace');
    expect(markdown.startsWith('# Ada Lovelace')).toBe(true);
    expect(markdown).toContain('## Experience');
    expect(markdown).toContain('## Skills');
    expect(markdown).not.toMatch(/^# (Experience|Skills)$/m);
  });

  it('raises naming Profile.csv when the archive carries no name', () => {
    const zip = archive({ 'Positions.csv': csv(['Company Name,Title', 'Acme,Dev']) });

    expect(() => importer.toMarkdown(zip as never)).toThrow(/Profile\.csv/);
  });

  it('raises rather than inventing a name when Profile.csv has blank name fields', () => {
    const zip = archive({
      'Profile.csv': csv(['First Name,Last Name', ',']),
      'Positions.csv': csv(['Company Name,Title', 'Acme,Dev']),
    });

    expect(() => importer.toMarkdown(zip as never)).toThrow(/no First Name or Last Name/);
  });

  it('handles quoted fields containing commas', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': csv([
        'Company Name,Title,Description',
        'Acme,"Engineer, Senior","Did A, B, and C"',
      ]),
    });

    const markdown = importer.toMarkdown(zip as never);

    expect(markdown).toContain('Engineer, Senior');
    expect(markdown).toContain('Did A, B, and C');
  });

  // --- Description granularity (fact granularity, spec §6) -------------------------------
  //
  // LinkedIn's Positions.csv `Description` is a free-text prose blob. Emitted as one
  // paragraph it extracts as ONE giant fact per role, so every tailored bullet binds to the
  // same `sourceFactId` and `entail.service.ts` ends up checking a single sentence against a
  // whole paragraph — the two-layer grounding guarantee degrades to noise. Each of these
  // asserts the markdown carries one list item per discrete claim.

  const bulletsOf = (markdown: string) =>
    markdown
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2));

  it('splits a multi-sentence prose description into one bullet per sentence', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': csv([
        'Company Name,Title,Description',
        'Acme,Dev,"Built the billing service. Cut churn by 23%. Mentored two juniors."',
      ]),
    });

    expect(bulletsOf(importer.toMarkdown(zip as never))).toEqual([
      'Built the billing service.',
      'Cut churn by 23%.',
      'Mentored two juniors.',
    ]);
  });

  it('keeps a genuinely single-sentence description as exactly one bullet', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': csv(['Company Name,Title,Description', 'Acme,Dev,Built the billing service.']),
    });

    // Over-splitting is as harmful as under-splitting: a fact fragment grounds nothing.
    expect(bulletsOf(importer.toMarkdown(zip as never))).toEqual(['Built the billing service.']);
  });

  it('does not split on abbreviations, decimals, or initials', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': csv([
        'Company Name,Title,Description',
        'Acme,Dev,"Grew revenue 12.5% e.g. via upsell. Reported to J. R. Smith, i.e. the CTO."',
      ]),
    });

    // A naive split on "." shatters "12.5", "e.g.", and "J. R." into fact fragments that
    // entailment can never match back to a real claim.
    expect(bulletsOf(importer.toMarkdown(zip as never))).toEqual([
      'Grew revenue 12.5% e.g. via upsell.',
      'Reported to J. R. Smith, i.e. the CTO.',
    ]);
  });

  it('preserves an existing bullet structure instead of re-splitting its sentences', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': csv([
        'Company Name,Title,Description',
        'Acme,Dev,"• Ran the migration. It took six months.\n• Owned the on-call rota."',
      ]),
    });

    // When the author already chose the granularity, that choice IS the fact boundary —
    // re-splitting it would break up a claim the candidate wrote as one unit.
    expect(bulletsOf(importer.toMarkdown(zip as never))).toEqual([
      'Ran the migration. It took six months.',
      'Owned the on-call rota.',
    ]);
  });

  it('treats a newline-separated description as pre-split even without bullet characters', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': csv([
        'Company Name,Title,Description',
        'Acme,Dev,"Ran the migration\nOwned the on-call rota"',
      ]),
    });

    expect(bulletsOf(importer.toMarkdown(zip as never))).toEqual([
      'Ran the migration',
      'Owned the on-call rota',
    ]);
  });

  it('reads a quoted description that spans multiple CSV lines as one position', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': 'Company Name,Title,Description\nAcme,Dev,"Line one.\nLine two."',
    });

    const markdown = importer.toMarkdown(zip as never);

    // The line-at-a-time CSV reader used to shred an embedded newline into a phantom
    // second position (`### Role — Line two.`), inventing a job the candidate never had.
    expect(markdown.match(/^### .*$/gm)).toEqual(['### Dev — Acme']);
    expect(bulletsOf(markdown)).toEqual(['Line one.', 'Line two.']);
  });

  it('produces exactly one H1 even when descriptions contain markdown-looking text', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': csv([
        'Company Name,Title,Description',
        'Acme,Dev,"# Not a heading. Neither is ## this."',
      ]),
    });

    const markdown = importer.toMarkdown(zip as never);

    // Description text is data, not markup: a bare "#" line would add a second H1 and
    // extractH1Name would then reject the whole master CV as nameless. The `- ` list
    // prefix is what makes it literal.
    expect(extractH1Name(markdown)).toBe('Ada Lovelace');
  });

  it('leaves markdown-significant characters in a claim unescaped and readable', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': csv(['Company Name,Title,Description', 'Acme,Dev,"#1 seller. 50% > target."']),
    });

    const markdown = importer.toMarkdown(zip as never);

    // Inside a list item these are already literal, so escaping them would only leak
    // backslashes into the fact text and from there onto a CV an employer reads.
    expect(bulletsOf(markdown)).toEqual(['#1 seller.', '50% > target.']);
    expect(markdown).not.toContain('\\');
    expect(extractH1Name(markdown)).toBe('Ada Lovelace');
  });

  it('emits no bullets and no blank list item for an empty description', () => {
    const zip = archive({
      'Profile.csv': PROFILE,
      'Positions.csv': csv(['Company Name,Title,Description', 'Acme,Dev,   ']),
    });

    expect(bulletsOf(importer.toMarkdown(zip as never))).toEqual([]);
  });

  it('is stable across re-import, so fact content hashes and provenance survive', () => {
    const zip = () =>
      archive({
        'Profile.csv': PROFILE,
        'Positions.csv': csv([
          'Company Name,Title,Description',
          'Acme,Dev,"Built the billing service. Cut churn by 23%."',
        ]),
      });

    // fact-identity.ts re-matches ids by content hash + position. Non-deterministic output
    // would orphan every fact on re-import and silently invalidate existing provenance.
    expect(importer.toMarkdown(zip() as never)).toBe(importer.toMarkdown(zip() as never));
  });
});

describe('splitDescription', () => {
  it('returns an empty array for blank input rather than one empty claim', () => {
    expect(splitDescription('   \n  ')).toEqual([]);
  });

  it('strips -, *, and • markers without eating a leading hyphenated word', () => {
    expect(splitDescription('- Ran it\n* Owned it\n• Shipped it')).toEqual([
      'Ran it',
      'Owned it',
      'Shipped it',
    ]);
  });

  it('keeps a trailing sentence that has no terminal punctuation', () => {
    expect(splitDescription('Shipped v1. Then shipped v2')).toEqual(['Shipped v1.', 'Then shipped v2']);
  });

  it('splits on ? and ! as well as .', () => {
    expect(splitDescription('Why rebuild it? We did anyway! Twice.')).toEqual([
      'Why rebuild it?',
      'We did anyway!',
      'Twice.',
    ]);
  });

  it('drops a fragment that is only punctuation or whitespace', () => {
    expect(splitDescription('Shipped it.  .  \n\n')).toEqual(['Shipped it.']);
  });
});
