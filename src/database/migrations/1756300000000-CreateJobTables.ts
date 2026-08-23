import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateJobTables1756300000000 implements MigrationInterface {
  name = 'CreateJobTables1756300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "cv_job" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" text NOT NULL,
        "url" text,
        "source" text NOT NULL,
        "rawText" text,
        "parsed" jsonb,
        "company" text,
        "title" text,
        "language" text,
        "fetchStatus" text NOT NULL,
        "fetchReason" text,
        "fetchedAt" timestamptz,
        "expiresAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_job_user" ON "cv_job" ("userId")`);
    await queryRunner.query(`CREATE INDEX "idx_job_fetch_status" ON "cv_job" ("fetchStatus")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "cv_job"`);
  }
}
