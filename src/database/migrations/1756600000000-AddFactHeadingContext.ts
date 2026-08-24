import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the derived heading context (spec §4.1) to `cv_fact`.
 *
 * All three columns are nullable and added without a default: migrations run via
 * `migrationsRun: true` at boot, so existing rows must stay valid untouched. NULL is also
 * the correct value for them — those facts were extracted before derivation existed, and
 * backfilling a guessed employer onto them would be exactly the fabrication spec §6 forbids.
 * They pick up real context the next time the master CV is saved and re-extracted.
 */
export class AddFactHeadingContext1756600000000 implements MigrationInterface {
  name = 'AddFactHeadingContext1756600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_fact" ADD "section" text`);
    await queryRunner.query(`ALTER TABLE "cv_fact" ADD "org" text`);
    await queryRunner.query(`ALTER TABLE "cv_fact" ADD "period" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_fact" DROP COLUMN "period"`);
    await queryRunner.query(`ALTER TABLE "cv_fact" DROP COLUMN "org"`);
    await queryRunner.query(`ALTER TABLE "cv_fact" DROP COLUMN "section"`);
  }
}
