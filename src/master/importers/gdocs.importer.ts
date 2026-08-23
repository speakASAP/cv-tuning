import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

export const GDOCS_FETCH = 'CV_GDOCS_FETCH';

const DOC_ID = /^https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/;
const FETCH_TIMEOUT_MS = 15_000;

@Injectable()
export class GdocsImporter {
  private readonly logger = new Logger(GdocsImporter.name);

  constructor(@Optional() @Inject(GDOCS_FETCH) private readonly fetchImpl: typeof fetch = fetch) {}

  /** Link-shared documents export as plain text without OAuth. Private ones do not. */
  static exportUrl(url: string): string {
    const id = DOC_ID.exec(url)?.[1];
    if (!id) {
      throw new Error(`not a Google Docs document URL: ${url}`);
    }
    return `https://docs.google.com/document/d/${id}/export?format=txt`;
  }

  async fetchMarkdown(url: string): Promise<string> {
    const exportUrl = GdocsImporter.exportUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImpl(exportUrl, { redirect: 'follow', signal: controller.signal });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`Google Docs export failed for ${exportUrl}: ${message}`);
      throw new Error(`Google Docs export request failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 || response.status === 403) {
      // Actionable rather than generic: the user can fix this themselves in one click.
      throw new Error(
        'That document is not publicly accessible. Set it to "Anyone with the link can view" ' +
          'and try again — link-shared documents are the only kind supported right now.',
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      this.logger.error(`Google Docs export returned ${response.status}: ${body.slice(0, 200)}`);
      throw new Error(`Google Docs export returned ${response.status}`);
    }

    const text = await response.text();
    if (text.trim().length === 0) {
      // An empty import must never silently become an empty CV.
      throw new Error('the exported Google Doc is empty');
    }

    return text;
  }
}
