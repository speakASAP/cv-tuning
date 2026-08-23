import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMasterTables1756200000000 implements MigrationInterface {
  name = 'CreateMasterTables1756200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE "cv_profile" (
        "userId" text PRIMARY KEY,
        "locale" text NOT NULL DEFAULT 'en',
        "consentVersion" text,
        "consentAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "cv_master" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" text NOT NULL,
        "version" int NOT NULL,
        "sourceType" text NOT NULL,
        "sourceRef" text,
        "markdown" text NOT NULL,
        "factsExtractedFromMarkdownSha" text NOT NULL,
        "isCurrent" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_master_user_version" UNIQUE ("userId", "version")
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_master_user" ON "cv_master" ("userId")`);
    // At most one current master per user; enforced by the database, not by convention.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_master_one_current" ON "cv_master" ("userId") WHERE "isCurrent"`,
    );

    await queryRunner.query(`
      CREATE TABLE "cv_fact" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "factId" uuid NOT NULL,
        "masterId" uuid NOT NULL REFERENCES "cv_master"("id") ON DELETE CASCADE,
        "kind" text NOT NULL,
        "text" text NOT NULL,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "metric" text,
        "contentHash" text NOT NULL,
        "position" int NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_fact_master" ON "cv_fact" ("masterId")`);
    await queryRunner.query(`CREATE INDEX "idx_fact_fact_id" ON "cv_fact" ("factId")`);
    // One row per (version, fact): a fact cannot appear twice in the same master version.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_fact_master_factid" ON "cv_fact" ("masterId", "factId")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_fact_content_hash" ON "cv_fact" ("contentHash")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "cv_fact"`);
    await queryRunner.query(`DROP TABLE "cv_master"`);
    await queryRunner.query(`DROP TABLE "cv_profile"`);
  }
}
