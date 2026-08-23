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
    controller = new MasterCvController(service, gdocs, documents, linkedin, storage);
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

  it('returns the current master when it exists', async () => {
    service.getCurrent.mockResolvedValueOnce({ master: { version: 2 }, facts: [] });

    await expect(controller.getCurrent(authed())).resolves.toMatchObject({ master: { version: 2 } });
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
    const file = { buffer: Buffer.from('x'), mimetype: 'image/png', originalname: 'cv.png', size: 1 };

    await expect(controller.importUpload(authed(), file as never)).rejects.toThrow(/image\/png/);
    expect(storage.putObject).not.toHaveBeenCalled();
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
