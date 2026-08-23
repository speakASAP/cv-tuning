import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SourceType } from '../master.types';

@Entity('cv_master')
export class CvMasterEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_master_user')
  @Column({ type: 'text' })
  userId!: string;

  @Column({ type: 'int' })
  version!: number;

  @Column({ type: 'text' })
  sourceType!: SourceType;

  @Column({ type: 'text', nullable: true })
  sourceRef!: string | null;

  /** SOURCE OF TRUTH. Facts are derived from this, never the other way round. */
  @Column({ type: 'text' })
  markdown!: string;

  /**
   * SHA-256 of the markdown the current facts were extracted from. If this stops matching
   * the markdown, the facts are stale and every read must raise rather than silently serve
   * outdated facts to tailoring.
   */
  @Column({ type: 'text' })
  factsExtractedFromMarkdownSha!: string;

  @Column({ type: 'bool', default: false })
  isCurrent!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
