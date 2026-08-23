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

export interface ParsedRequirements {
  title: string | null;
  company: string | null;
  language: string;
  requirements: Requirement[];
}

export function isRequirementKind(value: unknown): value is RequirementKind {
  return typeof value === 'string' && (REQUIREMENT_KINDS as readonly string[]).includes(value);
}
