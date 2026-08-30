import { DocumentImporter, DOCX_MIME, PDF_MIME } from './document.importer';

describe('DocumentImporter', () => {
  let documents: { extract: jest.Mock };
  let importer: DocumentImporter;

  beforeEach(() => {
    documents = {
      extract: jest.fn(async () => ({ text: 'CV text', engine: 'pdf-text', ocrUsed: false, pages: 1 })),
    };
    importer = new DocumentImporter(documents as never);
  });

  it('reads a PDF through the shared document service', async () => {
    await expect(importer.extract(Buffer.from('%PDF'), PDF_MIME, 'cv.pdf')).resolves.toBe('CV text');
    expect(documents.extract).toHaveBeenCalledWith(expect.any(Buffer), PDF_MIME, 'cv.pdf');
  });

  it('reads a DOCX through the same path rather than a second parser stack', async () => {
    await importer.extract(Buffer.from('PK'), DOCX_MIME, 'cv.docx');

    expect(documents.extract).toHaveBeenCalledWith(expect.any(Buffer), DOCX_MIME, 'cv.docx');
  });

  it('accepts a scanned CV, which OCR can now read', () => {
    expect(DocumentImporter.isSupported('image/png')).toBe(true);
    expect(DocumentImporter.isSupported('image/jpeg')).toBe(true);
  });

  it('rejects an unsupported mime type by name', async () => {
    await expect(importer.extract(Buffer.from('x'), 'application/x-msdownload')).rejects.toThrow(
      /application\/x-msdownload/,
    );
    expect(documents.extract).not.toHaveBeenCalled();
  });

  it('rejects an empty upload before calling the document service', async () => {
    await expect(importer.extract(Buffer.alloc(0), PDF_MIME)).rejects.toThrow(/empty/);
    expect(documents.extract).not.toHaveBeenCalled();
  });

  it('surfaces the document service message so the user can act on it', async () => {
    documents.extract.mockRejectedValueOnce(
      new Error('no text could be extracted from this document.'),
    );

    await expect(importer.extract(Buffer.from('%PDF'), PDF_MIME)).rejects.toThrow(/no text could be extracted/);
  });

  it('stores an extension per supported type so the original stays identifiable', () => {
    expect(DocumentImporter.extensionFor(PDF_MIME)).toBe('pdf');
    expect(DocumentImporter.extensionFor('image/png')).toBe('png');
    expect(DocumentImporter.extensionFor('application/unknown')).toBe('bin');
  });

  it('returns recognised text for a scan instead of refusing it', async () => {
    documents.extract.mockResolvedValueOnce({
      text: 'Recognised CV text',
      engine: 'ocr',
      ocrUsed: true,
      pages: 2,
    });

    await expect(importer.extract(Buffer.from('%PDF'), PDF_MIME, 'scan.pdf')).resolves.toBe(
      'Recognised CV text',
    );
  });
});
