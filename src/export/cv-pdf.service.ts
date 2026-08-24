import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import PDFDocument = require('pdfkit');
import { CvDocument, renderToDocument } from './cv-document';

export interface RenderedFile {
  content: Buffer;
  sha256: string;
  mimeType: string;
  filename: string;
}

/**
 * Every WinAnsi (CP1252) code point, derived at runtime from Node's built-in decoder rather
 * than a hand-copied table — this IS the encoding pdfkit's Standard-14 fonts (Helvetica etc.)
 * are built on, so it is the authoritative "can this font render this character" answer.
 */
const WIN_ANSI_CODE_POINTS: ReadonlySet<number> = (() => {
  const decoder = new TextDecoder('windows-1252');
  const points = new Set<number>();
  for (let byte = 0; byte <= 0xff; byte++) {
    const char = decoder.decode(Uint8Array.of(byte));
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined) points.add(codePoint);
  }
  return points;
})();

/**
 * Single-column, real text layer — the shape ATS parses best (spec §6.2).
 *
 * No headless Chromium: a Chromium pod on the single node collides with the deploy-lock
 * serialization constraint, and pdfkit already produces the text layer that is the actual
 * requirement.
 */
@Injectable()
export class CvPdfService {
  async render(markdown: string, filenameBase: string): Promise<RenderedFile> {
    const document = renderToDocument(markdown);
    this.assertEncodable(document);

    const content = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `${document.contact.name} — CV`,
          Author: document.contact.name,
          // Pinned rather than left to default to `new Date()`: pdfkit hashes CreationDate
          // into the PDF trailer's /ID field, so a wall-clock CreationDate makes the sha256
          // of identical content differ on every render. That sha256 is load-bearing (spec
          // §6.3 — reused for artifact idempotency; Task 8 stores it on cv_artifact rows), so
          // this is a correctness fix, not cosmetic. Ideally this would be the render's own
          // timestamp, but render() takes no timestamp param — left for Task 8 to thread
          // through if it wants real CreationDate metadata.
          CreationDate: new Date(0),
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      this.write(doc, document);
      doc.end();
    });

    return {
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      mimeType: 'application/pdf',
      filename: `${filenameBase}.pdf`,
    };
  }

  /**
   * pdfkit's Standard-14 fonts (Helvetica here) only encode WinAnsi (CP1252): CJK, emoji, and
   * Arabic silently produce garbage glyph bytes instead of throwing (pdfkit's own `font.encode`
   * happily returns a bogus glyph id for an unmappable code point — verified directly, not
   * assumed). A "successful" render that has silently corrupted the candidate's name is exactly
   * the failure class this codebase forbids, so this is checked up front and raised loudly
   * before any PDF bytes are written, naming the offending characters. DOCX already renders
   * this content correctly (docx/OOXML is UTF-8 native), so the message names that path — the
   * failure is fully recoverable the same second it happens. Embedding a Unicode font (Noto
   * Sans / DejaVu) is the real fix; deferred as a scope, licence, and image-size decision for
   * whoever picks up Unicode PDF support, not something to guess at here.
   */
  private assertEncodable(cv: CvDocument): void {
    const strings = [
      cv.contact.name,
      ...cv.contact.parts,
      ...cv.sections.flatMap((section) => [
        section.heading,
        section.heading.toUpperCase(), // written form (see `write`) can differ in WinAnsi coverage
        ...section.entries.flatMap((entry) => [
          entry.title ?? '',
          entry.org ?? '',
          entry.period ?? '',
          ...entry.bullets,
        ]),
      ]),
    ];

    const unsupported = new Set<string>();
    for (const value of strings) {
      for (const char of value) {
        const codePoint = char.codePointAt(0);
        if (codePoint !== undefined && !WIN_ANSI_CODE_POINTS.has(codePoint)) {
          unsupported.add(char);
        }
      }
    }

    if (unsupported.size > 0) {
      const chars = [...unsupported].join(', ');
      throw new Error(
        `PDF export does not yet support these characters (${chars}); export DOCX instead, ` +
          'which renders them correctly.',
      );
    }
  }

  private write(doc: PDFKit.PDFDocument, cv: CvDocument): void {
    doc.fontSize(20).font('Helvetica-Bold').text(cv.contact.name);
    if (cv.contact.parts.length > 0) {
      doc.moveDown(0.3).fontSize(10).font('Helvetica').text(cv.contact.parts.join('  ·  '));
    }

    for (const section of cv.sections) {
      doc.moveDown(1).fontSize(13).font('Helvetica-Bold').text(section.heading.toUpperCase());
      doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).stroke();
      doc.moveDown(0.5);

      for (const entry of section.entries) {
        // Gated on title OR org, not title alone: a tailored entry (render-markdown.ts) is
        // identified by employer and period only, because no fact carries a job title.
        // Gating on the title dropped the employer off the page entirely — silently, which
        // is the failure class this codebase forbids. Nulls simply contribute nothing; no
        // value is ever borrowed from another entry to fill one in.
        const heading = [entry.title, entry.org].filter(Boolean).join(' — ');
        if (heading) {
          doc.fontSize(11).font('Helvetica-Bold').text(heading, { continued: Boolean(entry.period) });
          if (entry.period) {
            doc.font('Helvetica').fontSize(10).text(`  (${entry.period})`);
          }
        } else if (entry.period) {
          // A period with neither title nor org is real information the user's master CV
          // stated; printing it alone is honest, dropping it is a silent loss.
          doc.fontSize(10).font('Helvetica').text(`(${entry.period})`);
        }
        for (const bullet of entry.bullets) {
          doc.fontSize(10).font('Helvetica').text(`• ${bullet}`, { indent: 10 });
        }
        doc.moveDown(0.4);
      }
    }
  }
}
