import { createHash, randomUUID } from 'crypto';
import { FactKind } from './master.types';

export interface StoredFact {
  id: string;
  contentHash: string;
  position: number;
}

/**
 * Where a fact sits in the master CV's heading structure, DERIVED IN CODE by walking the
 * markdown headings (`fact-provenance.ts`) — never reported by the extraction model.
 *
 * Letting the model name the employer or the date range would create a fabrication surface
 * on exactly the fields an employer judges a CV by, which is what spec §6 exists to
 * prevent. Every field is null when the fact could not be confidently mapped: a wrong
 * employer on a CV is worse than an absent one.
 */
export interface FactContext {
  /** The H2 the fact sits under, e.g. "Experience". */
  section: string | null;
  /** The employer/institution from a `### Role — Company (period)` entry heading. */
  org: string | null;
  /** The parenthesised date range from that entry heading, verbatim. */
  period: string | null;
}

export interface ExtractedFact {
  kind: FactKind;
  text: string;
  payload: Record<string, unknown>;
  metric: string | null;
  position: number;
}

/** An extracted fact carrying its derived heading context. What the master CV persists. */
export type ContextualFact = ExtractedFact & FactContext;

export type MatchedFact = ContextualFact & {
  id: string;
  contentHash: string;
  isNew: boolean;
};

/**
 * Identity of a fact is its normalised text. Whitespace and casing changes are not
 * edits, so they must not orphan a fact and break every provenance link pointing at it.
 *
 * DERIVED CONTEXT IS DELIBERATELY EXCLUDED. If `section`/`org`/`period` entered this hash,
 * re-titling a job heading would orphan every fact under it and break every provenance link
 * a tailored CV already holds. Pinned by `fact-provenance.spec.ts`.
 */
export function hashFactContent(text: string): string {
  const normalised = text.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalised).digest('hex');
}

/**
 * Matches newly extracted facts against previously stored ones so unchanged bullets keep
 * their ids. Each stored fact is consumed at most once: two identical bullets must not
 * collapse onto one id, or a tailored CV citing the second would point at the first.
 *
 * Where several stored facts share a hash, the one nearest the extracted fact's position
 * wins, which keeps ids stable when a duplicated line is edited in one place only.
 */
export function matchFactIds(previous: StoredFact[], extracted: ContextualFact[]): MatchedFact[] {
  const byHash = new Map<string, StoredFact[]>();
  for (const fact of previous) {
    const bucket = byHash.get(fact.contentHash);
    if (bucket) {
      bucket.push(fact);
    } else {
      byHash.set(fact.contentHash, [fact]);
    }
  }

  return extracted.map((fact) => {
    const contentHash = hashFactContent(fact.text);
    const candidates = byHash.get(contentHash);

    if (!candidates || candidates.length === 0) {
      return { ...fact, id: randomUUID(), contentHash, isNew: true };
    }

    // Nearest position wins, so editing one of two duplicate lines keeps the other stable.
    let bestIndex = 0;
    let bestDistance = Math.abs(candidates[0].position - fact.position);
    for (let i = 1; i < candidates.length; i += 1) {
      const distance = Math.abs(candidates[i].position - fact.position);
      if (distance < bestDistance) {
        bestIndex = i;
        bestDistance = distance;
      }
    }

    const [claimed] = candidates.splice(bestIndex, 1);
    return { ...fact, id: claimed.id, contentHash, isNew: false };
  });
}
