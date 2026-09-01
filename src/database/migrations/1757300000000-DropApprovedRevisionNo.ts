import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reverts 1757200000000-AddApprovedRevisionNo: diff was rolled back to comparing a revision
 * against its predecessor (or the master CV for revision 1) rather than the last-approved
 * revision, so this column no longer has a reader anywhere in the codebase.
 */
export class DropApprovedRevisionNo1757300000000 implements MigrationInterface {
  name = 'DropApprovedRevisionNo1757300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_application" DROP COLUMN "approvedRevisionNo"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_application" ADD "approvedRevisionNo" int`);
  }
}
