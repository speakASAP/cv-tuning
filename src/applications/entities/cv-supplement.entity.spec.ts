import { readFileSync } from 'fs';
import { join } from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { CvSupplementEntity } from './cv-supplement.entity';
import { CvJobEntity } from '../../jobs/entities/cv-job.entity';
import { QUESTION_SOURCES, SUPPLEMENT_KINDS } from '../supplement.types';

const MIGRATION = readFileSync(
  join(__dirname, '../../database/migrations/1756900000000-CreateSupplementTables.ts'),
  'utf8',
);

const columnsFor = (target: Function) =>
  getMetadataArgsStorage().columns.filter((c) => c.target === target);

describe('cv_supplement entity', () => {
  it('carries every column the supplement pipeline writes', () => {
    const names = columnsFor(CvSupplementEntity).map((c) => c.propertyName);
    for (const expected of [
      'applicationId',
      'kind',
      'revisionNo',
      'content',
      'factsSnapshot',
      'provenance',
      'aiTellScore',
      'modelUsed',
      'promptVersion',
      'validatorModelUsed',
      'validatorPromptVersion',
      'idempotencyKey',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('declares factsSnapshot and provenance NOT NULL, so a row can never be unauditable', () => {
    // A supplement whose provenance is null is a document with no record of which facts it
    // was built from — exactly the state the grounding layers exist to make impossible.
    const declared = columnsFor(CvSupplementEntity).filter((c) =>
      ['factsSnapshot', 'provenance'].includes(c.propertyName),
    );
    expect(declared).toHaveLength(2);
    for (const column of declared) {
      expect(column.options.type).toBe('jsonb');
      expect(column.options.nullable).toBeFalsy();
    }
  });

  it('declares the validator columns nullable, because validation is a separate call that can be absent', () => {
    const declared = columnsFor(CvSupplementEntity).filter((c) =>
      ['validatorModelUsed', 'validatorPromptVersion', 'aiTellScore'].includes(c.propertyName),
    );
    expect(declared).toHaveLength(3);
    for (const column of declared) {
      expect(column.options.nullable).toBe(true);
    }
  });

  it('keys revisions on (applicationId, kind, revisionNo)', () => {
    // `kind` is in the key because a cover letter and the screening answers revise
    // independently; without it, regenerating one would consume the other's revision number.
    const unique = getMetadataArgsStorage().uniques.find((u) => u.target === CvSupplementEntity);
    expect(unique?.name).toBe('uq_supplement_revision');
    expect(unique?.columns).toEqual(['applicationId', 'kind', 'revisionNo']);
  });

  it('makes idempotencyKey UNIQUE so a retried request cannot double-spend a generation', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === CvSupplementEntity && i.name === 'idx_supplement_idempotency',
    );
    expect(index?.unique).toBe(true);
  });
});

describe('cv_supplement migration matches the entity', () => {
  // The entity and the migration are two independent declarations of one table, and nothing
  // reconciles them at runtime: `synchronize` is false, so a column present on the entity but
  // missing from the migration fails in production on the first INSERT, not at boot.
  it('creates a column for every column the entity declares', () => {
    for (const column of columnsFor(CvSupplementEntity)) {
      expect(MIGRATION).toContain(`"${column.propertyName}"`);
    }
  });

  it('declares the same NOT NULL columns the entity does', () => {
    for (const column of columnsFor(CvSupplementEntity)) {
      if (column.options.nullable) continue;
      if (column.propertyName === 'id') continue;
      expect(MIGRATION).toMatch(new RegExp(`"${column.propertyName}"[^,]*NOT NULL`));
    }
  });

  it('creates both indexes and the revision constraint the entity names', () => {
    expect(MIGRATION).toContain('idx_supplement_application');
    expect(MIGRATION).toContain('UNIQUE INDEX "idx_supplement_idempotency"');
    expect(MIGRATION).toContain('uq_supplement_revision');
  });

  it('has a real down(), not an empty one', () => {
    // An irreversible migration cannot be rolled back when a deploy goes wrong, which is the
    // one moment a down() is needed.
    const down = MIGRATION.slice(MIGRATION.indexOf('public async down'));
    expect(down).toContain('DROP TABLE "cv_supplement"');
  });
});

describe('supplement enums', () => {
  it('keeps user-supplied and parsed screening questions distinguishable', () => {
    // Merging them would let a question this service GUESSED from the posting be presented to
    // the user as one the employer actually asked, and the answer would go out as solicited.
    expect(QUESTION_SOURCES).toEqual(['user', 'parsed']);
  });

  it('names both supplement kinds', () => {
    expect(SUPPLEMENT_KINDS).toEqual(['cover_letter', 'screening']);
  });
});

describe('cv_job screeningQuestions column', () => {
  const JOB_MIGRATION = readFileSync(
    join(__dirname, '../../database/migrations/1757000000000-AddJobScreeningQuestions.ts'),
    'utf8',
  );

  it('is NOT NULL with a [] default, so "asks none" is never confused with "not parsed"', () => {
    // A nullable column would add a third state that no consumer has a meaning for; "we have
    // not parsed this posting" is already carried by a null `parsed`.
    expect(JOB_MIGRATION).toContain(`"screeningQuestions" jsonb NOT NULL DEFAULT '[]'::jsonb`);
  });

  it('declares the same default on the entity as the migration does', () => {
    const column = getMetadataArgsStorage().columns.find(
      (c) => c.target === CvJobEntity && c.propertyName === 'screeningQuestions',
    );
    expect(column?.options.type).toBe('jsonb');
    expect(column?.options.nullable).toBeFalsy();
    expect(String(column?.options.default?.())).toContain('[]');
  });

  it('has a real down()', () => {
    expect(JOB_MIGRATION).toContain('DROP COLUMN "screeningQuestions"');
  });
});
