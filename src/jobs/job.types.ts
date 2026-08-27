export const FETCH_STATUSES = ['ok', 'blocked', 'thin', 'failed'] as const;
export type FetchStatus = (typeof FETCH_STATUSES)[number];

export const JOB_SOURCES = ['fetch', 'paste'] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

export const REQUIREMENT_KINDS = ['must', 'nice'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export interface Requirement {
  text: string;
  /** A "must" missing from the CV costs far more in the fit score than a "nice". */
  kind: RequirementKind;
  category: string;
}

/**
 * Where a screening question came from.
 *
 * Homed here rather than in `applications/supplement.types.ts` because `jobs/` is upstream of
 * `applications/` — the parser produces these, and a jobs module importing from applications
 * would invert the dependency. `supplement.types.ts` re-exports it so there is exactly one
 * definition.
 *
 * `user` is a question the applicant pasted from a real application portal. `parsed` is one
 * this service extracted from the posting, which is a GUESS about what will be asked. They
 * must stay distinguishable: presenting a guessed question as one the employer actually asked
 * would have the user answer a question nobody posed, under their own name, on that
 * employer's form.
 */
export const QUESTION_SOURCES = ['user', 'parsed'] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];

export interface ScreeningQuestion {
  text: string;
  source: QuestionSource;
}

export interface ParsedRequirements {
  title: string | null;
  company: string | null;
  language: string;
  requirements: Requirement[];
  /**
   * Questions the posting explicitly asks the applicant to answer. Empty is the COMMON case —
   * most postings ask none — and must never be padded to look productive.
   */
  screeningQuestions: string[];
}

export function isRequirementKind(value: unknown): value is RequirementKind {
  return typeof value === 'string' && (REQUIREMENT_KINDS as readonly string[]).includes(value);
}
