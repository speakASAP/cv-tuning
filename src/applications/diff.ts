/**
 * Unified diff with word-level granularity inside changed lines (spec §7).
 *
 * Hand-rolled rather than pulled from npm: the input is a CV, so the documents are small
 * enough that an O(n*m) LCS is free, and a diff shown next to grounding verdicts should not
 * depend on a transitive dependency tree.
 */

export type PartType = 'equal' | 'added' | 'removed';

export interface DiffPart {
  type: PartType;
  value: string;
}

export type HunkType = 'added' | 'removed' | 'changed';

export interface DiffHunk {
  type: HunkType;
  /** 1-indexed line in the before document; null for a pure addition. */
  beforeLine: number | null;
  /** 1-indexed line in the after document; null for a pure removal. */
  afterLine: number | null;
  before: string | null;
  after: string | null;
  /** Word-level breakdown, present only for a `changed` hunk. */
  words?: DiffPart[];
}

/** Splits on whitespace but keeps it, so joining the parts reproduces the input exactly. */
const tokenize = (text: string): string[] => (text ? text.match(/\s+|\S+/g) ?? [] : []);

/** Longest-common-subsequence table over two token arrays. */
function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  return table;
}

function collapse(parts: DiffPart[]): DiffPart[] {
  const merged: DiffPart[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && last.type === part.type) {
      last.value += part.value;
    } else {
      merged.push({ ...part });
    }
  }
  return merged;
}

export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const table = lcsTable(a, b);

  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      parts.push({ type: 'equal', value: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      parts.push({ type: 'removed', value: a[i] });
      i += 1;
    } else {
      parts.push({ type: 'added', value: b[j] });
      j += 1;
    }
  }

  while (i < a.length) {
    parts.push({ type: 'removed', value: a[i] });
    i += 1;
  }
  while (j < b.length) {
    parts.push({ type: 'added', value: b[j] });
    j += 1;
  }

  return collapse(parts);
}

/** Trailing-newline-only differences are cosmetic and must not surface as a change. */
const splitLines = (text: string): string[] => (text === '' ? [] : text.replace(/\n+$/, '').split('\n'));

export function diffLines(before: string, after: string): DiffHunk[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const table = lcsTable(a, b);

  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;

  const pushRemoved = () => {
    hunks.push({ type: 'removed', beforeLine: i + 1, afterLine: null, before: a[i], after: null });
    i += 1;
  };
  const pushAdded = () => {
    hunks.push({ type: 'added', beforeLine: null, afterLine: j + 1, before: null, after: b[j] });
    j += 1;
  };

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }

    const removeScore = table[i + 1][j];
    const addScore = table[i][j + 1];

    // Equal scores mean neither line survives further down: it is one line rewritten, not a
    // delete followed by an unrelated insert. Pairing them is what makes word-level
    // granularity possible.
    if (removeScore === addScore) {
      hunks.push({
        type: 'changed',
        beforeLine: i + 1,
        afterLine: j + 1,
        before: a[i],
        after: b[j],
        words: diffWords(a[i], b[j]),
      });
      i += 1;
      j += 1;
    } else if (removeScore > addScore) {
      pushRemoved();
    } else {
      pushAdded();
    }
  }

  while (i < a.length) pushRemoved();
  while (j < b.length) pushAdded();

  return hunks;
}
