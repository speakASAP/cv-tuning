import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSupplementTables1756900000000 implements MigrationInterface {
  name = 'CreateSupplementTables1756900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "cv_supplement" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "applicationId" uuid NOT NULL,
        "kind" text NOT NULL,
        "revisionNo" int NOT NULL,
        "content" text NOT NULL,
        "factsSnapshot" jsonb NOT NULL,
        "provenance" jsonb NOT NULL,
        "aiTellScore" int,
        "modelUsed" text NOT NULL,
        "promptVersion" text NOT NULL,
        "validatorModelUsed" text,
        "validatorPromptVersion" text,
        "idempotencyKey" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_supplement_application" ON "cv_supplement" ("applicationId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_supplement_idempotency" ON "cv_supplement" ("idempotencyKey")`,
    );
    await queryRunner.query(
      `ALTER TABLE "cv_supplement" ADD CONSTRAINT "uq_supplement_revision" UNIQUE ("applicationId", "kind", "revisionNo")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "cv_supplement"`);
  }
}
