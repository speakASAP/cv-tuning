import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ApplicationState, Outcome } from '../application.types';

@Entity('cv_application')
export class CvApplicationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_application_user')
  @Column({ type: 'text' })
  userId!: string;

  @Index('idx_application_job')
  @Column({ type: 'uuid' })
  jobId!: string;

  /**
   * IMMUTABLE PIN (spec §4.2). Set once at creation from whichever master was current then,
   * and never re-read from `is_current` afterwards. Editing the master CV must not
   * retroactively change what the user already reviewed or downloaded.
   */
  @Column({ type: 'uuid' })
  masterVersionId!: string;

  @Column({ type: 'text' })
  state!: ApplicationState;

  /** Set when the state machine reaches a wait-for-signal state; null until then. */
  @Column({ type: 'text', nullable: true })
  bpcpInstanceId!: string | null;

  /** Populated only when the state is generation_failed, so the failure is diagnosable. */
  @Column({ type: 'text', nullable: true })
  stateError!: string | null;

  @Column({ type: 'text', nullable: true })
  outcome!: Outcome | null;

  /**
   * When the user ASSERTED they submitted (spec §5). Distinct from `updatedAt`, which moves on
   * every write: the funnel measures reply latency from the send, so it needs the send's own
   * timestamp. Null until the user marks it sent — never inferred from a download.
   */
  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  /** When the outcome was recorded. Null while `outcome` is null; the two are written together. */
  @Column({ type: 'timestamptz', nullable: true })
  outcomeAt!: Date | null;

  /**
   * When the "any response?" nudge was sent (spec §5). Set once and checked before sending, so a
   * BPCP retry or a duplicate timeout delivery cannot nag the user twice about one application.
   */
  @Column({ type: 'timestamptz', nullable: true })
  nudgedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  /** Counts AI revision turns only, so the cap bounds model spend and nothing else. */
  @Column({ type: 'int', default: 0 })
  revisionCount!: number;

  @Column({ type: 'text' })
  renderLanguage!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
