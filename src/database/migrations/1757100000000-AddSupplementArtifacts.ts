import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSupplementArtifacts1757100000000 implements MigrationInterface {
  name = 'AddSupplementArtifacts1757100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_artifact" ALTER COLUMN "renderId" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "cv_artifact" ADD COLUMN "supplementId" uuid`);
    await queryRunner.query(
      `ALTER TABLE "cv_artifact" ADD CONSTRAINT "uq_artifact_supplement_kind" UNIQUE ("supplementId", "kind")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_artifact" DROP CONSTRAINT "uq_artifact_supplement_kind"`);
    await queryRunner.query(`ALTER TABLE "cv_artifact" DROP COLUMN "supplementId"`);
    await queryRunner.query(`ALTER TABLE "cv_artifact" ALTER COLUMN "renderId" SET NOT NULL`);
  }
}
