import { NotFoundException } from '@nestjs/common';
import { MasterCvController } from './master-cv.controller';

const authed = (id = 'u1') => ({ user: { id, email: 'a@b.c' } }) as never;

describe('MasterCvController', () => {
  let service: any;
  let gdocs: any;
  let documents: any;
  let linkedin: any;
  let storage: any;
  let controller: MasterCvController;
  let consent: any;

  beforeEach(() => {
    service = {
      save: jest.fn(async () => ({
        master: { id: 'm1', version: 1, markdown: '# CV' },
        factDiff: { added: [], removed: [], kept: 0 },
      })),
      getCurrent: jest.fn(async () => null),
    };
    gdocs = { fetchMarkdown: jest.fn(async () => '# CV from docs') };
    documents = { extract: jest.fn(async () => '# CV from file') };
    linkedin = { toMarkdown: jest.fn(() => '# CV from linkedin') };
    storage = { putObject: jest.fn(async (key: string) => key) };
    consent = { get: jest.fn(async () => ({ userId: 'u1', consentVersion: '2026-08-27' })), grant: jest.fn(async () => ({ userId: 'u1', consentVersion: '2026-08-27' })) };
    controller = new MasterCvController(service, gdocs, documents, linkedin, storage, consent);
  });

  it('reads consent only for the authenticated user', async () => {
    await controller.getConsent(authed('real-user'));
    expect(consent.get).toHaveBeenCalledWith('real-user');
  });

  it('records explicit consent for the authenticated user', async () => {
    await controller.grantConsent(authed('real-user'));
    expect(consent.grant).toHaveBeenCalledWith('real-user');
  });

  it('saves pasted markdown for the authenticated user', async () => {
    await controller.save(authed(), { markdown: '# CV' } as never);

    expect(service.save).toHaveBeenCalledWith('u1', '# CV', 'paste', undefined);
  });

  it('returns the fact diff so the user can confirm it', async () => {
    const result = await controller.save(authed(), { markdown: '# CV' } as never);

    expect(result.factDiff).toBeDefined();
  });

  it('never saves under a user id taken from the request body', async () => {
    await controller.save(authed('real-user'), { markdown: '# CV', userId: 'attacker' } as never);

    expect(service.save).toHaveBeenCalledWith('real-user', '# CV', 'paste', undefined);
  });

  it('404s when the user has no master CV', async () => {
    await expect(controller.getCurrent(authed())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the current master as a flat view, without internals', async () => {
    service.getCurrent.mockResolvedValueOnce({
      master: {
        id: 'm2',
        userId: 'u1',
        version: 2,
        markdown: '# CV',
        sourceType: 'gdocs',
        createdAt: new Date('2026-08-30T00:00:00Z'),
        factsExtractedFromMarkdownSha: 'sha-abc',
        isCurrent: true,
      },
      facts: [{ factId: 'f1' }, { factId: 'f2' }],
    });

    const view = await controller.getCurrent(authed());

    // Flat, because the client reads `markdown` and `version` off the response itself.
    expect(view).toEqual({
      id: 'm2',
      version: 2,
      markdown: '# CV',
      sourceType: 'gdocs',
      createdAt: new Date('2026-08-30T00:00:00Z'),
      factCount: 2,
    });
    // Internals stay server-side: the browser has no use for them and they leak ownership.
    expect(Object.keys(view)).not.toContain('factsExtractedFromMarkdownSha');
    expect(Object.keys(view)).not.toContain('userId');
    expect(Object.keys(view)).not.toContain('facts');
  });

  it('404s the facts view when the user has no master CV', async () => {
    await expect(controller.getFacts(authed())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns only the facts from the facts view', async () => {
    service.getCurrent.mockResolvedValueOnce({ master: { version: 1 }, facts: [{ factId: 'f1', text: 'a' }] });

    const facts = await controller.getFacts(authed());

    expect(facts).toEqual([{ factId: 'f1', text: 'a' }]);
  });

  it('imports from a Google Docs link and records the source', async () => {
    await controller.importGdocs(authed(), { url: 'https://docs.google.com/document/d/abc/edit' } as never);

    expect(gdocs.fetchMarkdown).toHaveBeenCalledWith('https://docs.google.com/document/d/abc/edit');
    expect(service.save).toHaveBeenCalledWith(
      'u1',
      '# CV from docs',
      'gdocs',
      'https://docs.google.com/document/d/abc/edit',
    );
  });

  it('does not save anything when the Google Docs fetch fails', async () => {
    gdocs.fetchMarkdown.mockRejectedValueOnce(new Error('not publicly accessible'));

    await expect(
      controller.importGdocs(authed(), { url: 'https://docs.google.com/document/d/abc/edit' } as never),
    ).rejects.toThrow(/not publicly accessible/);
    expect(service.save).not.toHaveBeenCalled();
  });

  it('rejects an upload with no file', async () => {
    await expect(controller.importUpload(authed(), undefined)).rejects.toThrow(/no file/i);
  });

  it('rejects an unsupported upload type by name', async () => {
    const file = { buffer: Buffer.from('x'), mimetype: 'application/x-msdownload', originalname: 'cv.exe', size: 1 };

    await expect(controller.importUpload(authed(), file as never)).rejects.toThrow(/x-msdownload/);
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('accepts a photographed or scanned CV, which OCR reads', async () => {
    const file = { buffer: Buffer.from('\x89PNG'), mimetype: 'image/png', originalname: 'cv.png', size: 4 };

    await controller.importUpload(authed(), file as never);

    expect(service.save).toHaveBeenCalledWith('u1', '# CV from file', 'upload', expect.stringMatching(/\.png$/));
  });

  it('stores the original upload before parsing it', async () => {
    const file = { buffer: Buffer.from('%PDF'), mimetype: 'application/pdf', originalname: 'cv.pdf', size: 4 };

    await controller.importUpload(authed(), file as never);

    // Storing first is what makes a later extraction failure diagnosable.
    expect(storage.putObject).toHaveBeenCalled();
    const key = storage.putObject.mock.calls[0][0];
    expect(key).toMatch(/^u1\/[0-9a-f-]{36}\.pdf$/);
    expect(service.save).toHaveBeenCalledWith('u1', '# CV from file', 'upload', key);
  });

  it('keeps the stored original when extraction fails', async () => {
    documents.extract.mockRejectedValueOnce(new Error('no extractable text'));
    const file = { buffer: Buffer.from('%PDF'), mimetype: 'application/pdf', originalname: 'cv.pdf', size: 4 };

    await expect(controller.importUpload(authed(), file as never)).rejects.toThrow(/no extractable text/);
    expect(storage.putObject).toHaveBeenCalled();
    expect(service.save).not.toHaveBeenCalled();
  });
});
