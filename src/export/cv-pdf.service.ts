import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import PDFDocument = require('pdfkit');
import {
  CvDocument,
  SupplementDocument,
  renderToDocument,
  renderToSupplementDocument,
} from './cv-document';
import { registerFontFamilies, unsupportedClusters, writeRun, segment } from './rich-text';

export interface RenderedFile {
  content: Buffer;
  sha256: string;
  mimeType: string;
  filename: string;
}

/** Checks whether any text segment(s) would need pdfkit's manual, image-aware layout path. */
function hasEmoji(...values: (string | null | undefined)[]): boolean {
  return values.some((value) => value != null && segment(value).some((entry) => entry.kind === 'image'));
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

      registerFontFamilies(doc);
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
   * pdfkit's own `font.encode` happily returns a bogus glyph id for a code point the embedded
   * font has no glyph for, instead of throwing (verified directly, not assumed). A "successful"
   * render that has silently corrupted the candidate's name is exactly the failure class this
   * codebase forbids, so every character is checked up front, against every embedded font
   * (Latin, CJK, Arabic, Hebrew) and the emoji raster fallback, and raised loudly before any
   * PDF bytes are written, naming the offending characters. `unsupportedClusters` (rich-text.ts)
   * is the exact same segmentation `write()` uses to render, so this check and the renderer can
   * never silently disagree about what is and is not supported.
   */
  private assertEncodable(cv: CvDocument): void {
    const strings = [
      cv.contact.name,
      ...cv.contact.parts,
      ...cv.sections.flatMap((section) => [
        section.heading,
        section.heading.toUpperCase(), // written form (see `write`) can differ in glyph coverage
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
      for (const cluster of unsupportedClusters(value)) {
        unsupported.add(cluster);
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
    writeRun(doc, cv.contact.name, { size: 20, bold: true });
    if (cv.contact.parts.length > 0) {
      doc.moveDown(0.3);
      writeRun(doc, cv.contact.parts.join('  ·  '), { size: 10 });
    }

    for (const section of cv.sections) {
      doc.moveDown(1);
      writeRun(doc, section.heading.toUpperCase(), { size: 13, bold: true });
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
          // pdfkit's own `continued` text run cannot resume correctly after a call that used
          // the manual, image-aware layout path (see rich-text.ts) — its internal notion of
          // "current position" is only meaningful between two ordinary `doc.text()` calls. An
          // emoji in a job title/company is vanishingly rare, so that combination falls back
          // to two independent lines instead, which never overlaps or misplaces text.
          const canChain = entry.period ? !hasEmoji(heading, entry.period) : true;
          writeRun(doc, heading, { size: 11, bold: true, continued: canChain && Boolean(entry.period) });
          if (entry.period) {
            writeRun(doc, canChain ? `  (${entry.period})` : `(${entry.period})`, { size: 10 });
          }
        } else if (entry.period) {
          // A period with neither title nor org is real information the user's master CV
          // stated; printing it alone is honest, dropping it is a silent loss.
          writeRun(doc, `(${entry.period})`, { size: 10 });
        }
        for (const bullet of entry.bullets) {
          writeRun(doc, `• ${bullet}`, { size: 10, indent: 10 });
        }
        doc.moveDown(0.4);
      }
    }
  }

  /**
   * Renders a supplement (cover letter or screening answers) rather than a CV.
   *
   * Same pinned `CreationDate`, same glyph-coverage pre-check, same sha256 contract — a supplement's
   * artifact identity is its hash exactly as a CV's is (spec §6.3), so an unpinned timestamp
   * would break idempotency here for the same reason it did there.
   */
  async renderSupplement(markdown: string, filenameBase: string): Promise<RenderedFile> {
    const document = renderToSupplementDocument(markdown);
    this.assertSupplementEncodable(document);

    const content = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: { Title: document.title, Author: document.title, CreationDate: new Date(0) },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      registerFontFamilies(doc);
      this.writeSupplement(doc, document);
      doc.end();
    });

    return {
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      mimeType: 'application/pdf',
      filename: `${filenameBase}.pdf`,
    };
  }

  /** Same rule and same message as `assertEncodable`, over the supplement's own strings. */
  private assertSupplementEncodable(document: SupplementDocument): void {
    const strings = [
      document.title,
      ...document.contactParts,
      ...document.blocks.flatMap((block) => [block.heading ?? '', ...block.paragraphs]),
    ];

    const unsupported = new Set<string>();
    for (const value of strings) {
      for (const cluster of unsupportedClusters(value)) {
        unsupported.add(cluster);
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

  private writeSupplement(doc: PDFKit.PDFDocument, document: SupplementDocument): void {
    writeRun(doc, document.title, { size: 20, bold: true });
    if (document.contactParts.length > 0) {
      doc.moveDown(0.3);
      writeRun(doc, document.contactParts.join('  ·  '), { size: 10 });
    }

    for (const block of document.blocks) {
      if (block.heading) {
        doc.moveDown(1);
        writeRun(doc, block.heading, { size: 12, bold: true });
        doc.moveDown(0.3);
      } else {
        doc.moveDown(0.8);
      }
      for (const paragraph of block.paragraphs) {
        writeRun(doc, paragraph, { size: 10 });
        doc.moveDown(0.4);
      }
    }
  }
}
