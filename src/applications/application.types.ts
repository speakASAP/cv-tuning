export const APPLICATION_STATES = [
  'scored',
  'generating',
  'generation_failed',
  'in_review',
  'revising',
  'approved',
  'downloaded',
  'marked_sent',
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];

export const OUTCOMES = ['interview', 'rejected', 'offer', 'ghosted'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const ENTAILMENT_VERDICTS = ['supported', 'unsupported', 'overreach'] as const;
export type EntailmentVerdict = (typeof ENTAILMENT_VERDICTS)[number];

/**
 * One tailored bullet, bound to exactly one master fact.
 *
 * The one-to-one binding is the first grounding layer (spec §6): if every output bullet is
 * a transformation of a single input bullet, the diff is provably a rewrite rather than an
 * invention. Allowing two source facts would let the model merge them into a claim neither
 * one supports.
 */
export interface TailoredBullet {
  text: string;
  /** The single master fact this bullet rewrites. Validated against the snapshot, never trusted. */
  sourceFactId: string;
  /** The JD requirement this rewrite targets, for the "why" chip in §7. */
  targetRequirement: string | null;
  verdict: EntailmentVerdict;
  /** The offending span when the verdict is not `supported`. Never null for a non-supported verdict. */
  span: string | null;
}

/** Facts as they were at render time, so a render stays reproducible after the master changes. */
export interface FactSnapshot {
  factId: string;
  text: string;
  kind: string;
}

export interface RenderProvenance {
  bullets: TailoredBullet[];
  /** Bullets the source constraint rejected, kept so a drop is diagnosable rather than invisible. */
  droppedBullets: { text: string; reason: string }[];
}

export const CHAT_ROLES = ['user', 'assistant'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export const INPUT_MODES = ['text', 'voice'] as const;
export type InputMode = (typeof INPUT_MODES)[number];

export const ARTIFACT_KINDS = ['pdf', 'docx'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * A human decision on an `overreach` bullet (spec §6 layer 3). This is the audit trail
 * proving a person accepted a new claim, so it records who decided and when — never just
 * that a decision happened.
 */
export interface ConfirmedClaim {
  bulletText: string;
  decision: 'confirm' | 'drop';
  decidedBy: string;
  decidedAt: string;
}
