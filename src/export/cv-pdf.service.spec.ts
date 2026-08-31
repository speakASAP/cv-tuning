import { spawnSync } from 'child_process';
import { CvPdfService } from './cv-pdf.service';

const CV = '# Jane Doe\njane@example.com\n\n## Experience\n### Dev — Acme (2020)\n- Ran PostgreSQL';

/**
 * `pdf-parse` v1.1.4 bundles an old pdf.js (v1.10.100) UMD build that throws
 * `UnknownErrorException: Invalid number` when loaded inside Jest's module runtime —
 * reproduced with a hand-written minimal PDF unrelated to pdfkit, and with a bare
 * `jest --config` outside this repo's ts-jest/NestJS setup, so it is not this project's
 * tsconfig or transform. The same buffer parses correctly under plain `node`. Running the
 * parse in a real child Node process sidesteps Jest's VM realm while keeping the test
 * itself under Jest, and is the only way found to assert real extracted text rather than
 * a length check.
 */
function extractPdfText(content: Buffer): string {
  const script = `
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', async () => {
      try {
        const parsed = await require(${JSON.stringify(require.resolve('pdf-parse'))})(Buffer.concat(chunks));
        process.stdout.write(parsed.text);
      } catch (e) {
        process.stderr.write(String(e && e.message ? e.message : e));
        process.exit(1);
      }
    });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { input: content, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`pdf-parse child process failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

describe('CvPdfService', () => {
  it('produces a real PDF', async () => {
    const { content } = await new CvPdfService().render(CV, 'jane-acme');
    expect(content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('produces an extractable text layer, which is the actual ATS requirement', async () => {
    const { content } = await new CvPdfService().render(CV, 'jane-acme');
    const text = extractPdfText(content);
    expect(text).toContain('Jane Doe');
    expect(text).toContain('Ran PostgreSQL');
  });

  it('returns a stable sha256 for identical input', async () => {
    const a = await new CvPdfService().render(CV, 'x');
    const b = await new CvPdfService().render(CV, 'x');
    expect(a.sha256).toBe(b.sha256);
  });

  it('returns a stable sha256 and byte-identical content seconds apart (artifact idempotency, spec §6.3)', async () => {
    const a = await new CvPdfService().render(CV, 'x');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const b = await new CvPdfService().render(CV, 'x');
    expect(a.sha256).toBe(b.sha256);
    expect(a.content.equals(b.content)).toBe(true);
  });

  it('names the file from the base it was given', async () => {
    const { filename } = await new CvPdfService().render(CV, 'jane-acme');
    expect(filename).toBe('jane-acme.pdf');
  });

  it('propagates a parse failure rather than emitting a blank PDF', async () => {
    await expect(new CvPdfService().render('   ', 'x')).rejects.toThrow(/empty/i);
  });

  it('raises rather than silently corrupting a name pdfkit\'s font cannot encode', async () => {
    const CV_CJK_NAME = '# 王小明\n\n## Experience\n### Dev — Acme (2020)\n- Ran PostgreSQL';
    await expect(new CvPdfService().render(CV_CJK_NAME, 'x')).rejects.toThrow(
      /does not yet support these characters.*王.*export DOCX instead/is,
    );
  });

  it('renders Czech and Cyrillic diacritics that the old WinAnsi-only Helvetica font could not', async () => {
    // Regression: these exact characters (em dash, Cyrillic, and ů) reached production and
    // turned Approve into a bare Internal Server Error because the previous Standard-14
    // Helvetica font only encoded WinAnsi (CP1252). DejaVu Sans covers all of them.
    const CV_ACCENTED = '# Jiří Novák\n\n## Experience\n### Důlnice — Привет s.r.o. (2020)\n- Zajišťuji včasnou reakci a monitoruji личный ticket';
    const { content } = await new CvPdfService().render(CV_ACCENTED, 'x');
    expect(content.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('CvPdfService: multi-section, title-less entries', () => {
  // Mirrors the DOCX case: the two writers share one document model, so a multi-section
  // render with employer-only entry headings must survive both or they have diverged.
  const MULTI = [
    '# Jane Doe',
    '',
    '## Experience',
    '### — Acme (2019-2024)',
    '- Cut checkout latency to 220ms',
    '### — Globex',
    '- Ran PostgreSQL in production',
    '',
    '## Other Highlights',
    '- Mentored two juniors',
  ].join('\n');

  it('puts every section, employer, period, and bullet in the extractable text layer', async () => {
    const { content } = await new CvPdfService().render(MULTI, 'x');
    const text = extractPdfText(content);
    for (const expected of [
      'EXPERIENCE',
      'Acme',
      '2019-2024',
      'Cut checkout latency to 220ms',
      'Globex',
      'Ran PostgreSQL in production',
      'OTHER HIGHLIGHTS',
      'Mentored two juniors',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('stays byte-stable across renders of a multi-section document (artifact idempotency, spec 6.3)', async () => {
    const a = await new CvPdfService().render(MULTI, 'x');
    const b = await new CvPdfService().render(MULTI, 'x');
    expect(a.sha256).toBe(b.sha256);
  });
});
