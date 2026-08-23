import { DocumentImporter } from './document.importer';

describe('DocumentImporter', () => {
  let importer: DocumentImporter;
  let parsePdf: jest.Mock;
  let parseDocx: jest.Mock;

  beforeEach(() => {
    parsePdf = jest.fn(async () => ({ text: 'CV text from pdf' }));
    parseDocx = jest.fn(async () => ({ value: 'CV text from docx' }));
    importer = new DocumentImporter(parsePdf as never, parseDocx as never);
  });

  it('extracts text from a PDF', async () => {
    await expect(importer.extract(Buffer.from('%PDF'), 'application/pdf')).resolves.toBe('CV text from pdf');
  });

  it('extracts text from a DOCX', async () => {
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    await expect(importer.extract(Buffer.from('PK'), mime)).resolves.toBe('CV text from docx');
  });

  it('accepts plain text directly without a parser', async () => {
    await expect(importer.extract(Buffer.from('# My CV'), 'text/plain')).resolves.toBe('# My CV');
    expect(parsePdf).not.toHaveBeenCalled();
    expect(parseDocx).not.toHaveBeenCalled();
  });

  it('rejects an unsupported mime type by name', async () => {
    await expect(importer.extract(Buffer.from('x'), 'image/png')).rejects.toThrow(/image\/png/);
  });

  it('raises when a PDF has no text layer rather than returning an empty CV', async () => {
    // A scanned CV parses "successfully" to an empty string. Treating that as a valid
    // empty CV would silently wipe the user's document.
    parsePdf.mockResolvedValueOnce({ text: '   ' });

    await expect(importer.extract(Buffer.from('%PDF'), 'application/pdf')).rejects.toThrow(/no extractable text/i);
  });

  it('raises when a DOCX extracts to nothing', async () => {
    parseDocx.mockResolvedValueOnce({ value: '' });
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    await expect(importer.extract(Buffer.from('PK'), mime)).rejects.toThrow(/no extractable text/i);
  });

  it('raises with context when the PDF parser itself throws', async () => {
    parsePdf.mockRejectedValueOnce(new Error('corrupt xref table'));

    await expect(importer.extract(Buffer.from('%PDF'), 'application/pdf')).rejects.toThrow(/corrupt xref table/);
  });

  it('rejects an empty upload before attempting to parse it', async () => {
    await expect(importer.extract(Buffer.alloc(0), 'application/pdf')).rejects.toThrow(/empty/i);
    expect(parsePdf).not.toHaveBeenCalled();
  });

  it('reports the extension for a given mime type', () => {
    expect(DocumentImporter.extensionFor('application/pdf')).toBe('pdf');
    expect(
      DocumentImporter.extensionFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('docx');
  });
});
