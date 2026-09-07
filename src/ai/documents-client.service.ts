import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AI_FETCH, AI_SERVICE_TOKEN, AI_SERVICE_URL } from './ai-client.service';

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
    @Optional() @Inject(AI_SERVICE_TOKEN) private readonly aiServiceToken: string = process.env.AI_SERVICE_TOKEN ?? '',
    @Optional() @Inject(AI_FETCH) private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async extract(buffer: Buffer, mimeType: string, filename: string): Promise<ExtractedDocument> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startedAt = Date.now();
    const bearer = this.requireServiceToken();

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.aiServiceUrl}/documents/extract`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearer}`,
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
      this.logger.error(`document extraction returned empty text after ${Date.now() - startedAt}ms`);
      throw new Error('document extraction returned empty text');
    }

    return {
      text,
      engine: payload.engine ?? 'unknown',
      ocrUsed: payload.ocrUsed === true,
      pages: typeof payload.pages === 'number' ? payload.pages : 0,
    };
  }

  private requireServiceToken(): string {
    const token = this.aiServiceToken.trim().replace(/^Bearer\s+/i, '');
    if (!token) {
      throw new Error('AI_SERVICE_TOKEN is not set; cannot authenticate to ai-microservice');
    }
    return token;
  }

  private detail(body: string): string {
    try {
      const parsed = JSON.parse(body) as { message?: string; error?: string };
      return parsed.message || parsed.error || body.slice(0, 300);
    } catch {
      return body.slice(0, 300);
    }
  }
}
