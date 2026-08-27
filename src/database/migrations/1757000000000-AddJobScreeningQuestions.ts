import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobScreeningQuestions1757000000000 implements MigrationInterface {
  name = 'AddJobScreeningQuestions1757000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // NOT NULL with a default: every existing row becomes "this posting asks no questions",
    // which is the correct reading of a posting parsed before the field existed. A nullable
    // column would add a third state ("unknown") that no consumer has a meaning for.
    await queryRunner.query(
      `ALTER TABLE "cv_job" ADD "screeningQuestions" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_job" DROP COLUMN "screeningQuestions"`);
  }
}
