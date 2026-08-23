import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { FactSnapshot, RenderProvenance } from '../application.types';

/**
 * One revision of a tailored CV.
 *
 * `(applicationId, revisionNo)` is unique so two concurrent generations cannot both claim
 * revision 2 and leave the diff chain ambiguous.
 */
@Entity('cv_render')
@Unique('uq_render_revision', ['applicationId', 'revisionNo'])
export class CvRenderEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_render_application')
  @Column({ type: 'uuid' })
  applicationId!: string;

  @Column({ type: 'int' })
  revisionNo!: number;

  @Column({ type: 'text' })
  markdown!: string;

  /** Facts exactly as used. A render stays reproducible after the master CV changes. */
  @Column({ type: 'jsonb' })
  factsSnapshot!: FactSnapshot[];

  /** bullet -> {sourceFactId, verdict, span}, plus anything the source constraint dropped. */
  @Column({ type: 'jsonb' })
  provenance!: RenderProvenance;

  @Column({ type: 'int', nullable: true })
  fitScore!: number | null;

  @Column({ type: 'jsonb', nullable: true })
  gaps!: unknown;

  /** §6.1 — how strongly the prose reads as AI-written. Shown before download. */
  @Column({ type: 'int', nullable: true })
  aiTellScore!: number | null;

  @Column({ type: 'text' })
  createdBy!: 'ai' | 'user';

  /**
   * The model that ACTUALLY served generation, not the tier requested (spec §8.0).
   * Recording the tier alone would hide a silent fallback.
   */
  @Column({ type: 'text' })
  modelUsed!: string;

  /** The entailment validator's served model — a separate call, so a separate record. */
  @Column({ type: 'text', nullable: true })
  validatorModelUsed!: string | null;

  @Column({ type: 'text' })
  requestedTier!: string;

  @Column({ type: 'boolean', default: false })
  degraded!: boolean;

  /** Lets a later eval attribute a grounding regression to a specific prompt change. */
  @Column({ type: 'text' })
  promptVersion!: string;

  /** Unique so a retried request cannot double-spend a generation. */
  @Index('idx_render_idempotency', { unique: true })
  @Column({ type: 'text' })
  idempotencyKey!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
