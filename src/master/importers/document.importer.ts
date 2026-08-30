import { Injectable, Logger } from '@nestjs/common';
import { DocumentsClientService } from '../../ai/documents-client.service';

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const TEXT_MIMES = ['text/plain', 'text/markdown'];
/** Photographed and scanned CVs. Read by OCR in ai-microservice, never here. */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/tiff', 'image/webp'];

const EXTENSIONS: Record<string, string> = {
  [PDF_MIME]: 'pdf',
  [DOCX_MIME]: 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
};

/**
 * Turns an uploaded file into CV text.
 *
 * The parsing itself lives in ai-microservice's `/documents/extract`, which every service
 * that accepts documents shares. OCR is the reason: recognising a scan needs poppler and
 * tesseract, which are system packages, and installing them into each service image would
 * mean several copies drifting apart. Despite the service's name none of this is a model
 * call — PDF, DOCX and text are parsed exactly, and OCR is a local recogniser.
 */
@Injectable()
export class DocumentImporter {
  private readonly logger = new Logger(DocumentImporter.name);

  constructor(private readonly documents: DocumentsClientService) {}

  static extensionFor(mimeType: string): string {
    return EXTENSIONS[mimeType] ?? 'bin';
  }

  static isSupported(mimeType: string): boolean {
    return (
      mimeType === PDF_MIME ||
      mimeType === DOCX_MIME ||
      TEXT_MIMES.includes(mimeType) ||
      IMAGE_MIMES.includes(mimeType)
    );
  }

  async extract(buffer: Buffer, mimeType: string, filename = 'cv'): Promise<string> {
    if (buffer.length === 0) {
      throw new Error('the uploaded file is empty');
    }

    if (!DocumentImporter.isSupported(mimeType)) {
      throw new Error(
        `unsupported file type ${mimeType}. Upload a PDF, DOCX, plain text, or a photo/scan of your CV.`,
      );
    }

    const result = await this.documents.extract(buffer, mimeType, filename);

    if (result.ocrUsed) {
      // Recognised text carries errors parsed text does not, and the fact graph built from
      // it inherits them. Recorded so a later "why is this fact wrong" has an answer.
      this.logger.warn(`${filename} had no text layer and was read by OCR over ${result.pages} page(s)`);
    }

    return result.text;
  }
}
