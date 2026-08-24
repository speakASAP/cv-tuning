import { Logger } from '@nestjs/common';
import { ExtractedFact, FactContext } from './fact-identity';

const logger = new Logger('FactProvenance');

/** The separator `linkedin.importer.ts` emits between role and company. Not a hyphen. */
const EM_DASH = '—';

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
/** A leading list marker (`- `, `* `, `1. `) or blockquote, which is markup, not fact text. */
const LIST_MARKER = /^\s{0,3}(?:[-*+]\s+|\d{1,3}[.)]\s+|>\s?)/;

/**
 * Below this many normalised characters a fact is too generic for containment matching:
 * "Py" or "SQL" is a substring of half a CV, and matching one to an arbitrary line would
 * stamp an employer the CV never connected it to onto a real document.
 */
const MIN_LOOSE_MATCH_LENGTH = 12;

/** One body line of the markdown together with the headings that were open above it. */
export interface HeadingBlock {
  /** The line with list markers and inline emphasis stripped, as a fact's text would read. */
  line: string;
  /** Normalised form, matching `hashFactContent`'s normalisation exactly. */
  normalised: string;
  section: string | null;
  org: string | null;
  period: string | null;
}

/**
 * Splits `Role — Company (period)` — the shape `linkedin.importer.ts` guarantees.
 *
 * Deliberately conservative. `section`/`org`/`period` are derived in code precisely so the
 * model never gets to report the employer or the date range (spec §6), and a heading that
 * does not clearly match the shape yields nulls rather than a plausible-looking split. A
 * wrong employer on a CV an employer reads is worse than an absent one.
 */
export function parseEntryHeading(heading: string): { org: string | null; period: string | null } {
  const parts = heading.split(EM_DASH);

  // Exactly one separator, or the split is ambiguous (`Lead — Acme — Berlin`) and we
  // cannot say which half is the employer.
  if (parts.length !== 2) {
    return { org: null, period: null };
  }

  const role = parts[0].trim();
  let rest = parts[1].trim();

  // Both halves must be present; `— Acme (2019)` is not the recognised shape, so the
  // remainder is not provably an employer.
  if (role.length === 0 || rest.length === 0) {
    return { org: null, period: null };
  }

  let period: string | null = null;

  // The period is the LAST balanced parenthesised group, and only when it closes the
  // heading — so `Acme (Europe) Ltd (2010 – 2012)` keeps `(Europe)` in the org.
  if (rest.endsWith(')')) {
    const open = findMatchingOpenParen(rest);
    if (open !== null) {
      const inner = rest.slice(open + 1, rest.length - 1).trim();
      const before = rest.slice(0, open).trim();
      // A heading that is nothing but a parenthesised group leaves no org behind.
      if (inner.length > 0 && before.length > 0) {
        period = inner;
        rest = before;
      }
    }
  }

  return { org: rest.length > 0 ? rest : null, period };
}

/** Index of the `(` that matches the final `)`, or null when the parens are unbalanced. */
function findMatchingOpenParen(text: string): number | null {
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === ')') depth += 1;
    else if (text[i] === '(') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * Walks the markdown and returns every non-heading body line with the section (H2) and
 * entry (H3+) headings open above it.
 *
 * H1 is the candidate's name (`render-markdown.ts#extractH1Name`), never a section, so it
 * only resets context. A new H2 clears the entry context: carrying `Acme Corp` down into a
 * `## Skills` section would attribute a skill to an employer the CV never linked it to.
 */
export function parseHeadingBlocks(markdown: string): HeadingBlock[] {
  const blocks: HeadingBlock[] = [];
  let section: string | null = null;
  let org: string | null = null;
  let period: string | null = null;
  let inFence = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    if (FENCE.test(rawLine)) {
      inFence = !inFence;
      continue;
    }

    // Inside a fence a `##` is literal text a candidate wrote, not document structure.
    if (inFence) {
      continue;
    }

    const heading = HEADING.exec(rawLine);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();

      if (level === 1) {
        section = null;
        org = null;
        period = null;
      } else if (level === 2) {
        section = title.length > 0 ? title : null;
        org = null;
        period = null;
      } else {
        const entry = parseEntryHeading(title);
        org = entry.org;
        period = entry.period;
      }
      continue;
    }

    const line = stripInline(rawLine);
    if (line.length === 0) {
      continue;
    }

    blocks.push({ line, normalised: normalise(line), section, org, period });
  }

  return blocks;
}

