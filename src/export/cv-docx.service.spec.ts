import AdmZip = require('adm-zip');
import { CvDocxService } from './cv-docx.service';

const CV = '# Jane Doe\njane@example.com\n\n## Experience\n### Dev — Acme (2020)\n- Ran PostgreSQL';

describe('CvDocxService', () => {
  it('produces a real DOCX (a zip containing the document part)', async () => {
    const { content } = await new CvDocxService().render(CV, 'jane-acme');
    const names = new AdmZip(content).getEntries().map((e) => e.entryName);
    expect(names).toContain('word/document.xml');
  });

  it('writes the CV text into the document part', async () => {
    const { content } = await new CvDocxService().render(CV, 'jane-acme');
    const xml = new AdmZip(content).readAsText('word/document.xml');
    expect(xml).toContain('Jane Doe');
    expect(xml).toContain('Ran PostgreSQL');
  });

  it('names the file from the base it was given', async () => {
    const { filename } = await new CvDocxService().render(CV, 'jane-acme');
    expect(filename).toBe('jane-acme.docx');
  });

  it('propagates a parse failure rather than emitting a blank document', async () => {
    await expect(new CvDocxService().render('   ', 'x')).rejects.toThrow(/empty/i);
  });
});
