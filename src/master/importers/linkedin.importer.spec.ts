import { LinkedinImporter } from './linkedin.importer';
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
});
