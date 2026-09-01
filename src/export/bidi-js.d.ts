/**
 * Minimal ambient typing for the `bidi-js` package (Unicode Bidirectional Algorithm, UAX#9).
 * Upstream ships no `.d.ts` and there is no `@types/bidi-js` package; only the surface
 * `rich-text.ts` actually calls is declared.
 */
declare module 'bidi-js' {
  export interface EmbeddingLevels {
    levels: Uint8Array;
    paragraphs: { start: number; end: number; level: number }[];
  }

  export interface Bidi {
    getEmbeddingLevels(text: string, baseDirection?: 'ltr' | 'rtl' | 'auto'): EmbeddingLevels;
    getReorderedString(text: string, embeddingLevels: EmbeddingLevels, start?: number, end?: number): string;
  }

  // `bidi-js` is a plain CommonJS module exporting the factory function itself (no `.default`
  // wrapper); `export =` here matches that at runtime, unlike a `default` export declaration,
  // which needs `esModuleInterop` (not enabled in this project) to resolve to the same thing.
  function bidiFactory(): Bidi;
  export = bidiFactory;
}
