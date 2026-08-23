import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePhase4Tables1756500000000 implements MigrationInterface {
  name = 'CreatePhase4Tables1756500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "cv_chat" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "applicationId" uuid NOT NULL,
        "role" text NOT NULL,
        "content" text NOT NULL,
        "inputMode" text NOT NULL,
        "renderId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_chat_application" ON "cv_chat" ("applicationId")`);

    await queryRunner.query(`
      CREATE TABLE "cv_artifact" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "renderId" uuid NOT NULL,
        "kind" text NOT NULL,
        "minioKey" text NOT NULL,
        "sha256" text NOT NULL,
        "byteSize" int NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "cv_artifact" ADD CONSTRAINT "uq_artifact_render_kind" UNIQUE ("renderId", "kind")`,
    );

    await queryRunner.query(
      `ALTER TABLE "cv_render" ADD "confirmedOverreach" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(`ALTER TABLE "cv_application" ADD "approvedAt" timestamptz`);
    await queryRunner.query(`ALTER TABLE "cv_application" ADD "revisionCount" int NOT NULL DEFAULT 0`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_application" DROP COLUMN "revisionCount"`);
    await queryRunner.query(`ALTER TABLE "cv_application" DROP COLUMN "approvedAt"`);
    await queryRunner.query(`ALTER TABLE "cv_render" DROP COLUMN "confirmedOverreach"`);
    await queryRunner.query(`DROP TABLE "cv_artifact"`);
    await queryRunner.query(`DROP TABLE "cv_chat"`);
  }
}
