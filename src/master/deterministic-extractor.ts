import { Logger } from '@nestjs/common';
import { ContextualFact } from './fact-identity';
import { parseEntryHeading } from './fact-provenance';
import { FactKind } from './master.types';

const logger = new Logger('DeterministicExtractor');

const MARKDOWN_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
/** List markers, including the bullet glyphs a Google Docs plain-text export emits. */
const LIST_MARKER = /^\s{0,3}(?:[-*+]\s+|[\u2022\u25cf\u25cb\u25aa\u2023\u00b7]\s*|\d{1,3}[.)]\s+|>\s?)/;
const URL = /https?:\/\/\S+|(?:github|gitlab|linkedin)\.com\/\S+/i;

/**
 * A heading candidate in a document that has no markdown at all. Deliberately narrow: a
 * long line, or one ending in sentence punctuation, is prose the candidate wrote, not a
 * section label, and promoting prose to a heading would re-attribute every fact below it.
 */
const MAX_HEADING_LENGTH = 60;

/**
 * Section label -> the kind of fact its body lines are.
 *
 * Matched against the whole heading so `Experience` classifies but `Experience with Java`
 * — a skill line someone wrote without a bullet — does not silently become a section.
 */
const SECTION_KINDS: ReadonlyArray<{ pattern: RegExp; kind: FactKind }> = [
  {
    pattern:
      /^(?:work\s+|professional\s+|relevant\s+)?experience$|^employment(?:\s+history)?$|^career(?:\s+history)?$|^work\s+history$/i,
    kind: 'achievement',
  },
  {
    pattern:
      /^(?:technical\s+|core\s+|key\s+)?skills$|^competenc(?:y|ies)$|^technologies$|^tech(?:nical)?\s+stack$|^tools(?:\s+(?:and|&)\s+technologies)?$/i,
    kind: 'skill',
  },
  { pattern: /^education$|^academic(?:\s+background)?$|^qualifications$/i, kind: 'education' },
  {
    pattern: /^certificat(?:ion|e)s?$|^licen[cs]es?$|^courses?$|^training$/i,
    kind: 'certification',
  },
  {
    pattern: /^projects?$|^portfolio$|^publications?$|^open[\s-]source$|^links?$/i,
    kind: 'proof',
  },
];

/**
 * A quantity stated by the CV, captured VERBATIM. Never computed, never rounded, and never
 * synthesised from two numbers: a metric on a CV is a claim an employer can check, so it
 * may only ever be a substring of what the candidate actually wrote.
 */
const METRIC = new RegExp(
  [
    '\\d+(?:[.,]\\d+)?\\s*%',
    '[€$£¥]\\s?\\d+(?:[.,]\\d+)?\\s*(?:k|m|bn|million|billion)?',
    '\\d+(?:[.,]\\d+)?\\s*(?:k|m|bn|x)\\b',
    '\\d+(?:[.,]\\d+)?\\s*(?:million|billion|users|customers|clients|people|engineers|requests|transactions|hours|days|weeks|months|years|ms|seconds)\\b',
  ].join('|'),
  'i',
);

export interface DeterministicResult {
  facts: ContextualFact[];
  /** Body lines that produced a fact. */
  classifiedLines: number;
  /** Body lines that were candidates for becoming a fact. */
  bodyLines: number;
  /** Distinct section labels the document structure actually yielded. */
  sectionsRecognised: number;
}

/** The quantity the line states, or null. Absence of a metric is a fact about the CV. */
export function extractMetric(line: string): string | null {
  const match = METRIC.exec(line);
  return match ? match[0].trim() : null;
}

/** The kind of fact body lines under this heading are, or null when the label is unknown. */
export function classifySection(heading: string): FactKind | null {
  const normalised = heading.trim().replace(/[:\s]+$/, '');
  return SECTION_KINDS.find((entry) => entry.pattern.test(normalised))?.kind ?? null;
}

/**
 * Extracts the fact graph from the CV's own structure, with no model involved.
 *
 * Every field is copied or derived from the document: the text is the candidate's line
 * verbatim, the kind comes from the section heading it sits under, the metric is a
 * substring of the line, and `{title, org, period}` come from the entry heading. Nothing
 * here can invent a fact the CV does not state, which is the property spec §6 asks for and
 * the one a language model can only be instructed to respect.
 *
 * Lines under an unrecognised section (or under none) are counted but NOT emitted: guessing
 * a kind is the fabrication this path exists to avoid. When too much of the document lands
 * there, `isDeterministicSufficient` reports the document as unstructured so the caller can
 * fall back to the model rather than persisting a half-read CV.
 */
