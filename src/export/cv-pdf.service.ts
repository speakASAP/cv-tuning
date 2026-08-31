import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { join } from 'path';
import * as fontkit from 'fontkit';
import PDFDocument = require('pdfkit');
import {
  CvDocument,
  SupplementDocument,
  renderToDocument,
  renderToSupplementDocument,
} from './cv-document';

export interface RenderedFile {
  content: Buffer;
  sha256: string;
  mimeType: string;
  filename: string;
}

/**
 * DejaVu Sans (permissive licence, see fonts/DejaVuSans-LICENSE.txt), embedded rather than
 * one of pdfkit's Standard-14 fonts. Standard-14 fonts (Helvetica etc.) only encode WinAnsi
 * (CP1252), which silently corrupted every non-Latin-1 character — CJK, Cyrillic, and even
 * ordinary Czech/Polish diacritics — into garbage glyph ids. DejaVu Sans covers Latin
 * Extended, Cyrillic, Greek, and general punctuation, which is the vast majority of real CV
 * content; only genuinely out-of-scope scripts (CJK, emoji, RTL) still need DOCX.
 */
const FONT_REGULAR_PATH = join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD_PATH = join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');
const FONT_REGULAR_NAME = 'DejaVuSans';
const FONT_BOLD_NAME = 'DejaVuSans-Bold';

// Opened once and reused: fontkit parses the whole glyph table on open, and every render and
// every encodability check needs it, so re-opening per call would be a needless repeated cost.
let cachedRegularFont: fontkit.Font | undefined;
function regularFont(): fontkit.Font {
  if (!cachedRegularFont) cachedRegularFont = fontkit.openSync(FONT_REGULAR_PATH) as fontkit.Font;
  return cachedRegularFont;
}

/**
 * Whether the embedded font has a real glyph -- not the ".notdef" placeholder -- for a code
 * point. This is the authoritative "can this font render this character" answer for whichever
 * font is actually embedded, replacing a hand-copied WinAnsi table that only ever described
 * Helvetica.
 */
function hasGlyph(codePoint: number): boolean {
  return regularFont().glyphForCodePoint(codePoint).id !== 0;
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

      doc.registerFont(FONT_REGULAR_NAME, FONT_REGULAR_PATH);
      doc.registerFont(FONT_BOLD_NAME, FONT_BOLD_PATH);
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
   * codebase forbids, so every character is checked against DejaVu Sans's real glyph table up
   * front and raised loudly before any PDF bytes are written, naming the offending characters.
   * DOCX already renders this content correctly (docx/OOXML is UTF-8 native), so the message
   * names that path — the failure is fully recoverable the same second it happens. Remaining
   * gaps (CJK, emoji, RTL scripts) are a font-coverage decision, not something to guess at here.
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
      for (const char of value) {
        const codePoint = char.codePointAt(0);
        if (codePoint !== undefined && !hasGlyph(codePoint)) {
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
    doc.fontSize(20).font(FONT_BOLD_NAME).text(cv.contact.name);
    if (cv.contact.parts.length > 0) {
      doc.moveDown(0.3).fontSize(10).font(FONT_REGULAR_NAME).text(cv.contact.parts.join('  ·  '));
    }

    for (const section of cv.sections) {
      doc.moveDown(1).fontSize(13).font(FONT_BOLD_NAME).text(section.heading.toUpperCase());
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
          doc.fontSize(11).font(FONT_BOLD_NAME).text(heading, { continued: Boolean(entry.period) });
          if (entry.period) {
            doc.font(FONT_REGULAR_NAME).fontSize(10).text(`  (${entry.period})`);
          }
        } else if (entry.period) {
          // A period with neither title nor org is real information the user's master CV
          // stated; printing it alone is honest, dropping it is a silent loss.
          doc.fontSize(10).font(FONT_REGULAR_NAME).text(`(${entry.period})`);
        }
        for (const bullet of entry.bullets) {
          doc.fontSize(10).font(FONT_REGULAR_NAME).text(`• ${bullet}`, { indent: 10 });
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

      doc.registerFont(FONT_REGULAR_NAME, FONT_REGULAR_PATH);
      doc.registerFont(FONT_BOLD_NAME, FONT_BOLD_PATH);
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
      for (const char of value) {
        const codePoint = char.codePointAt(0);
        if (codePoint !== undefined && !hasGlyph(codePoint)) {
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

  private writeSupplement(doc: PDFKit.PDFDocument, document: SupplementDocument): void {
    doc.fontSize(20).font(FONT_BOLD_NAME).text(document.title);
    if (document.contactParts.length > 0) {
      doc.moveDown(0.3).fontSize(10).font(FONT_REGULAR_NAME).text(document.contactParts.join('  ·  '));
    }

    for (const block of document.blocks) {
      if (block.heading) {
        doc.moveDown(1).fontSize(12).font(FONT_BOLD_NAME).text(block.heading);
        doc.moveDown(0.3);
      } else {
        doc.moveDown(0.8);
      }
      for (const paragraph of block.paragraphs) {
        doc.fontSize(10).font(FONT_REGULAR_NAME).text(paragraph);
        doc.moveDown(0.4);
      }
    }
  }

}
