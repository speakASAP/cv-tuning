/**
 * Minimal ambient typing for the `fontkit` package (a transitive dependency of pdfkit,
 * promoted to a direct one here). Upstream ships no `.d.ts` and there is no `@types/fontkit`
 * package; only the surface `cv-pdf.service.ts` actually calls is declared.
 */
declare module 'fontkit' {
  export interface Glyph {
    id: number;
  }

  export interface Font {
    glyphForCodePoint(codePoint: number): Glyph;
  }

  export function openSync(path: string): Font;
}
