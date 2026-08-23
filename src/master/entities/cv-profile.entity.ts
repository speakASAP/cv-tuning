import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('cv_profile')
export class CvProfileEntity {
  /** auth-microservice user id. This service never owns identity. */
  @PrimaryColumn({ type: 'text' })
  userId!: string;

  @Column({ type: 'text', default: 'en' })
  locale!: string;

  /**
   * Consent columns exist from day one even though the consent flow is Phase 7, so that
   * enabling GDPR later is a behaviour change and not a migration against live data.
   */
  @Column({ type: 'text', nullable: true })
  consentVersion!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  consentAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
