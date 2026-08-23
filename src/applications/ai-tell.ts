/**
 * Detects the phrases AI-content classifiers key on (spec §6.1).
 *
 * Pure and deterministic on purpose: this is shown to the user before download, so it must
 * cost nothing, never fail, and never vary between runs of the same text.
 */

export const AI_TELL_PHRASES = [
  'leveraged',
  'leverage',
  'spearheaded',
  'passionate about',
  'results-driven',
  'proven track record',
  'track record of success',
  'dynamic professional',
  'seasoned professional',
  'synergy',
  'synergies',
  'best-in-class',
  'cutting-edge',
  'thought leader',
  'go-getter',
  'detail-oriented',
  'self-starter',
  'team player',
  'hit the ground running',
  'wear many hats',
  'delve',
  'delved',
  'robust solutions',
  'seamlessly',
  'meticulous',
  'tapestry',
] as const;

export interface AiTellHit {
  phrase: string;
  count: number;
}

export interface AiTellResult {
  /** 0-100. Occurrences per 100 words, scaled, capped. */
  score: number;
  hits: AiTellHit[];
}

/** Tells are weighted per 100 words so a long CV is not penalised for its length. */
const PER_WORDS = 100;
const POINTS_PER_OCCURRENCE = 12;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function scoreAiTell(text: string): AiTellResult {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (words === 0) {
    return { score: 0, hits: [] };
  }

  const hits: AiTellHit[] = [];
  let occurrences = 0;

  for (const phrase of AI_TELL_PHRASES) {
    // \b on both ends so "leveraged" inside "unleveraged" is not a hit. Hyphenated tells
    // still work because \b sits between a word character and the hyphen.
    const pattern = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'gi');
    const count = (text.match(pattern) ?? []).length;
    if (count > 0) {
      hits.push({ phrase, count });
      occurrences += count;
    }
  }

  const density = (occurrences / words) * PER_WORDS;
  const score = Math.min(100, Math.round(density * POINTS_PER_OCCURRENCE));

  return { score, hits };
}
