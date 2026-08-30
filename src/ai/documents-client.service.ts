import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AI_FETCH, AI_JWT_PRIVATE_KEY, AI_JWT_SECRET, AI_SERVICE_URL } from './ai-client.service';
import { mintServiceToken } from './service-token';

const SERVICE_ID = 'cv-tuning';

/**
 * Above ai-microservice's own OCR budget: a scanned CV is rasterised and recognised page by
 * page, which is minutes of local CPU work rather than a model call. Aborting earlier than
 * the server would abandon work it is still doing and report a timeout for a document that
 * was about to succeed.
 */
const TIMEOUT_MS = 240_000;

export interface ExtractedDocument {
  text: string;
  /** How the text was obtained: `pdf-text`, `docx`, `plain-text`, or `ocr`. */
  engine: string;
  ocrUsed: boolean;
  pages: number;
}

/**
 * Reads documents through ai-microservice rather than parsing them here.
 *
 * OCR needs system packages (poppler, tesseract) that would otherwise have to be installed
 * into every image that accepts an upload, and each copy would drift. The shared endpoint
 * keeps one implementation and one set of packages for the whole ecosystem.
 */
@Injectable()
export class DocumentsClientService {
  private readonly logger = new Logger(DocumentsClientService.name);

  constructor(
    @Optional() @Inject(AI_SERVICE_URL) private readonly aiServiceUrl: string = process.env.AI_SERVICE_URL ?? '',
    @Optional() @Inject(AI_JWT_SECRET) private readonly jwtSecret: string = process.env.CV_AI_JWT_SECRET ?? process.env.JWT_SECRET ?? '',
    @Optional() @Inject(AI_FETCH) private readonly fetchImpl: typeof fetch = fetch,
    @Optional() @Inject(AI_JWT_PRIVATE_KEY) private readonly jwtPrivateKey: string = process.env.CV_AI_JWT_PRIVATE_KEY ?? process.env.JWT_PRIVATE_KEY ?? '',
  ) {}

  async extract(buffer: Buffer, mimeType: string, filename: string): Promise<ExtractedDocument> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.aiServiceUrl}/documents/extract`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${mintServiceToken(SERVICE_ID, this.jwtPrivateKey, this.jwtSecret)}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          filename,
          mimeType,
          contentBase64: buffer.toString('base64'),
        }),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`document extraction unreachable at ${this.aiServiceUrl}/documents/extract: ${message}`);
      throw new Error(`could not reach the document service: ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      // 400 carries the document service's own actionable wording (unreadable scan,
      // unsupported type). Surfacing it verbatim is what lets the user fix the upload.
      const detail = this.detail(body);
      this.logger.error(`document extraction returned ${response.status}: ${body.slice(0, 300)}`);
      throw new Error(response.status === 400 ? detail : `document extraction failed (${response.status}): ${detail}`);
    }

    const payload = (await response.json()) as Partial<ExtractedDocument>;
    const text = payload.text ?? '';
    if (text.trim().length === 0) {
      throw new Error('the document service returned no text for this file');
    }

    this.logger.log(
      `extracted ${filename} engine=${payload.engine} ocr=${payload.ocrUsed} ` +
        `pages=${payload.pages} chars=${text.length} in ${Date.now() - startedAt}ms`,
    );

    return {
      text,
      engine: payload.engine ?? 'unknown',
      ocrUsed: payload.ocrUsed === true,
      pages: payload.pages ?? 0,
    };
  }

  private detail(body: string): string {
    try {
      const parsed = JSON.parse(body) as { message?: string | string[] };
      const message = Array.isArray(parsed.message) ? parsed.message.join('; ') : parsed.message;
      return message ?? body.slice(0, 200);
    } catch {
      return body.slice(0, 200);
    }
  }
}
