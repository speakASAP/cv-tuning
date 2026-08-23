import { LinkedinImporter } from './linkedin.importer';

const csv = (rows: string[]) => rows.join('\n');

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
    const zip = archive({ 'Positions.csv': csv(['Company Name,Title']) });

    // An export with no positions must not silently become an empty CV.
    expect(() => importer.toMarkdown(zip as never)).toThrow(/no positions/i);
  });

  it('handles quoted fields containing commas', () => {
    const zip = archive({
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
