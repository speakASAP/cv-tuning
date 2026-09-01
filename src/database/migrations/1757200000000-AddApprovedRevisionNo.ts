import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddApprovedRevisionNo1757200000000 implements MigrationInterface {
  name = 'AddApprovedRevisionNo1757200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Existing approvals predate a revision checkpoint; NULL honestly means their historical
    // baseline is unknown, instead of guessing from a timestamp and showing a false diff.
    await queryRunner.query(`ALTER TABLE "cv_application" ADD "approvedRevisionNo" int`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_application" DROP COLUMN "approvedRevisionNo"`);
  }
}
