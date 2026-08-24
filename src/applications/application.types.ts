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
  /**
   * Stable identity within its render, so a confirm-or-drop decision addresses one specific
   * bullet rather than "whatever bullet happens to carry this text".
   *
   * Optional in the TYPE, never absent in practice: `provenance` is persisted `jsonb`, so
   * renders written before this field existed do not carry it. `bullet-identity.ts#bulletIdOf`
   * derives exactly the same value from `sourceFactId` for those rows, which is what keeps an
   * old render decidable without a data migration. Always read it through that helper, never
   * directly — a raw read would see `undefined` on every stored render.
   *
   * Never emitted into `cv_render.markdown` or into either export writer, so the artifact
   * sha256 spec §6.3 reuses for idempotency is unaffected by it.
   */
  bulletId?: string;
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
  /**
   * Where the fact sat in the master CV's heading structure, derived in code at extraction
   * time (`master/fact-provenance.ts`). Snapshotted with the fact so a render can state the
   * job title, employer, and period it was generated against even after the master CV is
   * re-titled.
   *
   * Null when the fact could not be confidently mapped, which is a normal outcome for a
   * heading-less CV. Consumers must treat null as "unknown" and print nothing — never
   * substitute a nearby value.
   */
  section: string | null;
  title: string | null;
  org: string | null;
  period: string | null;
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
  /**
   * The `TailoredBullet.bulletId` this decision was made about — the field the approval gate
   * actually matches on.
   *
   * Optional for the same reason as `TailoredBullet.bulletId`: `confirmedOverreach` is
   * persisted `jsonb` and rows written before this existed carry only `bulletText`. Those are
   * resolved back by text, but only when the text is unambiguous within the render — see
   * `bullet-identity.ts#decidedBulletIds`.
   */
  bulletId?: string;
  /**
   * The bullet's text as it read when the decision was made. Retained even now that
   * `bulletId` carries identity: this is the audit trail proving a person accepted a specific
   * CLAIM, and an opaque id alone would not show a later reader what was accepted.
   */
  bulletText: string;
  decision: 'confirm' | 'drop';
  decidedBy: string;
  decidedAt: string;
}
