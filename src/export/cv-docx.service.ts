import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import AdmZip = require('adm-zip');
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import {
  CvDocument,
  SupplementDocument,
  renderToDocument,
  renderToSupplementDocument,
} from './cv-document';
import { RenderedFile } from './cv-pdf.service';

const EPOCH_W3CDTF = '1970-01-01T00:00:00.000Z';
const CORE_PROPS_ENTRY = 'docProps/core.xml';
/** DOS epoch: adm-zip clamps anything below this to 1980-01-01 anyway, so this is its floor. */
const EPOCH_DATE = new Date(0);

/**
 * Same document model as the PDF writer, different container. DOCX often parses better in
 * ATS than PDF, so it is not optional (spec §6.2).
 */
@Injectable()
export class CvDocxService {
  async render(markdown: string, filenameBase: string): Promise<RenderedFile> {
    const document = renderToDocument(markdown);
    const raw = await Packer.toBuffer(
      new Document({ sections: [{ children: this.paragraphs(document) }] }),
    );
    const content = this.pinTimestamps(raw);

    return {
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${filenameBase}.docx`,
    };
  }

  /**
   * `docx@9.7.1`'s `CoreProperties` class writes `dcterms:created`/`dcterms:modified` from
   * `new Date()` unconditionally — verified directly by reading `dist/index.cjs`: the
   * `Document` constructor's `created`/`modified` options are declared in the `.d.ts` but
   * never read at runtime, so passing them (the pdfkit-side fix for CvPdfService) is a
   * no-op here. Rewriting only `docProps/core.xml`'s XML text is not enough either — verified
   * by direct execution across repeated renders — because `Packer.toBuffer()` also stamps
   * every zip entry's own local/central-directory `header.time` (DOS timestamp) with the
   * current wall clock when it builds the archive, independent of the XML content inside
   * each entry. Both must be pinned. The only lever available at all is the OOXML container
   * itself, rewritten post-hoc, exactly as pdfkit's `CreationDate: new Date(0)` pins the PDF
   * trailer. That sha256 is load-bearing (spec §6.3 — artifact idempotency; `exportArtifacts`
   * resumes a partial PDF/DOCX export by comparing kinds, and `download` never regenerates),
   * so this is a correctness fix, not cosmetic.
   */
  private pinTimestamps(buffer: Buffer): Buffer {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry(CORE_PROPS_ENTRY);
    if (!entry) {
      // The OOXML container contract this pin depends on has changed underneath us — refuse
      // rather than silently ship a DOCX whose sha256 is not stable.
      throw new Error(`${CORE_PROPS_ENTRY} not found in generated DOCX; cannot pin its timestamps`);
    }

    const xml = zip
      .readAsText(entry)
      .replace(/(<dcterms:created[^>]*>)[^<]*(<\/dcterms:created>)/, `$1${EPOCH_W3CDTF}$2`)
      .replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${EPOCH_W3CDTF}$2`);
    zip.updateFile(entry, Buffer.from(xml, 'utf8'));

    // Every entry, not just core.xml: its zip-level header.time is independent of its content.
    for (const zipEntry of zip.getEntries()) {
      zipEntry.header.time = EPOCH_DATE;
    }

    return zip.toBuffer();
  }

  private paragraphs(cv: CvDocument): Paragraph[] {
    const out: Paragraph[] = [
      new Paragraph({ text: cv.contact.name, heading: HeadingLevel.TITLE }),
    ];

    if (cv.contact.parts.length > 0) {
      out.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [new TextRun({ text: cv.contact.parts.join('  ·  '), size: 20 })],
        }),
      );
    }

    for (const section of cv.sections) {
      out.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));

      for (const entry of section.entries) {
        // Gated on title OR org, not title alone — see CvPdfService#write for why. The two
        // writers share one document model, so this condition must stay identical in both or
        // PDF and DOCX diverge in content, which cv-document.ts exists to prevent.
        const heading = [entry.title, entry.org].filter(Boolean).join(' — ');
        const suffix = entry.period ? ` (${entry.period})` : '';
        if (heading) {
          out.push(
            new Paragraph({
              children: [
                new TextRun({ text: heading, bold: true }),
                new TextRun({ text: suffix }),
              ],
            }),
          );
        } else if (suffix) {
          out.push(new Paragraph({ children: [new TextRun({ text: suffix.trim() })] }));
        }
        for (const bullet of entry.bullets) {
          out.push(new Paragraph({ text: bullet, bullet: { level: 0 } }));
        }
      }
    }

    return out;
  }

  /**
   * The supplement counterpart of `render`. ONE MODEL, TWO WRITERS: this renders the same
   * `SupplementDocument` the PDF writer does, and neither may grow a field the other lacks.
   */
  async renderSupplement(markdown: string, filenameBase: string): Promise<RenderedFile> {
    const document = renderToSupplementDocument(markdown);
    const raw = await Packer.toBuffer(
      new Document({ sections: [{ children: this.supplementParagraphs(document) }] }),
    );
    const content = this.pinTimestamps(raw);

    return {
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${filenameBase}.docx`,
    };
  }

  private supplementParagraphs(document: SupplementDocument): Paragraph[] {
    const out: Paragraph[] = [
      new Paragraph({ text: document.title, heading: HeadingLevel.TITLE }),
    ];

    if (document.contactParts.length > 0) {
      out.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [new TextRun({ text: document.contactParts.join('  ·  '), size: 20 })],
        }),
      );
    }

    for (const block of document.blocks) {
      if (block.heading) {
        out.push(new Paragraph({ text: block.heading, heading: HeadingLevel.HEADING_1 }));
      }
      for (const paragraph of block.paragraphs) {
        out.push(new Paragraph({ text: paragraph }));
      }
    }

    return out;
  }

}
