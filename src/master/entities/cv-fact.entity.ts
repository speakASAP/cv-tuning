import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { FactKind } from '../master.types';

@Entity('cv_fact')
export class CvFactEntity {
  /** Row identity. A fact is re-inserted for every master version that contains it. */
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Stable identity ACROSS versions. Unchanged bullets keep the same factId when a new
   * master version is saved, so provenance recorded against a factId survives edits
   * elsewhere in the CV. This is what tailored bullets cite, never `id`.
   */
  @Index('idx_fact_fact_id')
  @Column({ type: 'uuid' })
  factId!: string;

  @Index('idx_fact_master')
  @Column({ type: 'uuid' })
  masterId!: string;

  @Column({ type: 'text' })
  kind!: FactKind;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  payload!: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  metric!: string | null;

  /** Stable identity across edits: unchanged bullets keep their id, so provenance survives. */
  @Index('idx_fact_content_hash')
  @Column({ type: 'text' })
  contentHash!: string;

  @Column({ type: 'int' })
  position!: number;
}
