import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the derived job title to `cv_fact`, alongside the `section`/`org`/`period` that
 * `AddFactHeadingContext1756600000000` added (spec §4.1).
 *
 * Nullable, no default, and deliberately NO BACKFILL. Migrations run via `migrationsRun: true`
 * at boot, so existing rows must stay valid untouched — and NULL is the correct value for
 * them, not an inconvenience to paper over: those facts were extracted before title derivation
 * existed, and there is no way to recover the heading they sat under from the row itself.
 * Guessing one from a neighbouring row would put a job title the candidate never held onto a
 * document an employer reads, which is exactly the fabrication spec §6 forbids. They pick up a
 * real title the next time the master CV is saved and re-extracted.
 *
 * `title` is NOT part of `contentHash` (see `fact-identity.ts#hashFactContent`), so this
 * column can be populated on a later save without orphaning a single fact id.
 */
export class AddFactTitle1756700000000 implements MigrationInterface {
  name = 'AddFactTitle1756700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_fact" ADD "title" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_fact" DROP COLUMN "title"`);
  }
}
