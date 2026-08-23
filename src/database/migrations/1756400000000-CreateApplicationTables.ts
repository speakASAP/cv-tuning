import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateApplicationTables1756400000000 implements MigrationInterface {
  name = 'CreateApplicationTables1756400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "cv_application" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" text NOT NULL,
        "jobId" uuid NOT NULL,
        "masterVersionId" uuid NOT NULL,
        "state" text NOT NULL,
        "bpcpInstanceId" text,
        "stateError" text,
        "outcome" text,
        "renderLanguage" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_application_user" ON "cv_application" ("userId")`);
    await queryRunner.query(`CREATE INDEX "idx_application_job" ON "cv_application" ("jobId")`);

    await queryRunner.query(`
      CREATE TABLE "cv_render" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "applicationId" uuid NOT NULL,
        "revisionNo" int NOT NULL,
        "markdown" text NOT NULL,
        "factsSnapshot" jsonb NOT NULL,
        "provenance" jsonb NOT NULL,
        "fitScore" int,
        "gaps" jsonb,
        "aiTellScore" int,
        "createdBy" text NOT NULL,
        "modelUsed" text NOT NULL,
        "validatorModelUsed" text,
        "requestedTier" text NOT NULL,
        "degraded" boolean NOT NULL DEFAULT false,
        "promptVersion" text NOT NULL,
        "idempotencyKey" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_render_revision" UNIQUE ("applicationId", "revisionNo")
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_render_application" ON "cv_render" ("applicationId")`);
    // Unique: a retried generation must not be able to spend a second LLM call.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_render_idempotency" ON "cv_render" ("idempotencyKey")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "cv_render"`);
    await queryRunner.query(`DROP TABLE "cv_application"`);
  }
}
