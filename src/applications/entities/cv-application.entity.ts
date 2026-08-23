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

  @Column({ type: 'text' })
  renderLanguage!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
