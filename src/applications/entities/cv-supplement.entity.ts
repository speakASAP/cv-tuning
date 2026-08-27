import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { FactSnapshot } from '../application.types';
import { SupplementKind, SupplementProvenance } from '../supplement.types';

/**
 * One revision of one non-CV application material — a cover letter or a set of screening
 * answers.
 *
 * `(applicationId, kind, revisionNo)` is unique for the same reason `cv_render` pins
 * `(applicationId, revisionNo)`: two concurrent generations must not both claim revision 2 and
 * leave the diff chain ambiguous. `kind` is part of the key because a cover letter and the
 * screening answers revise independently — regenerating one must not consume the other's
 * revision number.
 */
@Entity('cv_supplement')
@Unique('uq_supplement_revision', ['applicationId', 'kind', 'revisionNo'])
export class CvSupplementEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_supplement_application')
  @Column({ type: 'uuid' })
  applicationId!: string;

  @Column({ type: 'text' })
  kind!: SupplementKind;

  @Column({ type: 'int' })
  revisionNo!: number;

  /** The rendered Markdown, assembled from code-built prose and validated paragraphs. */
  @Column({ type: 'text' })
  content!: string;

  /**
   * Facts exactly as used. Snapshotted for the same reason `cv_render` snapshots them
   * (spec §4.2): a supplement stays reproducible, and auditable, after the master CV changes.
   */
  @Column({ type: 'jsonb' })
  factsSnapshot!: FactSnapshot[];

  /** paragraph -> {sourceFactId, verdict, span}, plus everything that was dropped and why. */
  @Column({ type: 'jsonb' })
  provenance!: SupplementProvenance;

  /** §6.1 — how strongly the prose reads as AI-written. Shown before download. */
  @Column({ type: 'int', nullable: true })
  aiTellScore!: number | null;

  /**
   * The model that ACTUALLY served generation, not the tier requested (spec §8.0).
   * Recording the tier alone would hide a silent fallback.
   */
  @Column({ type: 'text' })
  modelUsed!: string;

  /** Lets a later eval attribute a grounding regression to a specific prompt change. */
  @Column({ type: 'text' })
  promptVersion!: string;

  /** The entailment validator's served model — a separate call, so a separate record. */
  @Column({ type: 'text', nullable: true })
  validatorModelUsed!: string | null;

  @Column({ type: 'text', nullable: true })
  validatorPromptVersion!: string | null;

  /** Unique so a retried request cannot double-spend a generation. */
  @Index('idx_supplement_idempotency', { unique: true })
  @Column({ type: 'text' })
  idempotencyKey!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
