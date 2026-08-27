/**
 * Proof-of-work surfacing (spec §6.2).
 *
 * `cv_fact.kind = 'proof'` holds portfolio links, repositories, case studies, and work
 * samples. It has been a valid fact kind since Phase 1 and reached the user nowhere; this
 * module is what surfaces it.
 *
 * Deliberately pure and LLM-free. A proof fact is, most of the time, a URL, and a model
 * asked to "include the candidate's portfolio links" will eventually reformat, truncate, or
 * invent one — a broken link presented as a working one is worse than no link at all.
 * Selection and formatting are therefore code, and the fact text is reproduced verbatim,
 * which is also why proof output needs no entailment pass: nothing was rewritten.
 */

/**
 * The minimum a fact must expose to be classified. Structural on purpose: both
 * `applications/application.types.ts#FactSnapshot` and `entities/cv-fact.entity.ts` satisfy
 * it, so this module couples to neither. `master/` must not import from `applications/` —
 * the dependency runs one way only.
 */
export interface ProofSource {
  factId: string;
  text: string;
  kind: string;
}

export interface ProofItem {
  factId: string;
  /** What the link is, for a reader. Never empty — falls back to the raw text. */
  label: string;
  /** Null when the fact carries no http(s) URL, which is a normal case, not a failure. */
  url: string | null;
  /** The fact exactly as written, kept so a later reader can see what was condensed. */
  text: string;
}

/**
 * Conservative by design. Only `http`/`https`: a `mailto:` or `ftp:` string is not something
 * a hiring reader clicks through to a work sample, and treating one as a link would put a
 * dead reference on a CV. Brackets and angle brackets terminate the match because they are
 * markdown/markup delimiters far more often than they are path characters.
 */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()[\]]+/i;

/**
 * Punctuation that ends a sentence rather than a URL. A trailing `/` is deliberately NOT
 * here: it is part of the path, and stripping it would change which resource is addressed.
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

/** The separator the importers emit between a label and its link. Not a hyphen. */
const EM_DASH = '—';

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Normalised form for de-duplication only — never for display.
 *
 * The host is lowercased because RFC 3986 defines it case-insensitively; the path is left
 * alone because it is case-SENSITIVE, and folding it would collapse `/Work` and `/work` into
 * one entry when they may be two different pages.
 */
function dedupeKeyForUrl(url: string): string {
  const match = /^(https?:\/\/)([^/?#]*)(.*)$/i.exec(url);
  if (!match) {
    return url;
  }
  return `${match[1].toLowerCase()}${match[2].toLowerCase()}${match[3]}`;
}

/**
 * Classifies one fact. Never returns null: a proof fact written as prose, with no link in
 * it, is still proof of work, and dropping it would silently lose something the user chose
 * to write down.
 */
export function parseProof(fact: ProofSource): ProofItem {
  const text = fact.text;
  const match = URL_PATTERN.exec(text);

  if (!match) {
    return { factId: fact.factId, label: collapse(text), url: null, text };
  }

  const raw = match[0];
  const url = raw.replace(TRAILING_PUNCTUATION, '');

  // Remove only the URL occurrence that was matched, so a second link later in the fact
  // survives in the label rather than vanishing.
  const withoutUrl = text.slice(0, match.index) + text.slice(match.index + raw.length);

  // Strip the separator and any punctuation the URL's removal left stranded.
  const label = collapse(
    withoutUrl
      .replace(new RegExp(`\\s*${EM_DASH}\\s*$`), '')
      .replace(/\s*[-–—:,;(]\s*$/, '')
      .replace(/^\s*[)\].,;:]\s*/, ''),
  );

  return {
    factId: fact.factId,
    // A bare URL leaves nothing to label it with; showing the URL beats showing a dash.
    label: label || collapse(text),
    url,
    text,
  };
}

/**
 * Selects and de-duplicates the proof facts in a snapshot.
 *
 * Order is by first appearance and is a CONTRACT, not an incidental: `render-markdown.ts`
 * emits this list into a document whose sha256 spec §6.3 reuses as artifact identity, so an
 * ordering that could vary between two renders of the same facts would break idempotency
 * exactly as an unpinned timestamp would.
 */
export function selectProofFacts(facts: ProofSource[]): ProofItem[] {
  const items: ProofItem[] = [];
  const seen = new Set<string>();

  for (const fact of facts) {
    if (fact.kind !== 'proof') {
      continue;
    }
    if (!collapse(fact.text)) {
      // An empty proof fact would render as a blank bullet on a real CV.
      continue;
    }

    const item = parseProof(fact);
    // A URL-less fact is keyed by its label, and the key is namespaced by which of the two
    // it is: a prose case study and a link that happens to share its wording are two
    // different pieces of evidence, and merging them would drop the link.
    const key = item.url
      ? `url:${dedupeKeyForUrl(item.url)}`
      : `label:${item.label.toLowerCase()}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    items.push(item);
  }

  return items;
}
