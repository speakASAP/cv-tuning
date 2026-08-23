import { GdocsImporter } from './gdocs.importer';

describe('GdocsImporter.exportUrl', () => {
  it('converts an edit URL to the plain-text export URL', () => {
    expect(GdocsImporter.exportUrl('https://docs.google.com/document/d/abc123/edit?usp=sharing')).toBe(
      'https://docs.google.com/document/d/abc123/export?format=txt',
    );
  });

  it('accepts a bare document URL with no trailing path', () => {
    expect(GdocsImporter.exportUrl('https://docs.google.com/document/d/abc123')).toBe(
      'https://docs.google.com/document/d/abc123/export?format=txt',
    );
  });

  it('rejects a non-Google-Docs URL', () => {
    expect(() => GdocsImporter.exportUrl('https://example.com/cv')).toThrow(/google docs/i);
  });

  it('rejects a Google Drive file URL, which exports differently', () => {
    expect(() => GdocsImporter.exportUrl('https://drive.google.com/file/d/abc/view')).toThrow(/google docs/i);
  });
});

describe('GdocsImporter.fetchMarkdown', () => {
  it('returns the document text', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, text: async () => '# My CV\n- Did things' }));
    const importer = new GdocsImporter(fetchMock as never);

    await expect(importer.fetchMarkdown('https://docs.google.com/document/d/abc/edit')).resolves.toBe(
      '# My CV\n- Did things',
    );
  });

  it('raises a clear error when the document is not link-shared', async () => {
    const fetchMock = jest.fn(async () => ({ ok: false, status: 401, text: async () => 'login required' }));
    const importer = new GdocsImporter(fetchMock as never);

    // v1 supports link-shared docs only; private docs need OAuth, which is not built.
    await expect(importer.fetchMarkdown('https://docs.google.com/document/d/abc/edit')).rejects.toThrow(
      /link-shared|not publicly accessible/i,
    );
  });

  it('raises on 403 with the same guidance', async () => {
    const fetchMock = jest.fn(async () => ({ ok: false, status: 403, text: async () => 'forbidden' }));
    const importer = new GdocsImporter(fetchMock as never);

    await expect(importer.fetchMarkdown('https://docs.google.com/document/d/abc/edit')).rejects.toThrow(
      /link-shared|not publicly accessible/i,
    );
  });

  it('raises rather than returning an empty CV when the export is blank', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, text: async () => '   ' }));
    const importer = new GdocsImporter(fetchMock as never);

    await expect(importer.fetchMarkdown('https://docs.google.com/document/d/abc/edit')).rejects.toThrow(/empty/i);
  });

  it('raises on a transport failure naming Google Docs', async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    const importer = new GdocsImporter(fetchMock as never);

    await expect(importer.fetchMarkdown('https://docs.google.com/document/d/abc/edit')).rejects.toThrow(
      /google docs.*ETIMEDOUT/is,
    );
  });
});
