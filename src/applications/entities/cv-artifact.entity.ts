import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { ArtifactKind } from '../application.types';

/**
 * A generated file in MinIO.
 *
 * `(renderId, kind)` is unique: approving twice must never produce a second PDF, and a
 * download must never be ambiguous about which file was approved.
 */
@Entity('cv_artifact')
@Unique('uq_artifact_render_kind', ['renderId', 'kind'])
export class CvArtifactEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  renderId!: string;

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
