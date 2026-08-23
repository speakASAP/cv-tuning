import { createHash, randomUUID } from 'crypto';
import { FactKind } from './master.types';

export interface StoredFact {
  id: string;
  contentHash: string;
  position: number;
}

export interface ExtractedFact {
  kind: FactKind;
  text: string;
  payload: Record<string, unknown>;
  metric: string | null;
  position: number;
}

export type MatchedFact = ExtractedFact & {
  id: string;
  contentHash: string;
  isNew: boolean;
};

/**
 * Identity of a fact is its normalised text. Whitespace and casing changes are not
 * edits, so they must not orphan a fact and break every provenance link pointing at it.
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
export function matchFactIds(previous: StoredFact[], extracted: ExtractedFact[]): MatchedFact[] {
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
