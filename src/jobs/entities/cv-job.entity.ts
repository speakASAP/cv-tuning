import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { FetchStatus, JobSource, ParsedRequirements } from '../job.types';

@Entity('cv_job')
export class CvJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_job_user')
  @Column({ type: 'text' })
  userId!: string;

  /** Null for a pasted posting, which has no source URL. */
  @Column({ type: 'text', nullable: true })
  url!: string | null;

  @Column({ type: 'text' })
  source!: JobSource;

  /** Third-party content. Phase 7 expires this while keeping `parsed`. */
  @Column({ type: 'text', nullable: true })
  rawText!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  parsed!: ParsedRequirements | null;

  @Column({ type: 'text', nullable: true })
  company!: string | null;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  language!: string | null;

  /**
   * Questions the posting explicitly asks the applicant to answer.
   *
   * Stored as its own column rather than read out of `parsed` so it stays queryable and
   * survives Phase 7's expiry of `rawText`. Defaults to `[]`, never null: "the posting asks no
   * questions" and "we have not parsed this posting" are different states, and the second is
   * already carried by a null `parsed`.
   */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  screeningQuestions!: string[];

  /** Explicit, never inferred from an empty rawText. */
  @Index('idx_job_fetch_status')
  @Column({ type: 'text' })
  fetchStatus!: FetchStatus;

  /** Populated whenever fetchStatus is not ok, so a failure is diagnosable. */
  @Column({ type: 'text', nullable: true })
  fetchReason!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  fetchedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
