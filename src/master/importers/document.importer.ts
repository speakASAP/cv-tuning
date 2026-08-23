import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

export const PDF_PARSER = 'CV_PDF_PARSER';
export const DOCX_PARSER = 'CV_DOCX_PARSER';

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const TEXT_MIMES = ['text/plain', 'text/markdown'];

export type PdfParser = (buffer: Buffer) => Promise<{ text: string }>;
export type DocxParser = (input: { buffer: Buffer }) => Promise<{ value: string }>;

const EXTENSIONS: Record<string, string> = {
  [PDF_MIME]: 'pdf',
  [DOCX_MIME]: 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

@Injectable()
export class DocumentImporter {
  private readonly logger = new Logger(DocumentImporter.name);

  constructor(
    @Optional() @Inject(PDF_PARSER) private readonly parsePdf?: PdfParser,
    @Optional() @Inject(DOCX_PARSER) private readonly parseDocx?: DocxParser,
  ) {}

  static extensionFor(mimeType: string): string {
    return EXTENSIONS[mimeType] ?? 'bin';
  }

  static isSupported(mimeType: string): boolean {
    return mimeType === PDF_MIME || mimeType === DOCX_MIME || TEXT_MIMES.includes(mimeType);
  }

  async extract(buffer: Buffer, mimeType: string): Promise<string> {
    if (buffer.length === 0) {
      throw new Error('the uploaded file is empty');
    }

    const text = await this.extractRaw(buffer, mimeType);

    if (text.trim().length === 0) {
      // A scanned CV parses "successfully" to an empty string. Accepting that would
      // silently replace the user's CV with nothing.
      throw new Error(
        'no extractable text found in the uploaded file. If it is a scan or an image, ' +
          'paste the text instead — this importer does not run OCR.',
      );
    }

    return text;
  }

  private async extractRaw(buffer: Buffer, mimeType: string): Promise<string> {
    if (TEXT_MIMES.includes(mimeType)) {
      return buffer.toString('utf8');
    }

    if (mimeType === PDF_MIME) {
      const parser = this.parsePdf ?? (await this.defaultPdfParser());
      try {
        return (await parser(buffer)).text;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.logger.error(`PDF parse failed: ${message}`);
        throw new Error(`could not read the PDF: ${message}`);
      }
    }

    if (mimeType === DOCX_MIME) {
      const parser = this.parseDocx ?? (await this.defaultDocxParser());
      try {
        return (await parser({ buffer })).value;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.logger.error(`DOCX parse failed: ${message}`);
        throw new Error(`could not read the DOCX: ${message}`);
      }
    }

    throw new Error(`unsupported file type: ${mimeType}. Upload a PDF, DOCX, or plain text file.`);
  }

  private async defaultPdfParser(): Promise<PdfParser> {
    const mod = await import('pdf-parse');
    const fn = (mod as unknown as { default?: PdfParser }).default ?? (mod as unknown as PdfParser);
    return fn;
  }

  private async defaultDocxParser(): Promise<DocxParser> {
    const mod = await import('mammoth');
    return (mod as unknown as { extractRawText: DocxParser }).extractRawText;
  }
}
