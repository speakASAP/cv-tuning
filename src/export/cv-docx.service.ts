import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { CvDocument, renderToDocument } from './cv-document';
import { RenderedFile } from './cv-pdf.service';

/**
 * Same document model as the PDF writer, different container. DOCX often parses better in
 * ATS than PDF, so it is not optional (spec §6.2).
 */
@Injectable()
export class CvDocxService {
  async render(markdown: string, filenameBase: string): Promise<RenderedFile> {
    const document = renderToDocument(markdown);
    const content = await Packer.toBuffer(
      new Document({ sections: [{ children: this.paragraphs(document) }] }),
    );

    return {
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${filenameBase}.docx`,
    };
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
        if (entry.title) {
          const heading = [entry.title, entry.org].filter(Boolean).join(' — ');
          const suffix = entry.period ? ` (${entry.period})` : '';
          out.push(
            new Paragraph({
              children: [
                new TextRun({ text: heading, bold: true }),
                new TextRun({ text: suffix }),
              ],
            }),
          );
        }
        for (const bullet of entry.bullets) {
          out.push(new Paragraph({ text: bullet, bullet: { level: 0 } }));
        }
      }
    }

    return out;
  }
}
