import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 5, spec §5. All three columns are nullable with no backfill: an application that
 * predates outcome tracking genuinely has no send date, and inventing one — say, from
 * `updatedAt` — would put fabricated timestamps into the funnel the dashboard reports on.
 */
export class AddOutcomeTracking1756800000000 implements MigrationInterface {
  name = 'AddOutcomeTracking1756800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_application" ADD COLUMN "sentAt" timestamptz`);
    await queryRunner.query(`ALTER TABLE "cv_application" ADD COLUMN "outcomeAt" timestamptz`);
    await queryRunner.query(`ALTER TABLE "cv_application" ADD COLUMN "nudgedAt" timestamptz`);
    // The dashboard funnel filters by user and groups by state; without this it seq-scans.
    await queryRunner.query(
      `CREATE INDEX "idx_application_user_state" ON "cv_application" ("userId", "state")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_application_user_state"`);
    await queryRunner.query(`ALTER TABLE "cv_application" DROP COLUMN "nudgedAt"`);
    await queryRunner.query(`ALTER TABLE "cv_application" DROP COLUMN "outcomeAt"`);
    await queryRunner.query(`ALTER TABLE "cv_application" DROP COLUMN "sentAt"`);
  }
}
