import { renderToSupplementDocument } from './cv-document';
import { CvDocxService } from './cv-docx.service';
import { CvPdfService } from './cv-pdf.service';
import { buildCoverLetterMarkdown } from '../applications/cover-letter-render';

const LETTER = buildCoverLetterMarkdown({
  candidateName: 'Jane Doe',
  contactLine: 'jane@example.com | +420 777',
  jobTitle: 'Staff Engineer',
  company: 'Globex',
  paragraphs: ['I ran PostgreSQL in production.', 'I cut checkout latency to 220ms.'],
  language: 'en',
});

const SCREENING = [
  '# Screening Answers',
  '## Why us?',
  'I cut checkout latency to 220ms.',
  '## Do you hold a clearance?',
  '_No grounded answer._',
].join('\n\n');

describe('renderToSupplementDocument', () => {
  it('parses a cover letter into a titled block of prose', () => {
    const doc = renderToSupplementDocument(LETTER);

    expect(doc.title).toBe('Jane Doe');
    expect(doc.contactParts).toEqual(['jane@example.com', '+420 777']);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].heading).toBeNull();
    expect(doc.blocks[0].paragraphs).toContain('I ran PostgreSQL in production.');
  });

  it('keeps the salutation, opening, body and closing as prose, not as a header blob', () => {
    // Parsing a letter through renderToDocument does NOT raise — it silently collapses the
    // whole letter into contact.parts, which both writers render as one header blob. That
    // silent corruption is the reason this second shape exists.
    const doc = renderToSupplementDocument(LETTER);
    expect(doc.blocks[0].paragraphs).toContain('Dear Globex Hiring Team,');
    expect(doc.blocks[0].paragraphs).toContain('Sincerely,');
    expect(doc.contactParts).not.toContain('Dear Globex Hiring Team,');
  });

  it('parses screening answers into one block per question', () => {
    const doc = renderToSupplementDocument(SCREENING);

    expect(doc.title).toBe('Screening Answers');
    expect(doc.blocks.map((b) => b.heading)).toEqual(['Why us?', 'Do you hold a clearance?']);
    expect(doc.blocks[0].paragraphs).toEqual(['I cut checkout latency to 220ms.']);
  });

  it('keeps an unanswered question as a block with its explanation, never dropped', () => {
    const doc = renderToSupplementDocument(SCREENING);
    expect(doc.blocks[1].paragraphs).toHaveLength(1);
  });

  it('raises on markdown with no H1 rather than producing an untitled file', () => {
    // An untitled download the user cannot identify among their files is a silent failure.
    expect(() => renderToSupplementDocument('## Why us?\n\nAn answer.')).toThrow(/no "# Title"/);
  });

  it('is deterministic for identical input', () => {
    expect(renderToSupplementDocument(LETTER)).toEqual(renderToSupplementDocument(LETTER));
  });
});

describe('supplement export: one model, two writers', () => {
  it('renders a cover letter to PDF', async () => {
    const file = await new CvPdfService().renderSupplement(LETTER, 'cover-letter-r1');
    expect(file.mimeType).toBe('application/pdf');
    expect(file.filename).toBe('cover-letter-r1.pdf');
    expect(file.content.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('renders a cover letter to DOCX', async () => {
    const file = await new CvDocxService().renderSupplement(LETTER, 'cover-letter-r1');
    expect(file.filename).toBe('cover-letter-r1.docx');
    expect(file.content.subarray(0, 2).toString()).toBe('PK');
  });

  it('gives the PDF a stable sha256 across renders of identical content', async () => {
    // Artifact identity is the hash (spec 6.3). An unpinned CreationDate would break
    // idempotency here exactly as it did for the CV.
    const pdf = new CvPdfService();
    const first = await pdf.renderSupplement(LETTER, 'cover-letter-r1');
    const second = await pdf.renderSupplement(LETTER, 'cover-letter-r1');
    expect(second.sha256).toBe(first.sha256);
  });

  it('gives the DOCX a stable sha256 across renders of identical content', async () => {
    const docx = new CvDocxService();
    const first = await docx.renderSupplement(LETTER, 'cover-letter-r1');
    const second = await docx.renderSupplement(LETTER, 'cover-letter-r1');
    expect(second.sha256).toBe(first.sha256);
  });

  it('renders screening answers through both writers', async () => {
    const pdf = await new CvPdfService().renderSupplement(SCREENING, 'screening-r1');
    const docx = await new CvDocxService().renderSupplement(SCREENING, 'screening-r1');
    expect(pdf.content.length).toBeGreaterThan(0);
    expect(docx.content.length).toBeGreaterThan(0);
  });

  it('raises on an unencodable character in a supplement and points at DOCX', async () => {
    // Reuses the CV path's existing behaviour untouched: a "successful" PDF that silently
    // corrupted the candidate's name is the failure class this codebase forbids.
    const cjk = buildCoverLetterMarkdown({
      candidateName: '简历',
      contactLine: null,
      jobTitle: null,
      company: null,
      paragraphs: ['A paragraph.'],
      language: 'en',
    });

    await expect(new CvPdfService().renderSupplement(cjk, 'x')).rejects.toThrow(/DOCX instead/);
  });

  it('renders the same character set in DOCX that PDF refuses', async () => {
    // The message tells the user DOCX works. It must actually work, or the advice is wrong.
    const cjk = buildCoverLetterMarkdown({
      candidateName: '简历',
      contactLine: null,
      jobTitle: null,
      company: null,
      paragraphs: ['A paragraph.'],
      language: 'en',
    });

    const file = await new CvDocxService().renderSupplement(cjk, 'x');
    expect(file.content.length).toBeGreaterThan(0);
  });
});