/** Same normalisation `hashFactContent` applies, so matching sees what identity sees. */
function normalise(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Removes list/quote markers and inline emphasis so a line reads as a model would copy it. */
function stripInline(rawLine: string): string {
  let line = rawLine.replace(LIST_MARKER, '');
  // Bold/italic/code markers are markup; a model copying "the candidate's own wording"
  // returns the words, not the asterisks.
  line = line.replace(/\*\*|__|[*_`]/g, '');
  return line.trim();
}

/**
 * Attaches derived `{section, org, period}` to each extracted fact by mapping its text back
 * to the heading block it came from.
 *
 * The extractor is a single LLM pass told to copy the candidate's wording verbatim, and the
 * model does not always comply exactly, so matching runs in confidence order: exact
 * normalised equality first, then containment either way (a trimmed or lightly expanded
 * restatement of one line). A fact that matches nothing, or matches blocks that DISAGREE
 * about a field, gets `null` for that field — never the nearest heading.
 *
 * Unmapped facts are logged (this repo forbids silent degradation) but never throw: a
 * heading-less, free-form CV is a real and expected input, not a failure.
 */
export function attachFactContext<T extends ExtractedFact>(
  markdown: string,
  facts: T[],
): (T & FactContext)[] {
  if (facts.length === 0) {
    return [];
  }

  const blocks = parseHeadingBlocks(markdown);
  const unmapped: string[] = [];

  const attached = facts.map((fact) => {
    const matches = findMatches(blocks, normalise(fact.text));

    if (matches.length === 0) {
      unmapped.push(fact.text);
      return { ...fact, section: null, org: null, period: null };
    }

    return {
      ...fact,
      // Each field is agreed independently: duplicate bullets under two employers still
      // agree on the section, and losing that would discard information we do have.
      section: agree(matches.map((b) => b.section)),
      org: agree(matches.map((b) => b.org)),
      period: agree(matches.map((b) => b.period)),
    };
  });

  if (unmapped.length > 0) {
    // Not an error: a fact the model rephrased, or a CV with no headings, legitimately has
    // no derivable home. Logged so a systematic mapping failure is diagnosable rather than
    // showing up later as a CV with no employers on it.
    logger.warn(
      `${unmapped.length}/${facts.length} extracted facts could not be mapped to a heading block ` +
        `(${blocks.length} body lines, ${blocks.filter((b) => b.org !== null).length} under an entry heading); ` +
        `section/org/period left null for: ${unmapped.map((t) => JSON.stringify(t.slice(0, 80))).join(', ')}`,
    );
  }

  return attached;
}

/**
 * Candidate blocks for one fact, in confidence order: an exact normalised match wins
 * outright, and only when there is none do we fall back to containment.
 */
function findMatches(blocks: HeadingBlock[], factText: string): HeadingBlock[] {
  if (factText.length === 0) {
    return [];
  }

  const exact = blocks.filter((b) => b.normalised === factText);
  if (exact.length > 0) {
    return exact;
  }

  // Too short to be distinctive: "py" is a substring of countless lines.
  if (factText.length < MIN_LOOSE_MATCH_LENGTH) {
    return [];
  }

  return blocks.filter(
    (b) =>
      b.normalised.length >= MIN_LOOSE_MATCH_LENGTH &&
      (b.normalised.includes(factText) || factText.includes(b.normalised)),
  );
}

/** The shared value when every candidate agrees, otherwise null — never a majority guess. */
function agree(values: (string | null)[]): string | null {
  const first = values[0];
  return values.every((v) => v === first) ? first : null;
}
