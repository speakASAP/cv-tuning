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
        if (entry.title) {
          const heading = [entry.title, entry.org].filter(Boolean).join(' — ');
          doc.fontSize(11).font('Helvetica-Bold').text(heading, { continued: Boolean(entry.period) });
          if (entry.period) {
            doc.font('Helvetica').fontSize(10).text(`  (${entry.period})`);
          }
        }
        for (const bullet of entry.bullets) {
          doc.fontSize(10).font('Helvetica').text(`• ${bullet}`, { indent: 10 });
        }
        doc.moveDown(0.4);
      }
    }
  }
}
