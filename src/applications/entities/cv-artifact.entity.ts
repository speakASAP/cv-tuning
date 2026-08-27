import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { ArtifactKind } from '../application.types';

/**
 * A generated file in MinIO.
 *
 * Exactly one of `renderId` and `supplementId` is set. Each source and kind has one artifact,
 * so retries never produce a second file for the same material.
 */
@Entity('cv_artifact')
@Unique('uq_artifact_render_kind', ['renderId', 'kind'])
@Unique('uq_artifact_supplement_kind', ['supplementId', 'kind'])
export class CvArtifactEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  renderId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  supplementId!: string | null;

  @Column({ type: 'text' })
  kind!: ArtifactKind;

  @Column({ type: 'text' })
  minioKey!: string;

  /** Reused for artifact idempotency, matching the house shape in invoices-microservice. */
  @Column({ type: 'text' })
  sha256!: string;

  @Column({ type: 'int' })
  byteSize!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