export function deterministicExtract(markdown: string): DeterministicResult {
  const facts: ContextualFact[] = [];
  const sections = new Set<string>();
  let bodyLines = 0;
  let classifiedLines = 0;

  let sectionLabel: string | null = null;
  let sectionKind: FactKind | null = null;
  let title: string | null = null;
  let org: string | null = null;
  let period: string | null = null;
  let inFence = false;

  const openSection = (label: string, kind: FactKind | null) => {
    sectionLabel = label;
    sectionKind = kind;
    // A new section clears the entry context: carrying an employer into `Skills` would
    // attribute a skill to a company the CV never linked it to.
    title = null;
    org = null;
    period = null;
    if (kind) sections.add(label.toLowerCase());
  };

  const openEntry = (heading: string) => {
    const entry = parseEntryHeading(heading);
    title = entry.title;
    org = entry.org;
    period = entry.period;
    return entry;
  };

  const push = (text: string, kind: FactKind) => {
    facts.push({
      kind,
      text,
      payload: {},
      metric: extractMetric(text),
      position: facts.length,
      section: sectionLabel,
      title,
      org,
      period,
    });
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    if (FENCE.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    // Inside a fence a `##` is literal text the candidate wrote, not document structure.
    if (inFence) continue;

    const headingMatch = MARKDOWN_HEADING.exec(rawLine);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();

      // H1 is the candidate's name, never a section — it only resets context.
      if (level === 1) {
        openSection('', null);
        sectionLabel = null;
        continue;
      }

      if (level === 2) {
        openSection(text, classifySection(text));
        continue;
      }

      const entry = openEntry(text);
      // The entry heading is itself a fact the CV states, and the only place a role is
      // written down. Emitted verbatim, and only when the heading proves its own shape.
      if (entry.title && entry.org) {
        classifiedLines += 1;
        bodyLines += 1;
        push(text, 'role');
      }
      continue;
    }

    const line = strip(rawLine);
    if (line.length === 0) continue;

    // A plain-text export (Google Docs `?format=txt`) has no `#` markers at all, so a bare
    // line carrying a known section label is the only structure the document has left.
    if (!wasListItem(rawLine) && line.length <= MAX_HEADING_LENGTH) {
      const kind = classifySection(line);
      if (kind) {
        openSection(line.replace(/[:\s]+$/, ''), kind);
        continue;
      }

      // `Senior Developer — Acme (2019–2022)` as a bare line is an entry heading in a
      // document that lost its markdown.
      const entry = parseEntryHeading(line);
      if (entry.title && entry.org && sectionKind) {
        openEntry(line);
        bodyLines += 1;
        classifiedLines += 1;
        push(line, 'role');
        continue;
      }
    }

    bodyLines += 1;

    // A link is verifiable evidence wherever it appears, so it outranks the section.
    if (URL.test(line)) {
      classifiedLines += 1;
      push(line, 'proof');
      continue;
    }

    if (!sectionKind) continue;

    classifiedLines += 1;
    push(line, sectionKind);
  }

  return { facts, classifiedLines, bodyLines, sectionsRecognised: sections.size };
}

/**
 * Whether the document was structured enough to be read without a model.
 *
 * All three conditions guard the same failure: a CV whose structure we did not understand
 * would yield a small, lopsided fact graph that still looks like a valid result, and every
 * later stage treats the fact graph as ground truth.
 */
export function isDeterministicSufficient(result: DeterministicResult): boolean {
  if (result.sectionsRecognised === 0) return false;
  if (result.facts.length < 3) return false;
  return result.bodyLines > 0 && result.classifiedLines / result.bodyLines >= 0.5;
}

/** Why the document could not be read structurally, for the fallback log line. */
export function describeShortfall(result: DeterministicResult): string {
  const coverage = result.bodyLines === 0 ? 0 : Math.round((result.classifiedLines / result.bodyLines) * 100);
  return (
    `sections=${result.sectionsRecognised} facts=${result.facts.length} ` +
    `coverage=${coverage}% (${result.classifiedLines}/${result.bodyLines} lines)`
  );
}

function wasListItem(rawLine: string): boolean {
  return LIST_MARKER.test(rawLine);
}

function strip(rawLine: string): string {
  return rawLine
    .replace(LIST_MARKER, '')
    .replace(/\*\*|__|[*_`]/g, '')
    .trim();
}

export { logger as deterministicExtractorLogger };
