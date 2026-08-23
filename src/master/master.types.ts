export const FACT_KINDS = ['role', 'achievement', 'skill', 'education', 'certification', 'proof'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const SOURCE_TYPES = ['paste', 'upload', 'gdocs', 'linkedin'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export function isFactKind(value: unknown): value is FactKind {
  return typeof value === 'string' && (FACT_KINDS as readonly string[]).includes(value);
}
