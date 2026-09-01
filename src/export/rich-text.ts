import { join } from 'path';
import * as fontkit from 'fontkit';
import bidiFactory = require('bidi-js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const arabicReshaper = require('arabic-reshaper');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const emojiData: { unified: string; image: string }[] = require('emoji-datasource-google/emoji.json');

const FONTS_DIR = join(__dirname, 'fonts');

export interface FontFamily {
  /** Internal id, only used for equality checks when merging adjacent same-family segments. */
  key: string;
  regularName: string;
  boldName: string;
  regularPath: string;
  boldPath: string;
}

/**
 * DejaVu Sans (permissive licence, DejaVuSans-LICENSE.txt) covers Latin Extended, Cyrillic,
 * Greek, and general punctuation -- the vast majority of real CV content.
 */
export const LATIN: FontFamily = {
  key: 'latin',
  regularName: 'DejaVuSans',
  boldName: 'DejaVuSans-Bold',
  regularPath: join(FONTS_DIR, 'DejaVuSans.ttf'),
  boldPath: join(FONTS_DIR, 'DejaVuSans-Bold.ttf'),
};

/**
 * Noto Sans CJK (SC face; Han unification means this single face also carries Hiragana,
 * Katakana, and Hangul -- see NotoSans-LICENSE.txt), subsetted to CJK Unified Ideographs,
 * Hangul Syllables, Kana, and CJK punctuation to keep the embedded font size reasonable.
 */
export const CJK: FontFamily = {
  key: 'cjk',
  regularName: 'NotoSansCJK',
  boldName: 'NotoSansCJK-Bold',
  regularPath: join(FONTS_DIR, 'NotoSansCJK-Regular.ttf'),
  boldPath: join(FONTS_DIR, 'NotoSansCJK-Bold.ttf'),
};

/** Noto Sans Arabic. Used only after `toVisualOrder` has reshaped + bidi-reordered the text. */
export const ARABIC: FontFamily = {
  key: 'arabic',
  regularName: 'NotoSansArabic',
  boldName: 'NotoSansArabic-Bold',
  regularPath: join(FONTS_DIR, 'NotoSansArabic-Regular.ttf'),
  boldPath: join(FONTS_DIR, 'NotoSansArabic-Bold.ttf'),
};

/** Noto Sans Hebrew. Used only after `toVisualOrder` has bidi-reordered the text. */
export const HEBREW: FontFamily = {
  key: 'hebrew',
  regularName: 'NotoSansHebrew',
  boldName: 'NotoSansHebrew-Bold',
  regularPath: join(FONTS_DIR, 'NotoSansHebrew-Regular.ttf'),
  boldPath: join(FONTS_DIR, 'NotoSansHebrew-Bold.ttf'),
};

/**
 * Priority order for both glyph-coverage checks and rendering: try the Latin font first, so
 * ordinary CV content keeps using the smaller, already-proven DejaVu Sans, and only the
 * scripts that genuinely need a different embedded font fall through to it.
 */
export const FONT_FAMILIES: FontFamily[] = [LATIN, CJK, ARABIC, HEBREW];

// Opened once and reused: fontkit parses the whole glyph table on open, and every render and
// every encodability check needs it, so re-opening per call would be a needless repeated cost.
const fontCache = new Map<string, fontkit.Font>();
function openFont(path: string): fontkit.Font {
  let font = fontCache.get(path);
  if (!font) {
    font = fontkit.openSync(path) as fontkit.Font;
    fontCache.set(path, font);
  }
  return font;
}

function familyHasCodePoint(family: FontFamily, codePoint: number): boolean {
  return openFont(family.regularPath).glyphForCodePoint(codePoint).id !== 0;
}

// ---- RTL: Arabic contextual shaping + Unicode Bidirectional Algorithm reordering ----

const bidi = bidiFactory();
const ARABIC_RANGE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const HEBREW_RANGE = /[\u0590-\u05FF]/;

function needsBidi(text: string): boolean {
  return ARABIC_RANGE.test(text) || HEBREW_RANGE.test(text);
}

/**
 * pdfkit has neither Arabic contextual joining (initial/medial/final presentation forms) nor
 * the Unicode Bidirectional Algorithm (UAX#9): it draws whichever code points it is given,
 * left-to-right, one after another. Un-reshaped Arabic renders as disconnected, wrong-shaped
 * letters, and RTL text renders back-to-front. This runs once, ahead of glyph-level
 * rendering; the result is treated as an ordinary left-to-right string from here on, which is
 * exactly what a PDF content stream expects.
 */
function toVisualOrder(text: string): string {
  const reshaped: string = ARABIC_RANGE.test(text) ? arabicReshaper.convertArabic(text) : text;
  const levels = bidi.getEmbeddingLevels(reshaped);
  return bidi.getReorderedString(reshaped, levels);
}

// ---- Emoji lookup (raster fallback: pdfkit cannot embed COLR/CBDT color glyph layers) ----

const emojiByUnified = new Map<string, string>();
for (const entry of emojiData) {
  emojiByUnified.set(entry.unified, entry.image);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const EMOJI_IMAGE_DIR = join(require.resolve('emoji-datasource-google/package.json'), '..', 'img', 'google', '64');

function clusterToUnified(cluster: string): string {
  return [...cluster].map((ch) => ch.codePointAt(0)!.toString(16).toUpperCase()).join('-');
}

/**
 * Looks up an emoji PNG for a grapheme cluster, trying the cluster as-is and then with a
 * trailing variation selector (U+FE0F) stripped: emoji-datasource-google keys some emoji only
 * by their "non-qualified" form.
 */
function emojiImagePath(cluster: string): string | undefined {
  const withVs16 = clusterToUnified(cluster);
  const withoutVs16 = clusterToUnified(cluster.replace(/\uFE0F$/u, ''));
  const image = emojiByUnified.get(withVs16) ?? emojiByUnified.get(withoutVs16);
  return image ? join(EMOJI_IMAGE_DIR, image) : undefined;
}

// ---- Segmentation ----

export type Segment =
  | { kind: 'text'; family: FontFamily; text: string }
  | { kind: 'image'; path: string; cluster: string }
  | { kind: 'unsupported'; cluster: string };

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Splits arbitrary text into runs pdfkit can render: consecutive characters covered by the
 * same embedded font are merged into one `text` segment (so kerning/shaping over more than
 * one character stays correct); a grapheme cluster none of the four fonts can encode falls
 * back to an emoji raster image when the emoji dataset has one, or is reported `unsupported`
 * otherwise. RTL scripts are reshaped and bidi-reordered into left-to-right visual order
 * before this per-cluster pass, so segmentation never has to reason about writing direction.
 */
export function segment(text: string): Segment[] {
  const visual = needsBidi(text) ? toVisualOrder(text) : text;
  const segments: Segment[] = [];
  for (const { segment: cluster } of graphemeSegmenter.segment(visual)) {
    const codePoints = [...cluster].map((ch) => ch.codePointAt(0)!);
    const coveredByFamily = FONT_FAMILIES.find((family) =>
      codePoints.every((cp) => familyHasCodePoint(family, cp)),
    );

    if (!coveredByFamily) {
      const imagePath = emojiImagePath(cluster);
      if (imagePath) {
        segments.push({ kind: 'image', path: imagePath, cluster });
        continue;
      }
      segments.push({ kind: 'unsupported', cluster });
      continue;
    }

    const last = segments[segments.length - 1];
    if (last && last.kind === 'text' && last.family === coveredByFamily) {
      last.text += cluster;
    } else {
      segments.push({ kind: 'text', family: coveredByFamily, text: cluster });
    }
  }
  return segments;
}

/** The single source of truth for "can this render", shared by the pre-flight check and the writer. */
export function unsupportedClusters(text: string): string[] {
  return segment(text)
    .filter((entry): entry is Extract<Segment, { kind: 'unsupported' }> => entry.kind === 'unsupported')
    .map((entry) => entry.cluster);
}

/** Registers every embedded font family (regular + bold) once per pdfkit document. */
export function registerFontFamilies(doc: PDFKit.PDFDocument): void {
  for (const family of FONT_FAMILIES) {
    doc.registerFont(family.regularName, family.regularPath);
    doc.registerFont(family.boldName, family.boldPath);
  }
}

export interface WriteRunOptions {
  size: number;
  bold?: boolean;
  indent?: number;
  /** Mirrors pdfkit's own `continued`: leaves the paragraph open for a following `doc.text()` call. */
  continued?: boolean;
}

const EMOJI_SIZE_RATIO = 1.15;

/**
 * Renders one logical string that may mix scripts DejaVu alone cannot cover, and may contain
 * emoji. Three paths, cheapest first:
 *  - a single Latin/Cyrillic/Greek segment (the overwhelming majority of real CV content)
 *    goes through the exact same single `doc.text()` call as before this feature existed;
 *  - multiple text segments with no images use pdfkit's own `continued` text runs, switching
 *    `doc.font()` between runs, so pdfkit's automatic line wrap and pagination still apply;
 *  - any image segment (emoji) needs a raster inserted mid-line, which pdfkit cannot do
 *    inside a continued run, so that case lays out words and images manually, replicating
 *    just enough of pdfkit's wrap/page-break behaviour to stay correct.
 */
export function writeRun(doc: PDFKit.PDFDocument, text: string, options: WriteRunOptions): void {
  const segments = segment(text);

  if (segments.length === 0) {
    if (options.continued) {
      doc.text('', { continued: true });
    }
    return;
  }

  const hasImage = segments.some((entry) => entry.kind === 'image');

  if (!hasImage) {
    const textSegments = segments.map((entry) =>
      entry.kind === 'text' ? entry : { kind: 'text' as const, family: LATIN, text: '\uFFFD' },
    );
    textSegments.forEach((entry, index) => {
      const isLast = index === textSegments.length - 1;
      doc
        .font(options.bold ? entry.family.boldName : entry.family.regularName)
        .fontSize(options.size)
        .text(entry.text, {
          continued: isLast ? Boolean(options.continued) : true,
          indent: index === 0 ? options.indent : undefined,
        });
    });
    return;
  }

  writeMixedRunWithImages(doc, segments, options);
}

function widthOfCluster(doc: PDFKit.PDFDocument, family: FontFamily, bold: boolean, size: number, text: string): number {
  doc.font(bold ? family.boldName : family.regularName).fontSize(size);
  return doc.widthOfString(text);
}

type LayoutToken =
  | { type: 'word'; family: FontFamily; text: string }
  | { type: 'space'; family: FontFamily }
  | { type: 'image'; path: string };

/** Splits text segments into word/space tokens (images are already atomic) for manual layout. */
function tokenize(segments: Segment[]): LayoutToken[] {
  const tokens: LayoutToken[] = [];
  for (const entry of segments) {
    if (entry.kind === 'image') {
      tokens.push({ type: 'image', path: entry.path });
      continue;
    }
    if (entry.kind === 'unsupported') {
      // assertEncodable should already have rejected this render; if it is ever reached
      // regardless, the Unicode replacement character (which DejaVu does have) keeps the
      // document from crashing instead of losing the whole render to an exception.
      tokens.push({ type: 'word', family: LATIN, text: '\uFFFD' });
      continue;
    }
    const parts = entry.text.match(/\s+|\S+/gu) ?? [];
    for (const part of parts) {
      tokens.push(/^\s+$/.test(part) ? { type: 'space', family: entry.family } : { type: 'word', family: entry.family, text: part });
    }
  }
  return tokens;
}

/**
 * Manual word-wrap: only reached when a string contains at least one emoji, since pdfkit
 * cannot place an image inside a `continued` text run. Mirrors pdfkit's own wrap/page-break
 * behaviour closely enough to be correct (measure each token, break before it overflows the
 * line, start a new page before the line would overflow the bottom margin) without
 * attempting to reproduce pdfkit's full layout engine.
 */
function writeMixedRunWithImages(doc: PDFKit.PDFDocument, segments: Segment[], options: WriteRunOptions): void {
  const tokens = tokenize(segments);
  const leftBound = doc.page.margins.left + (options.indent ?? 0);
  const rightBound = doc.page.width - doc.page.margins.right;
  const bottomBound = doc.page.height - doc.page.margins.bottom;
  const lineHeight = options.size * 1.25;
  const imageSize = options.size * EMOJI_SIZE_RATIO;

  let x = doc.x < leftBound ? leftBound : doc.x;
  let y = doc.y;
  let atLineStart = x <= leftBound;

  const newLine = () => {
    x = leftBound;
    y += lineHeight;
    if (y + lineHeight > bottomBound) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    atLineStart = true;
  };

  for (const token of tokens) {
    if (token.type === 'space') {
      if (atLineStart) continue; // never start a wrapped line with leading whitespace
      const width = widthOfCluster(doc, token.family, Boolean(options.bold), options.size, ' ');
      if (x + width > rightBound) {
        newLine();
      } else {
        x += width;
      }
      continue;
    }

    const width =
      token.type === 'image' ? imageSize : widthOfCluster(doc, token.family, Boolean(options.bold), options.size, token.text);

    if (!atLineStart && x + width > rightBound) {
      newLine();
    }

    if (token.type === 'image') {
      doc.image(token.path, x, y + (lineHeight - imageSize) / 2, { width: imageSize, height: imageSize });
    } else {
      doc.font(options.bold ? token.family.boldName : token.family.regularName).fontSize(options.size);
      doc.text(token.text, x, y, { lineBreak: false });
    }
    x += width;
    atLineStart = false;
  }

  if (options.continued) {
    // Leave the cursor exactly where the manual layout stopped, so a following plain
    // `doc.text(..., { continued: true/false })` call (unaware this run used manual layout)
    // picks up on the same line, exactly as pdfkit's own continued mode would.
    doc.x = x;
    doc.y = y;
  } else {
    doc.x = leftBound;
    doc.y = y + lineHeight;
  }
}
