---
status: done
owner: repository-owner
last_updated: 2026-09-02
---

# cv-tuning Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the state machine from `in_review` to `downloaded` — an AI revision loop, an approval gate that blocks on unconfirmed fabrication risk, and PDF/DOCX export.

**Architecture:** A revision turn is a generation with more context, not a new subsystem: it reuses `TailorService` and `EntailService` unchanged and writes `cv_render` revision N+1, so the existing diff endpoint renders it for free. Approval refuses to proceed while any `overreach` bullet is unresolved. Export parses a render into one narrow document model, then two writers (pdfkit, docx) emit from that single model.

**Tech Stack:** NestJS 10, TypeORM 0.3, Postgres, `pdfkit ^0.19.1` (house version, from invoices-microservice), `docx` (NEW dependency, no ecosystem precedent), existing `MinioService`.

**Spec:** [`docs/superpowers/specs/2026-08-23-cv-tuning-phase-4-design.md`](../specs/2026-08-23-cv-tuning-phase-4-design.md)

## Global Constraints

- **No silent failures.** Every catch re-throws or logs at error level with full context. "Not found" and "lookup failed" must stay distinguishable to the caller. An empty result never stands in for a failure.
- **Fact pinning:** always read facts via `application.masterVersionId`, never `is_current` (spec §4.2).
- **Grounding is never skipped:** every render-producing AI path runs `TailorService.tailor()` then `EntailService.validate()` as two separate LLM calls.
- **Tier:** `smart` only. `premium` is blocked until Phase 8.
- **Never `npx tsc`** — use `./node_modules/.bin/tsc` or `npm run typecheck`.
- **Test command:** `npm test` (typecheck + build + jest). Single suite: `npx jest <path>`. Single case: `npx jest -t '<name>'`.
- Migrations run via `migrationsRun` at boot; there is **no standalone data-source**.
- Existing render `idempotencyKey` format is `` `${application.id}:${revisionNo}` `` — already revision-scoped, so revisions reuse it unchanged.
- Commit after every task. Commit straight to `main`.

### Execution order

**1 → 2 → 3 → 6 → 7 → 4 → 5 → 8 → 9 → 10.** Tasks 6 and 7 (the exporters) come before Task 4 because Task 4 wires the final service constructor, which references `CvPdfService`, `CvDocxService`, and `MinioService`. Task 0 is a prerequisite that must complete before Task 9.

### `ApplicationsService` constructor — final Phase 4 signature

Tasks 4, 5, and 8 each add collaborators to this one constructor. **Add all six in Task 4**, in exactly this order, so no later task changes an existing positional signature and breaks earlier suites:

```typescript
  constructor(
    @InjectRepository(CvApplicationEntity) private readonly applications: Repository<CvApplicationEntity>,
    @InjectRepository(CvRenderEntity) private readonly renders: Repository<CvRenderEntity>,
    private readonly jobs: JobsService,
    private readonly master: MasterCvService,
    private readonly tailor: TailorService,
    private readonly entail: EntailService,
    // added in Phase 4:
    private readonly reviseService: ReviseService,
    @InjectRepository(CvChatEntity) private readonly chats: Repository<CvChatEntity>,
    @InjectRepository(CvArtifactEntity) private readonly artifacts: Repository<CvArtifactEntity>,
    private readonly pdf: CvPdfService,
    private readonly docx: CvDocxService,
    private readonly storage: MinioService,
  ) {}
```

Task 4 registers `ReviseService`, `CvChatEntity`, `CvArtifactEntity`, `ExportModule`, and `StorageModule` in `applications.module.ts` at the same time — otherwise Nest cannot resolve the constructor and every test in Tasks 4–7 fails at module load. The Task 4 and Task 5 test harnesses therefore pass **12** positional arguments, using `{} as never` for collaborators they do not exercise.

---

## Task 0 (PREREQUISITE): Record the Phase 3 eval baseline

**This is not a code task and must complete before Task 6.** Phase 4 adds a third prompt to an eval harness that has never been run. Without a baseline there is no way to attribute a grounding regression to Phase 4.

**Files:**
- Modify: `STATE.json` (record the result)

- [x] **Step 1: Confirm ai-microservice is reachable**

```bash
kubectl get pods -n statex-apps | rtk rg ai-microservice
```

- [x] **Step 2: Run the existing harness**

```bash
CV_AI_SERVICE_URL=<reachable-url> CV_AI_JWT_SECRET=<cv-tuning's own Auth-issued service credential per SERVICE_IDENTITY_CONSUMER_STANDARD.md — never a value copied from ai-microservice's own secret> \
  rtk npx ts-node src/applications/__evals__/run-eval.ts
```

Expected: a table of fixtures with verdict counts. It spends real tokens; run it once.

- [x] **Step 3: Record the table in STATE.json**

Replace the `openItems` entry "Phase 3 eval harness has no recorded baseline yet…" with an `evalBaseline` object holding the date, the prompt versions (`tailor-v1`, the entail version), and the per-fixture verdict counts.

- [x] **Step 4: Commit**

```bash
rtk git add STATE.json && rtk git commit -m "docs: record Phase 3 grounding eval baseline"
```

---

## Task 1: Schema — chat, artifacts, and approval columns

**Files:**
- Create: `src/applications/entities/cv-chat.entity.ts`
- Create: `src/applications/entities/cv-artifact.entity.ts`
- Create: `src/database/migrations/1756500000000-CreatePhase4Tables.ts`
- Modify: `src/applications/entities/cv-render.entity.ts` (add `confirmedOverreach`)
- Modify: `src/applications/entities/cv-application.entity.ts` (add `approvedAt`, `revisionCount`)
- Modify: `src/applications/application.types.ts` (add `ConfirmedClaim`, `ChatRole`, `InputMode`, `ArtifactKind`)
- Modify: `src/database/database.module.ts` (register both entities in `CV_ENTITIES`)
- Test: `src/applications/entities/phase4-entities.spec.ts`

**Interfaces:**
- Consumes: `CvRenderEntity`, `CvApplicationEntity` from Phase 3.
- Produces: `CvChatEntity`, `CvArtifactEntity`, and the types below, used by every later task.

- [x] **Step 1: Write the failing test**

```typescript
// src/applications/entities/phase4-entities.spec.ts
import { CvArtifactEntity } from './cv-artifact.entity';
import { CvChatEntity } from './cv-chat.entity';

describe('phase 4 entities', () => {
  it('exposes a chat row that can point at the render it produced', () => {
    const chat = new CvChatEntity();
    chat.role = 'assistant';
    chat.inputMode = 'text';
    chat.renderId = 'render-1';
    expect(chat.renderId).toBe('render-1');
  });

  it('allows a user chat row with no render', () => {
    const chat = new CvChatEntity();
    chat.role = 'user';
    chat.renderId = null;
    expect(chat.renderId).toBeNull();
  });

  it('exposes an artifact row carrying the sha256 used for idempotency', () => {
    const artifact = new CvArtifactEntity();
    artifact.kind = 'pdf';
    artifact.sha256 = 'abc';
    artifact.byteSize = 12;
    expect(artifact.kind).toBe('pdf');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest src/applications/entities/phase4-entities.spec.ts`
Expected: FAIL — `Cannot find module './cv-artifact.entity'`

- [x] **Step 3: Add the shared types**

Append to `src/applications/application.types.ts`:

```typescript
export const CHAT_ROLES = ['user', 'assistant'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export const INPUT_MODES = ['text', 'voice'] as const;
export type InputMode = (typeof INPUT_MODES)[number];

export const ARTIFACT_KINDS = ['pdf', 'docx'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * A human decision on an `overreach` bullet (spec §6 layer 3). This is the audit trail
 * proving a person accepted a new claim, so it records who decided and when — never just
 * that a decision happened.
 */
export interface ConfirmedClaim {
  bulletText: string;
  decision: 'confirm' | 'drop';
  decidedBy: string;
  decidedAt: string;
}
```

- [x] **Step 4: Create the chat entity**

```typescript
// src/applications/entities/cv-chat.entity.ts
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ChatRole, InputMode } from '../application.types';

/** One turn of the revision conversation (spec §5). */
@Entity('cv_chat')
export class CvChatEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_chat_application')
  @Column({ type: 'uuid' })
  applicationId!: string;

  @Column({ type: 'text' })
  role!: ChatRole;

  @Column({ type: 'text' })
  content!: string;

  /** How the user supplied this turn. Voice is transcribed in the browser (spec §3). */
  @Column({ type: 'text' })
  inputMode!: InputMode;

  /**
   * The render this turn produced. Null on user turns. Without it a turn cannot be traced
   * to its output, and a bad revision cannot be attributed to the instruction that caused it.
   */
  @Column({ type: 'uuid', nullable: true })
  renderId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
```

- [x] **Step 5: Create the artifact entity**

```typescript
// src/applications/entities/cv-artifact.entity.ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { ArtifactKind } from '../application.types';

/**
 * A generated file in MinIO.
 *
 * `(renderId, kind)` is unique: approving twice must never produce a second PDF, and a
 * download must never be ambiguous about which file was approved.
 */
@Entity('cv_artifact')
@Unique('uq_artifact_render_kind', ['renderId', 'kind'])
export class CvArtifactEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  renderId!: string;

  @Column({ type: 'text' })
  kind!: ArtifactKind;

  @Column({ type: 'text' })
  minioKey!: string;

  /** Reused for artifact idempotency, matching the house shape in invoices-microservice. */
  @Column({ type: 'text' })
  sha256!: string;

  @Column({ type: 'int' })
  byteSize!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
```

- [x] **Step 6: Add the new columns to the existing entities**

In `src/applications/entities/cv-render.entity.ts`, import `ConfirmedClaim` from `'../application.types'` and add after `createdBy`:

```typescript
  /** Human decisions on `overreach` bullets (spec §6 layer 3). Empty until one is made. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  confirmedOverreach!: ConfirmedClaim[];
```

In `src/applications/entities/cv-application.entity.ts`, add after `outcome`:

```typescript
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  /** Counts AI revision turns only, so the cap bounds model spend and nothing else. */
  @Column({ type: 'int', default: 0 })
  revisionCount!: number;
```

- [x] **Step 7: Write the migration**

```typescript
// src/database/migrations/1756500000000-CreatePhase4Tables.ts
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
```

- [x] **Step 8: Register the entities**

In `src/database/database.module.ts`, import both new entities and add `CvChatEntity, CvArtifactEntity` to the `CV_ENTITIES` array.

- [x] **Step 9: Run tests and typecheck**

Run: `npx jest src/applications/entities/phase4-entities.spec.ts && npm run typecheck`
Expected: PASS, no type errors.

- [x] **Step 10: Commit**

```bash
rtk git add src/applications/entities src/applications/application.types.ts src/database && \
rtk git commit -m "feat: Phase 4 schema — chat turns, artifacts, approval columns"
```

---

## Task 2: The revise prompt

**Files:**
- Create: `src/applications/revise.prompt.ts`
- Test: `src/applications/revise.prompt.spec.ts`

**Interfaces:**
- Consumes: `AI_TELL_PHRASES` from `./ai-tell`; the `TailorPromptInput` shape from `./tailor.prompt` (fields: `facts`, `requirements`, `jobTitle`, `company`, `language`, `styleExemplars`).
- Produces: `REVISE_PROMPT_VERSION: string`, `REVISE_SYSTEM_PROMPT: string`, `ReviseTurn`, `RevisePromptInput`, `buildRevisePrompt(input: RevisePromptInput): string`. Reuses `TAILOR_OUTPUT_SCHEMA` — the output shape is identical, so Task 3 can feed the result straight into `EntailService`.

- [x] **Step 1: Write the failing test**

```typescript
// src/applications/revise.prompt.spec.ts
import { buildRevisePrompt, REVISE_SYSTEM_PROMPT } from './revise.prompt';

const base = {
  facts: [{ factId: 'f1', text: 'Senior Developer at Acme, 2019-2024', kind: 'role' }],
  requirements: [{ text: 'TypeScript', kind: 'must' as const }],
  jobTitle: 'Engineer',
  company: 'Globex',
  language: 'en',
  styleExemplars: ['Cut checkout latency from 900ms to 220ms'],
  previousMarkdown: '- Senior Developer at Acme',
  history: [],
  instruction: 'make it punchier',
};

describe('buildRevisePrompt', () => {
  it('carries the previous render so the model revises rather than restarts', () => {
    expect(buildRevisePrompt(base)).toContain('- Senior Developer at Acme');
  });

  it('carries the instruction', () => {
    expect(buildRevisePrompt(base)).toContain('make it punchier');
  });

  it('includes the fact ids the rewrite must bind to', () => {
    expect(buildRevisePrompt(base)).toContain('[f1]');
  });

  it('renders prior turns so the model does not undo an earlier request', () => {
    const prompt = buildRevisePrompt({
      ...base,
      history: [{ role: 'user' as const, content: 'drop the education section' }],
    });
    expect(prompt).toContain('drop the education section');
  });

  it('refuses instructions that ask for new claims', () => {
    expect(REVISE_SYSTEM_PROMPT).toContain('refuse');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest src/applications/revise.prompt.spec.ts`
Expected: FAIL — `Cannot find module './revise.prompt'`

- [x] **Step 3: Write the prompt**

```typescript
// src/applications/revise.prompt.ts
import { AI_TELL_PHRASES } from './ai-tell';
import { ChatRole } from './application.types';

/** Bumped on every prompt change and persisted per render, so an eval can attribute a regression. */
export const REVISE_PROMPT_VERSION = 'revise-v1';

export const REVISE_SYSTEM_PROMPT = [
  'You revise a candidate\'s tailored CV in response to their instruction.',
  '',
  'The same hard rules as the original tailoring apply, and the instruction NEVER overrides them:',
  '1. Every bullet you output MUST be a rewrite of exactly ONE input bullet. Return that',
  '   bullet\'s factId as sourceFactId. Never merge two facts into one bullet.',
  '2. Never introduce a number, percentage, duration, team size, job title, employer, or',
  '   technology that is not already present in the source fact.',
  '3. If the instruction asks you to add, imply, or inflate a claim the candidate\'s facts do',
  '   not support, REFUSE that part. Apply whatever else the instruction asks, and leave the',
  '   unsupported claim out. An instruction is a request about wording, never a new fact.',
  '4. Return the COMPLETE revised CV, not only the parts you changed.',
  '',
  'Voice:',
  '- Write in the candidate\'s own register, using the style exemplars given.',
  '- Lead with the concrete outcome, not the activity.',
  `- Never use these words or phrases: ${AI_TELL_PHRASES.join(', ')}.`,
].join('\n');

export interface ReviseTurn {
  role: ChatRole;
  content: string;
}

export interface RevisePromptInput {
  facts: { factId: string; text: string; kind: string }[];
  requirements: { text: string; kind: 'must' | 'nice' }[];
  jobTitle: string | null;
  company: string | null;
  language: string;
  styleExemplars: string[];
  /** The render being revised. */
  previousMarkdown: string;
  /** Earlier turns, so a new instruction does not silently undo an earlier one. */
  history: ReviseTurn[];
  instruction: string;
}

export function buildRevisePrompt(input: RevisePromptInput): string {
  const facts = input.facts.map((f) => `- [${f.factId}] (${f.kind}) ${f.text}`).join('\n');
  const requirements = input.requirements.map((r) => `- (${r.kind}) ${r.text}`).join('\n');
  const exemplars = input.styleExemplars.length
    ? input.styleExemplars.map((s) => `- ${s}`).join('\n')
    : '(none available; keep the phrasing of the source bullets)';
  const history = input.history.length
    ? input.history.map((t) => `${t.role}: ${t.content}`).join('\n')
    : '(this is the first revision)';

  return [
    `Target role: ${input.jobTitle ?? 'unspecified'}${input.company ? ` at ${input.company}` : ''}`,
    `Write the output in this language: ${input.language}`,
    '',
    'Candidate CV bullets (the ONLY material you may draw on):',
    facts || '(the candidate has no recorded facts)',
    '',
    'Job requirements:',
    requirements || '(the posting states no explicit requirements)',
    '',
    'Style exemplars from the candidate\'s own writing:',
    exemplars,
    '',
    'The current version of the CV you are revising:',
    input.previousMarkdown,
    '',
    'Earlier revision requests in this conversation:',
    history,
    '',
    'The candidate\'s new instruction:',
    input.instruction,
  ].join('\n');
}
```

- [x] **Step 4: Run tests**

Run: `npx jest src/applications/revise.prompt.spec.ts`
Expected: PASS (5 tests)

- [x] **Step 5: Commit**

```bash
rtk git add src/applications/revise.prompt.ts src/applications/revise.prompt.spec.ts && \
rtk git commit -m "feat: revise prompt with instruction-cannot-override-grounding rule"
```

---

## Task 3: ReviseService — grounded revision generation

**Files:**
- Create: `src/applications/revise.service.ts`
- Test: `src/applications/revise.service.spec.ts`

**Interfaces:**
- Consumes: `AiClientService.complete()` from `../ai/ai-client.service`; `buildRevisePrompt`, `REVISE_SYSTEM_PROMPT`, `REVISE_PROMPT_VERSION`, `RevisePromptInput` from `./revise.prompt`; `TAILOR_OUTPUT_SCHEMA` from `./tailor.prompt`; `DraftBullet` and `TailorResult` from `./tailor.service`.
- Produces: `ReviseService.revise(input: RevisePromptInput): Promise<TailorResult>` — deliberately returns the **same** `TailorResult` shape as `TailorService.tailor()`, so Task 4 feeds it into `EntailService.validate(bullets, facts)` with no adapter.

- [x] **Step 1: Write the failing test**

```typescript
// src/applications/revise.service.spec.ts
import { ReviseService } from './revise.service';
import { RevisePromptInput } from './revise.prompt';

const facts = [
  { factId: 'f1', text: 'Senior Developer at Acme', kind: 'role' },
  { factId: 'f2', text: 'Ran PostgreSQL in production', kind: 'achievement' },
];

const input: RevisePromptInput = {
  facts,
  requirements: [{ text: 'PostgreSQL', kind: 'must' }],
  jobTitle: 'Engineer',
  company: 'Globex',
  language: 'en',
  styleExemplars: [],
  previousMarkdown: '- Senior Developer at Acme',
  history: [],
  instruction: 'make it punchier',
};

const aiReturning = (text: string, degraded = false) =>
  ({ complete: jest.fn().mockResolvedValue({ text, modelUsed: 'm', degraded }) }) as never;

describe('ReviseService', () => {
  it('returns bullets bound to real facts', async () => {
    const service = new ReviseService(
      aiReturning(JSON.stringify({ bullets: [{ text: 'Ran PostgreSQL', sourceFactId: 'f2' }] })),
    );
    const result = await service.revise(input);
    expect(result.bullets).toHaveLength(1);
    expect(result.bullets[0].sourceFactId).toBe('f2');
  });

  it('drops a bullet citing a fact that is not in the snapshot, with a reason', async () => {
    const service = new ReviseService(
      aiReturning(JSON.stringify({ bullets: [{ text: 'Led a team of 12', sourceFactId: 'ghost' }] })),
    );
    const result = await service.revise(input);
    expect(result.bullets).toHaveLength(0);
    expect(result.droppedBullets[0].reason).toContain('ghost');
  });

  it('raises when the model returns unparseable JSON, never an empty revision', async () => {
    const service = new ReviseService(aiReturning('not json at all'));
    await expect(service.revise(input)).rejects.toThrow(/parse/i);
  });

  it('raises when the tier was served by an unexpected model', async () => {
    const service = new ReviseService(
      aiReturning(JSON.stringify({ bullets: [{ text: 'x', sourceFactId: 'f1' }] }), true),
    );
    await expect(service.revise(input)).rejects.toThrow(/degraded/i);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest src/applications/revise.service.spec.ts`
Expected: FAIL — `Cannot find module './revise.service'`

- [x] **Step 3: Read the existing tailor service for the exact parsing shape**

Read `src/applications/tailor.service.ts` in full. `ReviseService` mirrors its fence-stripping, source-constraint enforcement, and degraded handling. Reuse the same `FENCE` regex and the same drop-with-reason behaviour — do not invent a different one.

- [x] **Step 4: Write the service**

```typescript
// src/applications/revise.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { AiClientService } from '../ai/ai-client.service';
import {
  buildRevisePrompt,
  REVISE_PROMPT_VERSION,
  REVISE_SYSTEM_PROMPT,
  RevisePromptInput,
} from './revise.prompt';
import { TAILOR_OUTPUT_SCHEMA } from './tailor.prompt';
import { DraftBullet, TailorResult } from './tailor.service';

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

interface RawBullet {
  text?: unknown;
  sourceFactId?: unknown;
  targetRequirement?: unknown;
}

/**
 * A revision turn is layer 1 of grounding applied again (spec §6), not a lighter path.
 *
 * The user's instruction is untrusted input: it can ask for a claim the facts do not
 * support. The prompt refuses; this service enforces, exactly as TailorService does for the
 * first generation. Returning `TailorResult` keeps the pipeline downstream identical.
 */
@Injectable()
export class ReviseService {
  private readonly logger = new Logger(ReviseService.name);

  constructor(private readonly ai: AiClientService) {}

  async revise(input: RevisePromptInput): Promise<TailorResult> {
    const completion = await this.ai.complete({
      tier: 'smart',
      systemPrompt: REVISE_SYSTEM_PROMPT,
      userPrompt: buildRevisePrompt(input),
      outputSchema: TAILOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });

    if (completion.degraded) {
      // A fallback model still returns well-formed prose, so this cannot be detected
      // downstream. Refuse rather than quietly ship worse grounding (spec §8.1).
      this.logger.error(`revision served by unexpected model ${completion.modelUsed}; refusing`);
      throw new Error(`revision was degraded: served by ${completion.modelUsed}`);
    }

    const parsed = this.parse(completion.text);
    const known = new Set(input.facts.map((f) => f.factId));
    const bullets: DraftBullet[] = [];
    const droppedBullets: { text: string; reason: string }[] = [];

    for (const raw of parsed) {
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      const sourceFactId = typeof raw.sourceFactId === 'string' ? raw.sourceFactId : '';

      if (!text || !sourceFactId) {
        droppedBullets.push({ text, reason: 'bullet is missing text or sourceFactId' });
        continue;
      }

      if (!known.has(sourceFactId)) {
        // The source constraint is the guarantee, not the prompt. A bullet citing a fact we
        // do not have cannot be validated by anything downstream.
        droppedBullets.push({ text, reason: `cites unknown source fact "${sourceFactId}"` });
        continue;
      }

      bullets.push({
        text,
        sourceFactId,
        targetRequirement: typeof raw.targetRequirement === 'string' ? raw.targetRequirement : null,
      });
    }

    if (droppedBullets.length > 0) {
      this.logger.warn(`revision dropped ${droppedBullets.length} bullet(s) failing the source constraint`);
    }

    return {
      bullets,
      droppedBullets,
      modelUsed: completion.modelUsed,
      promptVersion: REVISE_PROMPT_VERSION,
    };
  }

  private parse(text: string): RawBullet[] {
    const unfenced = FENCE.exec(text.trim())?.[1] ?? text.trim();
    let payload: { bullets?: unknown };
    try {
      payload = JSON.parse(unfenced) as { bullets?: unknown };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`could not parse revision output: ${message}; raw=${text.slice(0, 300)}`);
      throw new Error(`could not parse revision output as JSON: ${message}`);
    }

    if (!Array.isArray(payload.bullets)) {
      this.logger.error(`revision output has no bullets array; raw=${text.slice(0, 300)}`);
      throw new Error('revision output did not contain a bullets array');
    }

    return payload.bullets as RawBullet[];
  }
}
```

- [x] **Step 5: Run tests**

Run: `npx jest src/applications/revise.service.spec.ts`
Expected: PASS (4 tests)

- [x] **Step 6: Verify a test fails when the behaviour breaks**

Temporarily change `if (!known.has(sourceFactId))` to `if (false)`. Re-run: the "drops a bullet citing a fact that is not in the snapshot" test MUST fail. Revert.

- [x] **Step 7: Commit**

```bash
rtk git add src/applications/revise.service.ts src/applications/revise.service.spec.ts && \
rtk git commit -m "feat: ReviseService — revision re-runs constrained generation"
```

---

## Task 4: The revision loop endpoint

**Files:**
- Modify: `src/applications/applications.service.ts` (add `revise`, `listChat`)
- Modify: `src/applications/applications.controller.ts` (add `POST :id/revise`, `GET :id/chat`)
- Create: `src/applications/dto/revise.dto.ts`
- Modify: `src/applications/applications.module.ts` (register `ReviseService`, `CvChatEntity`)
- Test: `src/applications/revise-loop.spec.ts`

**Interfaces:**
- Consumes: `ReviseService.revise()` (Task 3); `EntailService.validate(bullets, facts)` returning `{ bullets, validatorModelUsed, validatorPromptVersion }`; `CvChatEntity` (Task 1); the existing private `findOwned(userId, applicationId)` and `toView(render)` helpers.
- Produces: `ApplicationsService.revise(userId, applicationId, instruction, inputMode): Promise<RenderView>`; `ApplicationsService.listChat(userId, applicationId): Promise<CvChatEntity[]>`; private `assertWithinRateLimit(userId)`; constants `MAX_REVISIONS = 20`, `MAX_TURNS_PER_HOUR = 10`, `RATE_WINDOW_MS`.

- [x] **Step 1: Write the failing test**

```typescript
// src/applications/revise-loop.spec.ts
import { ConflictException } from '@nestjs/common';
import { ApplicationsService } from './applications.service';

// A minimal harness: only the collaborators `revise` actually touches.
function makeService(overrides: {
  state?: string;
  revisionCount?: number;
  reviseImpl?: jest.Mock;
  /** Turns this user has already spent in the current rate-limit window. */
  recentTurns?: number;
}) {
  const application = {
    id: 'app-1',
    userId: 'u1',
    jobId: 'job-1',
    masterVersionId: 'mv-1',
    state: overrides.state ?? 'in_review',
    revisionCount: overrides.revisionCount ?? 0,
    renderLanguage: 'en',
  };
  const applications = {
    findOne: jest.fn().mockResolvedValue(application),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const renders = {
    findOne: jest.fn().mockResolvedValue({ id: 'r1', revisionNo: 1, markdown: '- old' }),
    find: jest.fn().mockResolvedValue([{ id: 'r1', revisionNo: 1, markdown: '- old' }]),
    save: jest.fn().mockImplementation((r) => Promise.resolve({ ...r, id: 'r2' })),
  };
  // The rate limiter counts through a query builder, so the stub must be chainable.
  const chats = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue({}),
    createQueryBuilder: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(overrides.recentTurns ?? 0),
    }),
  };
  const jobs = {
    get: jest.fn().mockResolvedValue({
      job: { title: 'E', company: 'G', parsed: { requirements: [] } },
    }),
  };
  const master = {
    getVersion: jest.fn().mockResolvedValue({ facts: [{ id: 'f1', payload: {}, kind: 'role' }] }),
  };
  const revise = {
    revise:
      overrides.reviseImpl ??
      jest.fn().mockResolvedValue({
        bullets: [{ text: 'new', sourceFactId: 'f1', targetRequirement: null }],
        droppedBullets: [],
        modelUsed: 'm',
        promptVersion: 'revise-v1',
      }),
  };
  const entail = {
    validate: jest.fn().mockResolvedValue({
      bullets: [{ text: 'new', sourceFactId: 'f1', targetRequirement: null, verdict: 'supported', span: null }],
      validatorModelUsed: 'v',
      validatorPromptVersion: 'entail-v1',
    }),
  };

  // 12 positional args — the full Phase 4 signature from Global Constraints.
  const service = new ApplicationsService(
    applications as never, renders as never, jobs as never,
    master as never, {} as never, entail as never,
    revise as never, chats as never,
    {} as never, {} as never, {} as never, {} as never,
  );
  return { service, applications, renders, chats, revise, entail };
}

describe('ApplicationsService.revise', () => {
  it('re-runs BOTH grounding layers on every turn', async () => {
    const { service, revise, entail } = makeService({});
    await service.revise('u1', 'app-1', 'make it punchier', 'text');
    expect(revise.revise).toHaveBeenCalledTimes(1);
    expect(entail.validate).toHaveBeenCalledTimes(1);
  });

  it('rejects a second concurrent turn instead of racing for the same revision number', async () => {
    const { service } = makeService({ state: 'revising' });
    await expect(service.revise('u1', 'app-1', 'x', 'text')).rejects.toThrow(/already in progress/i);
  });

  it('rejects a revision once the per-application cap is reached', async () => {
    const { service } = makeService({ revisionCount: 20 });
    await expect(service.revise('u1', 'app-1', 'x', 'text')).rejects.toThrow(/cap/i);
  });

  it('rejects a revision from a state that cannot accept one, naming that state', async () => {
    const { service } = makeService({ state: 'approved' });
    await expect(service.revise('u1', 'app-1', 'x', 'text')).rejects.toThrow(/approved/);
  });

  it('rejects a turn once the per-user rate limit is exhausted, distinctly from the cap', async () => {
    // 10 turns already used this hour; the cap is untouched, so only the rate limit can fire.
    const { service } = makeService({ recentTurns: 10 });
    await expect(service.revise('u1', 'app-1', 'one too many', 'text')).rejects.toThrow(/rate limit/i);
  });

  it('allows a turn while under the rate limit', async () => {
    const { service, revise } = makeService({ recentTurns: 9 });
    await service.revise('u1', 'app-1', 'fine', 'text');
    expect(revise.revise).toHaveBeenCalled();
  });

  it('lands in generation_failed with the error when a turn dies mid-flight', async () => {
    const { service, applications } = makeService({
      reviseImpl: jest.fn().mockRejectedValue(new Error('model exploded')),
    });
    await expect(service.revise('u1', 'app-1', 'x', 'text')).rejects.toThrow('model exploded');
    expect(applications.update).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({ state: 'generation_failed', stateError: 'model exploded' }),
    );
  });

  it('persists both the user turn and the assistant turn', async () => {
    const { service, chats } = makeService({});
    await service.revise('u1', 'app-1', 'make it punchier', 'voice');
    const roles = chats.save.mock.calls.map((c) => c[0].role);
    expect(roles).toEqual(['user', 'assistant']);
    expect(chats.save.mock.calls[0][0].inputMode).toBe('voice');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest src/applications/revise-loop.spec.ts`
Expected: FAIL — `service.revise is not a function`

- [x] **Step 3: Create the DTO**

```typescript
// src/applications/dto/revise.dto.ts
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { INPUT_MODES, InputMode } from '../application.types';

export class ReviseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  instruction!: string;

  @IsIn(INPUT_MODES as unknown as string[])
  inputMode!: InputMode;
}
```

- [x] **Step 4: Wire the full Phase 4 constructor**

In `src/applications/applications.service.ts`, replace the constructor with the **complete 12-argument signature** given in Global Constraints — all six new collaborators at once, including the three (`artifacts`, `pdf`, `docx`, `storage`) that only Task 8 uses. Adding them incrementally would change a positional signature that Tasks 4 and 5 have already written tests against.

Add the imports: `ReviseService` from `./revise.service`, `CvChatEntity` from `./entities/cv-chat.entity`, `CvArtifactEntity` from `./entities/cv-artifact.entity`, `ChatRole`/`InputMode`/`ArtifactKind` from `./application.types`, `CvPdfService` and `CvDocxService` from `../export/cv-pdf.service` and `../export/cv-docx.service`, `MinioService` from `../storage/minio.service`.

**This means Tasks 6 and 7 must be done before Task 4 compiles.** Execute in this order: 1 → 2 → 3 → 6 → 7 → 4 → 5 → 8 → 9 → 10.

Add the constants near `STYLE_EXEMPLAR_COUNT`:

```typescript
/** Bounds worst-case model spend per application (spec §4). */
const MAX_REVISIONS = 20;

/** Bounds spend per user across all their applications (spec §8.3). */
const MAX_TURNS_PER_HOUR = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
```

- [x] **Step 4b: Add the per-user rate limiter**

The cap and the rate limit bound different things — one application's total spend versus one user's burst — so they raise **distinct** errors. A caller must be able to tell "this application is finished" from "wait an hour".

Counted from `cv_chat` rather than an in-memory counter: the pod restarts, and a limiter that resets on deploy is not a limit. Add to `ApplicationsService`:

```typescript
  /**
   * Spec §8.3. Counts the user's own turns in the last hour across every application.
   * `cv_chat` has no userId, so the count joins through the applications the user owns —
   * correct by construction rather than by trusting a denormalised column.
   */
  private async assertWithinRateLimit(userId: string): Promise<void> {
    const since = new Date(Date.now() - RATE_WINDOW_MS);
    const recent = await this.chats
      .createQueryBuilder('chat')
      .innerJoin(CvApplicationEntity, 'app', 'app.id = chat."applicationId"')
      .where('app."userId" = :userId', { userId })
      .andWhere('chat.role = :role', { role: 'user' })
      .andWhere('chat."createdAt" >= :since', { since })
      .getCount();

    if (recent >= MAX_TURNS_PER_HOUR) {
      throw new ConflictException(
        `rate limit reached: ${MAX_TURNS_PER_HOUR} revision turns per hour. Try again later.`,
      );
    }
  }
```

Call it in `revise` immediately after the cap check:

```typescript
    await this.assertWithinRateLimit(userId);
```

In the test harness, `chats.find` is already mocked; add `createQueryBuilder` returning a chainable stub whose `getCount()` resolves to the number of turns the test needs.

- [x] **Step 5: Implement `revise`**

```typescript
  /**
   * One turn of the revision loop (spec §4). Re-runs both grounding layers: the user's
   * instruction is untrusted and may ask for a claim the facts do not support.
   */
  async revise(
    userId: string,
    applicationId: string,
    instruction: string,
    inputMode: InputMode,
  ): Promise<RenderView> {
    const application = await this.findOwned(userId, applicationId);

    if (application.state === 'revising') {
      // Two concurrent turns would race for the same revision number and collide on
      // uq_render_revision, surfacing as an opaque database error instead of this one.
      throw new ConflictException(`application ${applicationId} already has a revision in progress`);
    }

    if (application.state !== 'in_review') {
      throw new ConflictException(
        `application ${applicationId} is in state ${application.state} and cannot be revised`,
      );
    }

    if (application.revisionCount >= MAX_REVISIONS) {
      throw new ConflictException(
        `application ${applicationId} reached the revision cap of ${MAX_REVISIONS}`,
      );
    }

    const renders = await this.renders.find({
      where: { applicationId },
      order: { revisionNo: 'DESC' },
    });
    const latest = renders[0];
    if (!latest) {
      throw new ConflictException(`application ${applicationId} has no render to revise`);
    }

    const pinned = await this.master.getVersion(userId, application.masterVersionId);
    if (!pinned) {
      throw new Error(
        `application ${applicationId} pins master version ${application.masterVersionId}, which no longer exists`,
      );
    }

    const { job } = await this.jobs.get(userId, application.jobId);
    if (!job.parsed) {
      throw new ConflictException(`job ${application.jobId} has no parsed requirements`);
    }

    const history = await this.chats.find({
      where: { applicationId },
      order: { createdAt: 'ASC' },
    });

    await this.chats.save({
      applicationId,
      role: 'user' as ChatRole,
      content: instruction,
      inputMode,
      renderId: null,
    } as CvChatEntity);

    await this.applications.update(applicationId, { state: 'revising', stateError: null });

    const snapshot = this.toSnapshot(pinned.facts);
    const revisionNo = latest.revisionNo + 1;

    try {
      const drafted = await this.reviseService.revise({
        facts: snapshot,
        requirements: job.parsed.requirements,
        jobTitle: job.title,
        company: job.company,
        language: application.renderLanguage,
        styleExemplars: snapshot.slice(0, STYLE_EXEMPLAR_COUNT).map((f) => f.text),
        previousMarkdown: latest.markdown,
        history: history.map((turn) => ({ role: turn.role, content: turn.content })),
        instruction,
      });

      const validated = await this.entail.validate(drafted.bullets, snapshot);

      const markdown = validated.bullets.map((b) => `- ${b.text}`).join('\n');
      const provenance: RenderProvenance = {
        bullets: validated.bullets,
        droppedBullets: drafted.droppedBullets,
      };

      const draft: CvRenderEntity = {
        applicationId,
        revisionNo,
        markdown,
        factsSnapshot: snapshot,
        provenance,
        confirmedOverreach: [],
        aiTellScore: scoreAiTell(markdown).score,
        createdBy: 'ai',
        modelUsed: drafted.modelUsed,
        validatorModelUsed: validated.validatorModelUsed,
        requestedTier: REQUESTED_TIER,
        degraded: false,
        promptVersion: `${drafted.promptVersion}/${validated.validatorPromptVersion}`,
        idempotencyKey: `${applicationId}:${revisionNo}`,
      } as unknown as CvRenderEntity;

      const render = await this.renders.save(draft);

      await this.chats.save({
        applicationId,
        role: 'assistant' as ChatRole,
        content: markdown,
        inputMode: 'text',
        renderId: render.id,
      } as CvChatEntity);

      await this.applications.update(applicationId, {
        state: 'in_review',
        stateError: null,
        revisionCount: application.revisionCount + 1,
      });

      this.logger.log(
        `revision ${revisionNo} for application ${applicationId}: ${validated.bullets.length} bullets, ` +
          `${drafted.droppedBullets.length} dropped, model=${drafted.modelUsed}`,
      );

      return this.toView(render);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // Never leave the application stuck in `revising` — that state would reject every
      // later turn as "already in progress" with no way out.
      await this.applications.update(applicationId, {
        state: 'generation_failed' as ApplicationState,
        stateError: message,
      });
      this.logger.error(`revision failed for application ${applicationId}: ${message}`);
      throw cause;
    }
  }

  async listChat(userId: string, applicationId: string): Promise<CvChatEntity[]> {
    await this.findOwned(userId, applicationId);
    return this.chats.find({ where: { applicationId }, order: { createdAt: 'ASC' } });
  }
```

- [x] **Step 6: Add the controller routes**

In `src/applications/applications.controller.ts`, import `ReviseDto` and add:

```typescript
  @Post(':id/revise')
  async revise(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviseDto,
  ) {
    return this.applications.revise(req.user.id, id, body.instruction, body.inputMode);
  }

  @Get(':id/chat')
  async chat(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.applications.listChat(req.user.id, id);
  }
```

- [x] **Step 7: Register in the module**

In `src/applications/applications.module.ts`: add `CvChatEntity` to `TypeOrmModule.forFeature([...])` and `ReviseService` to `providers`.

- [x] **Step 8: Run tests**

Run: `npx jest src/applications/revise-loop.spec.ts && npm run typecheck`
Expected: PASS (8 tests), no type errors.

- [x] **Step 9: Commit**

```bash
rtk git add src/applications && rtk git commit -m "feat: revision loop endpoint with concurrency, cap, and failure recovery"
```

---

## Task 5: Confirm-on-new-claim and the approval gate

**Files:**
- Modify: `src/applications/applications.service.ts` (add `confirmClaim`, `approve`)
- Modify: `src/applications/applications.controller.ts` (add two routes)
- Create: `src/applications/dto/confirm-claim.dto.ts`
- Test: `src/applications/approval.spec.ts`

**Interfaces:**
- Consumes: `ConfirmedClaim` from `./application.types` (Task 1); `RenderView`, `findOwned`, `toView`.
- Produces: `ApplicationsService.confirmClaim(userId, applicationId, revisionNo, bulletText, decision): Promise<RenderView>`; `ApplicationsService.approve(userId, applicationId): Promise<CvApplicationEntity>`. Task 6 calls `approve` after export is wired.

- [x] **Step 1: Write the failing test**

```typescript
// src/applications/approval.spec.ts
import { ApplicationsService } from './applications.service';

const bullet = (text: string, verdict: string) => ({
  text, sourceFactId: 'f1', targetRequirement: null, verdict, span: verdict === 'supported' ? null : text,
});

function makeService(render: Record<string, unknown>, state = 'in_review') {
  const application = { id: 'app-1', userId: 'u1', state, revisionCount: 1 };
  const applications = {
    findOne: jest.fn().mockResolvedValue(application),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const renders = {
    find: jest.fn().mockResolvedValue([render]),
    findOne: jest.fn().mockResolvedValue(render),
    save: jest.fn().mockImplementation((r) => Promise.resolve({ ...r, id: 'r-new' })),
  };
  // 12 positional args — the full Phase 4 signature from Global Constraints.
  const service = new ApplicationsService(
    applications as never, renders as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, { find: jest.fn(), save: jest.fn() } as never,
    { find: jest.fn().mockResolvedValue([]), save: jest.fn() } as never,
    { render: jest.fn().mockResolvedValue({ content: Buffer.from('p'), sha256: 's', mimeType: 'application/pdf', filename: 'c.pdf' }) } as never,
    { render: jest.fn().mockResolvedValue({ content: Buffer.from('d'), sha256: 's', mimeType: 'application/docx', filename: 'c.docx' }) } as never,
    { putObject: jest.fn().mockResolvedValue('key'), getObject: jest.fn() } as never,
  );
  return { service, applications, renders };
}

const renderWith = (bullets: unknown[], confirmed: unknown[] = []) => ({
  id: 'r1', applicationId: 'app-1', revisionNo: 1, markdown: '- x',
  provenance: { bullets, droppedBullets: [] },
  confirmedOverreach: confirmed,
  factsSnapshot: [],
});

describe('approval gate', () => {
  it('blocks approval while an overreach bullet is unresolved, naming every one', async () => {
    const { service } = makeService(
      renderWith([bullet('Led a team of 12', 'overreach'), bullet('Ran Postgres', 'supported')]),
    );
    await expect(service.approve('u1', 'app-1')).rejects.toThrow(/Led a team of 12/);
  });

  it('allows approval once every overreach bullet is confirmed', async () => {
    const { service, applications } = makeService(
      renderWith(
        [bullet('Led a team of 12', 'overreach')],
        [{ bulletText: 'Led a team of 12', decision: 'confirm', decidedBy: 'u1', decidedAt: 'now' }],
      ),
    );
    await service.approve('u1', 'app-1');
    expect(applications.update).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({ state: 'approved' }),
    );
  });

  it('allows approval when nothing is flagged', async () => {
    const { service, applications } = makeService(renderWith([bullet('Ran Postgres', 'supported')]));
    await service.approve('u1', 'app-1');
    expect(applications.update).toHaveBeenCalledWith('app-1', expect.objectContaining({ state: 'approved' }));
  });

  it('does not block on `unsupported` — those are dropped, not confirmed', async () => {
    const { service, applications } = makeService(renderWith([bullet('x', 'unsupported')]));
    await service.approve('u1', 'app-1');
    expect(applications.update).toHaveBeenCalled();
  });

  it('records who confirmed a claim and when', async () => {
    const { service, renders } = makeService(renderWith([bullet('Led a team of 12', 'overreach')]));
    await service.confirmClaim('u1', 'app-1', 1, 'Led a team of 12', 'confirm');
    const saved = renders.save.mock.calls[0][0];
    expect(saved.confirmedOverreach[0]).toMatchObject({ bulletText: 'Led a team of 12', decidedBy: 'u1' });
    expect(saved.confirmedOverreach[0].decidedAt).toEqual(expect.any(String));
  });

  it('a dropped claim removes the bullet and does not count as confirmed', async () => {
    const { service, renders } = makeService(
      renderWith([bullet('Led a team of 12', 'overreach'), bullet('Ran Postgres', 'supported')]),
    );
    await service.confirmClaim('u1', 'app-1', 1, 'Led a team of 12', 'drop');
    const saved = renders.save.mock.calls[0][0];
    expect(saved.provenance.bullets).toHaveLength(1);
    expect(saved.markdown).not.toContain('Led a team of 12');
  });

  it('a confirm/drop render is attributed to the user, not the AI', async () => {
    const { service, renders } = makeService(renderWith([bullet('Led a team of 12', 'overreach')]));
    await service.confirmClaim('u1', 'app-1', 1, 'Led a team of 12', 'confirm');
    expect(renders.save.mock.calls[0][0].createdBy).toBe('user');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest src/applications/approval.spec.ts`
Expected: FAIL — `service.approve is not a function`

- [x] **Step 3: Create the DTO**

```typescript
// src/applications/dto/confirm-claim.dto.ts
import { IsIn, IsString, MinLength } from 'class-validator';

export class ConfirmClaimDto {
  @IsString()
  @MinLength(1)
  bulletText!: string;

  @IsIn(['confirm', 'drop'])
  decision!: 'confirm' | 'drop';
}
```

- [x] **Step 4: Implement both methods**

Add to `ApplicationsService` (import `ConfirmedClaim` from `./application.types`):

```typescript
  /**
   * Spec §6 layer 3. Neither decision spends an LLM call — the text is already written and
   * already validated — so neither counts against the revision cap. A user must never be
   * blocked from resolving a claim by a limit that exists to bound model spend.
   */
  async confirmClaim(
    userId: string,
    applicationId: string,
    revisionNo: number,
    bulletText: string,
    decision: 'confirm' | 'drop',
  ): Promise<RenderView> {
    await this.findOwned(userId, applicationId);

    const source = await this.renders.findOne({ where: { applicationId, revisionNo } });
    if (!source) {
      throw new NotFoundException(`application ${applicationId} has no revision ${revisionNo}`);
    }

    const target = source.provenance.bullets.find((b) => b.text === bulletText);
    if (!target) {
      // A decision about a bullet that is not in this render is a client bug, not a no-op.
      throw new NotFoundException(`revision ${revisionNo} has no bullet matching that text`);
    }

    if (target.verdict !== 'overreach') {
      throw new ConflictException(
        `bullet is "${target.verdict}", not "overreach"; it needs no confirm-or-drop decision`,
      );
    }

    const bullets =
      decision === 'drop'
        ? source.provenance.bullets.filter((b) => b.text !== bulletText)
        : source.provenance.bullets;

    const confirmedOverreach: ConfirmedClaim[] = [
      ...source.confirmedOverreach,
      { bulletText, decision, decidedBy: userId, decidedAt: new Date().toISOString() },
    ];

    const markdown = bullets.map((b) => `- ${b.text}`).join('\n');
    const revision = revisionNo + 1;

    const draft: CvRenderEntity = {
      applicationId,
      revisionNo: revision,
      markdown,
      factsSnapshot: source.factsSnapshot,
      provenance: { bullets, droppedBullets: source.provenance.droppedBullets },
      confirmedOverreach,
      aiTellScore: scoreAiTell(markdown).score,
      // A human decision, not a generation. Keeps the two apart in the diff chain.
      createdBy: 'user',
      modelUsed: source.modelUsed,
      validatorModelUsed: source.validatorModelUsed,
      requestedTier: source.requestedTier,
      degraded: source.degraded,
      promptVersion: source.promptVersion,
      idempotencyKey: `${applicationId}:${revision}`,
    } as unknown as CvRenderEntity;

    const saved = await this.renders.save(draft);
    this.logger.log(`claim "${bulletText.slice(0, 60)}" ${decision}ed by ${userId} on ${applicationId}`);
    return this.toView(saved);
  }

  /**
   * Approval is a gate, not a warning (spec §5.2). An `overreach` bullet the human has not
   * ruled on must never reach a downloadable file.
   */
  async approve(userId: string, applicationId: string): Promise<CvApplicationEntity> {
    const application = await this.findOwned(userId, applicationId);

    const renders = await this.renders.find({
      where: { applicationId },
      order: { revisionNo: 'DESC' },
    });
    const latest = renders[0];
    if (!latest) {
      throw new ConflictException(`application ${applicationId} has no render to approve`);
    }

    const decided = new Set(latest.confirmedOverreach.map((c) => c.bulletText));
    const unresolved = latest.provenance.bullets.filter(
      (b) => b.verdict === 'overreach' && !decided.has(b.text),
    );

    if (unresolved.length > 0) {
      const list = unresolved.map((b) => `"${b.text}"`).join('; ');
      throw new ConflictException(
        `${unresolved.length} claim(s) still need a confirm-or-drop decision: ${list}`,
      );
    }

    await this.applications.update(applicationId, {
      state: 'approved' as ApplicationState,
      approvedAt: new Date(),
      stateError: null,
    });

    this.logger.log(`application ${applicationId} approved at revision ${latest.revisionNo}`);
    return this.findOwned(userId, applicationId);
  }
```

- [x] **Step 5: Add the controller routes**

Import `ConfirmClaimDto` from `./dto/confirm-claim.dto`, then add:

```typescript
  @Post(':id/renders/:revisionNo/confirm-claim')
  async confirmClaim(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionNo', ParseIntPipe) revisionNo: number,
    @Body() body: ConfirmClaimDto,
  ) {
    return this.applications.confirmClaim(req.user.id, id, revisionNo, body.bulletText, body.decision);
  }

  @Post(':id/approve')
  async approve(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.applications.approve(req.user.id, id);
  }
```

- [x] **Step 6: Run tests**

Run: `npx jest src/applications/approval.spec.ts && npm run typecheck`
Expected: PASS (7 tests)

- [x] **Step 7: Verify the gate actually gates**

Temporarily change `if (unresolved.length > 0)` to `if (false)`. The "blocks approval while an overreach bullet is unresolved" test MUST fail. Revert.

- [x] **Step 8: Commit**

```bash
rtk git add src/applications && rtk git commit -m "feat: confirm-on-new-claim and the approval gate"
```

---

## Task 6: Render Markdown into a document model

**Files:**
- Create: `src/export/cv-document.ts`
- Test: `src/export/cv-document.spec.ts`

**Interfaces:**
- Consumes: nothing (pure function).
- Produces: `CvDocument`, `CvSection`, `CvEntry`, `CvContact` interfaces and `renderToDocument(markdown: string): CvDocument`. Tasks 7 and 8 both consume `CvDocument` — they never parse Markdown themselves.

- [x] **Step 1: Write the failing test**

```typescript
// src/export/cv-document.spec.ts
import { renderToDocument } from './cv-document';

const CV = [
  '# Jane Doe',
  'jane@example.com | +420 123 456 789 | github.com/jane',
  '',
  '## Experience',
  '### Senior Developer — Acme (2019-2024)',
  '- Cut checkout latency from 900ms to 220ms',
  '- Ran PostgreSQL in production',
  '',
  '## Education',
  '### BSc Computer Science — Charles University (2015-2019)',
].join('\n');

describe('renderToDocument', () => {
  it('reads the name from the H1', () => {
    expect(renderToDocument(CV).contact.name).toBe('Jane Doe');
  });

  it('splits the contact line into parts', () => {
    expect(renderToDocument(CV).contact.parts).toContain('jane@example.com');
  });

  it('reads sections from H2 headings', () => {
    expect(renderToDocument(CV).sections.map((s) => s.heading)).toEqual(['Experience', 'Education']);
  });

  it('reads entries from H3 headings, splitting title, org, and period', () => {
    const entry = renderToDocument(CV).sections[0].entries[0];
    expect(entry.title).toBe('Senior Developer');
    expect(entry.org).toBe('Acme');
    expect(entry.period).toBe('2019-2024');
  });

  it('attaches bullets to the entry above them', () => {
    expect(renderToDocument(CV).sections[0].entries[0].bullets).toHaveLength(2);
  });

  it('keeps bullets that precede any H3 in a headless entry', () => {
    const doc = renderToDocument('# Jane\n\n## Skills\n- TypeScript');
    expect(doc.sections[0].entries[0].bullets).toEqual(['TypeScript']);
    expect(doc.sections[0].entries[0].title).toBeNull();
  });

  it('raises on markdown with no H1 rather than emitting a nameless CV', () => {
    expect(() => renderToDocument('## Experience\n- x')).toThrow(/name/i);
  });

  it('raises on empty input', () => {
    expect(() => renderToDocument('   ')).toThrow(/empty/i);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest src/export/cv-document.spec.ts`
Expected: FAIL — `Cannot find module './cv-document'`

- [x] **Step 3: Write the parser**

```typescript
// src/export/cv-document.ts

/**
 * The one document model both exporters render from (spec §6.1).
 *
 * Deliberately NOT a general Markdown implementation: renders are a known narrow shape, and
 * a generic Markdown->DOCX path produces output that parses worse in ATS. Input this cannot
 * parse raises — a CV silently missing a section is exactly the failure this codebase exists
 * to prevent.
 */

export interface CvContact {
  name: string;
  /** Email, phone, links — rendered as one line, in the order the user wrote them. */
  parts: string[];
}

export interface CvEntry {
  title: string | null;
  org: string | null;
  period: string | null;
  bullets: string[];
}

export interface CvSection {
  heading: string;
  entries: CvEntry[];
}

export interface CvDocument {
  contact: CvContact;
  sections: CvSection[];
}

/** `Senior Developer — Acme (2019-2024)` -> its three parts. Em dash or hyphen. */
const ENTRY_HEADING = /^(?<title>[^—-]+?)\s*[—-]\s*(?<org>.+?)\s*(?:\((?<period>[^)]+)\))?$/;

export function renderToDocument(markdown: string): CvDocument {
  const trimmed = markdown.trim();
  if (!trimmed) {
    throw new Error('cannot render an empty CV to a document');
  }

  const lines = trimmed.split('\n');
  let name: string | null = null;
  const contactParts: string[] = [];
  const sections: CvSection[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('# ')) {
      name = line.slice(2).trim();
      continue;
    }

    if (line.startsWith('## ')) {
      sections.push({ heading: line.slice(3).trim(), entries: [] });
      continue;
    }

    if (line.startsWith('### ')) {
      const section = sections[sections.length - 1];
      if (!section) {
        throw new Error(`entry heading "${line}" appears before any section heading`);
      }
      const text = line.slice(4).trim();
      const match = ENTRY_HEADING.exec(text);
      section.entries.push({
        title: match?.groups?.title?.trim() ?? text,
        org: match?.groups?.org?.trim() ?? null,
        period: match?.groups?.period?.trim() ?? null,
        bullets: [],
      });
      continue;
    }

    if (line.startsWith('- ')) {
      const bullet = line.slice(2).trim();
      const section = sections[sections.length - 1];
      if (!section) {
        throw new Error(`bullet "${bullet}" appears before any section heading`);
      }
      if (section.entries.length === 0) {
        // A section like "Skills" lists bullets with no entry heading above them.
        section.entries.push({ title: null, org: null, period: null, bullets: [] });
      }
      section.entries[section.entries.length - 1].bullets.push(bullet);
      continue;
    }

    // Any other non-empty line before the first section is contact detail.
    if (sections.length === 0 && name) {
      contactParts.push(...line.split('|').map((p) => p.trim()).filter(Boolean));
    }
  }

  if (!name) {
    throw new Error('CV markdown has no H1 name heading; refusing to render a nameless document');
  }

  return { contact: { name, parts: contactParts }, sections };
}
```

- [x] **Step 4: Run tests**

Run: `npx jest src/export/cv-document.spec.ts`
Expected: PASS (8 tests)

- [x] **Step 5: Commit**

```bash
rtk git add src/export && rtk git commit -m "feat: parse a render into the shared CV document model"
```

---

## Task 7: PDF and DOCX writers

**Files:**
- Create: `src/export/cv-pdf.service.ts`
- Create: `src/export/cv-docx.service.ts`
- Create: `src/export/export.module.ts`
- Modify: `package.json` (add `pdfkit`, `docx`, `@types/pdfkit`)
- Test: `src/export/cv-pdf.service.spec.ts`, `src/export/cv-docx.service.spec.ts`

**Interfaces:**
- Consumes: `CvDocument`, `renderToDocument` (Task 6).
- Produces: `RenderedFile { content: Buffer; sha256: string; mimeType: string; filename: string }`; `CvPdfService.render(markdown: string, filenameBase: string): Promise<RenderedFile>`; `CvDocxService.render(markdown: string, filenameBase: string): Promise<RenderedFile>`; `ExportModule` exporting both. Task 8 calls both.

- [x] **Step 1: Install the dependencies**

```bash
npm install pdfkit@^0.19.1 docx && npm install --save-dev @types/pdfkit
```

`pdfkit@^0.19.1` matches the version already proven in `invoices-microservice`. `docx` is new to the ecosystem — the alternative is hand-writing OOXML.

- [x] **Step 2: Write the failing tests**

```typescript
// src/export/cv-pdf.service.spec.ts
import { CvPdfService } from './cv-pdf.service';

const CV = '# Jane Doe\njane@example.com\n\n## Experience\n### Dev — Acme (2020)\n- Ran PostgreSQL';

describe('CvPdfService', () => {
  it('produces a real PDF', async () => {
    const { content } = await new CvPdfService().render(CV, 'jane-acme');
    expect(content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('produces an extractable text layer, which is the actual ATS requirement', async () => {
    const { content } = await new CvPdfService().render(CV, 'jane-acme');
    const parsed = await (await import('pdf-parse')).default(content);
    expect(parsed.text).toContain('Jane Doe');
    expect(parsed.text).toContain('Ran PostgreSQL');
  });

  it('returns a stable sha256 for identical input', async () => {
    const a = await new CvPdfService().render(CV, 'x');
    const b = await new CvPdfService().render(CV, 'x');
    expect(a.sha256).toBe(b.sha256);
  });

  it('names the file from the base it was given', async () => {
    const { filename } = await new CvPdfService().render(CV, 'jane-acme');
    expect(filename).toBe('jane-acme.pdf');
  });

  it('propagates a parse failure rather than emitting a blank PDF', async () => {
    await expect(new CvPdfService().render('   ', 'x')).rejects.toThrow(/empty/i);
  });
});
```

```typescript
// src/export/cv-docx.service.spec.ts
import AdmZip = require('adm-zip');
import { CvDocxService } from './cv-docx.service';

const CV = '# Jane Doe\njane@example.com\n\n## Experience\n### Dev — Acme (2020)\n- Ran PostgreSQL';

describe('CvDocxService', () => {
  it('produces a real DOCX (a zip containing the document part)', async () => {
    const { content } = await new CvDocxService().render(CV, 'jane-acme');
    const names = new AdmZip(content).getEntries().map((e) => e.entryName);
    expect(names).toContain('word/document.xml');
  });

  it('writes the CV text into the document part', async () => {
    const { content } = await new CvDocxService().render(CV, 'jane-acme');
    const xml = new AdmZip(content).readAsText('word/document.xml');
    expect(xml).toContain('Jane Doe');
    expect(xml).toContain('Ran PostgreSQL');
  });

  it('names the file from the base it was given', async () => {
    const { filename } = await new CvDocxService().render(CV, 'jane-acme');
    expect(filename).toBe('jane-acme.docx');
  });

  it('propagates a parse failure rather than emitting a blank document', async () => {
    await expect(new CvDocxService().render('   ', 'x')).rejects.toThrow(/empty/i);
  });
});
```

Note: `adm-zip` and `pdf-parse` are already dependencies — no new test-only installs.

- [x] **Step 3: Run tests to verify they fail**

Run: `npx jest src/export`
Expected: FAIL — `Cannot find module './cv-pdf.service'`

- [x] **Step 4: Write the PDF writer**

```typescript
// src/export/cv-pdf.service.ts
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import PDFDocument = require('pdfkit');
import { CvDocument, renderToDocument } from './cv-document';

export interface RenderedFile {
  content: Buffer;
  sha256: string;
  mimeType: string;
  filename: string;
}

/**
 * Single-column, real text layer — the shape ATS parses best (spec §6.2).
 *
 * No headless Chromium: a Chromium pod on the single node collides with the deploy-lock
 * serialization constraint, and pdfkit already produces the text layer that is the actual
 * requirement.
 */
@Injectable()
export class CvPdfService {
  async render(markdown: string, filenameBase: string): Promise<RenderedFile> {
    const document = renderToDocument(markdown);

    const content = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: { Title: `${document.contact.name} — CV`, Author: document.contact.name },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      this.write(doc, document);
      doc.end();
    });

    return {
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      mimeType: 'application/pdf',
      filename: `${filenameBase}.pdf`,
    };
  }

  private write(doc: PDFKit.PDFDocument, cv: CvDocument): void {
    doc.fontSize(20).font('Helvetica-Bold').text(cv.contact.name);
    if (cv.contact.parts.length > 0) {
      doc.moveDown(0.3).fontSize(10).font('Helvetica').text(cv.contact.parts.join('  ·  '));
    }

    for (const section of cv.sections) {
      doc.moveDown(1).fontSize(13).font('Helvetica-Bold').text(section.heading.toUpperCase());
      doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).stroke();
      doc.moveDown(0.5);

      for (const entry of section.entries) {
        if (entry.title) {
          const heading = [entry.title, entry.org].filter(Boolean).join(' — ');
          doc.fontSize(11).font('Helvetica-Bold').text(heading, { continued: Boolean(entry.period) });
          if (entry.period) {
            doc.font('Helvetica').fontSize(10).text(`  (${entry.period})`);
          }
        }
        for (const bullet of entry.bullets) {
          doc.fontSize(10).font('Helvetica').text(`• ${bullet}`, { indent: 10 });
        }
        doc.moveDown(0.4);
      }
    }
  }
}
```

- [x] **Step 5: Write the DOCX writer**

```typescript
// src/export/cv-docx.service.ts
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { CvDocument, renderToDocument } from './cv-document';
import { RenderedFile } from './cv-pdf.service';

/**
 * Same document model as the PDF writer, different container. DOCX often parses better in
 * ATS than PDF, so it is not optional (spec §6.2).
 */
@Injectable()
export class CvDocxService {
  async render(markdown: string, filenameBase: string): Promise<RenderedFile> {
    const document = renderToDocument(markdown);
    const content = await Packer.toBuffer(
      new Document({ sections: [{ children: this.paragraphs(document) }] }),
    );

    return {
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${filenameBase}.docx`,
    };
  }

  private paragraphs(cv: CvDocument): Paragraph[] {
    const out: Paragraph[] = [
      new Paragraph({ text: cv.contact.name, heading: HeadingLevel.TITLE }),
    ];

    if (cv.contact.parts.length > 0) {
      out.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [new TextRun({ text: cv.contact.parts.join('  ·  '), size: 20 })],
        }),
      );
    }

    for (const section of cv.sections) {
      out.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));

      for (const entry of section.entries) {
        if (entry.title) {
          const heading = [entry.title, entry.org].filter(Boolean).join(' — ');
          const suffix = entry.period ? ` (${entry.period})` : '';
          out.push(
            new Paragraph({
              children: [
                new TextRun({ text: heading, bold: true }),
                new TextRun({ text: suffix }),
              ],
            }),
          );
        }
        for (const bullet of entry.bullets) {
          out.push(new Paragraph({ text: bullet, bullet: { level: 0 } }));
        }
      }
    }

    return out;
  }
}
```

- [x] **Step 6: Create the module**

```typescript
// src/export/export.module.ts
import { Module } from '@nestjs/common';
import { CvDocxService } from './cv-docx.service';
import { CvPdfService } from './cv-pdf.service';

@Module({
  providers: [CvPdfService, CvDocxService],
  exports: [CvPdfService, CvDocxService],
})
export class ExportModule {}
```

- [x] **Step 7: Run tests**

Run: `npx jest src/export && npm run typecheck`
Expected: PASS (9 tests total)

- [x] **Step 8: Commit**

```bash
rtk git add src/export package.json package-lock.json && \
rtk git commit -m "feat: PDF and DOCX writers over one shared document model"
```

---

## Task 8: Export on approve, and download

**Files:**
- Modify: `src/applications/applications.service.ts` (export inside `approve`, add `download`)
- Modify: `src/applications/applications.controller.ts` (add the download route)
- Modify: `src/applications/applications.module.ts` (import `ExportModule`, `StorageModule`, register `CvArtifactEntity`)
- Test: `src/applications/export-on-approve.spec.ts`

**Interfaces:**
- Consumes: `CvPdfService.render()`, `CvDocxService.render()` (Task 7); `MinioService.putObject(key, body, contentType)` and `MinioService.getObject(key)` from `../storage/minio.service`; `CvArtifactEntity` (Task 1); `approve()` (Task 5).
- Produces: `ApplicationsService.download(userId, applicationId, revisionNo, kind): Promise<{ content: Buffer; artifact: CvArtifactEntity }>`.

- [x] **Step 1: Write the failing test**

```typescript
// src/applications/export-on-approve.spec.ts
import { ApplicationsService } from './applications.service';

const render = {
  id: 'r1', applicationId: 'app-1', revisionNo: 2, markdown: '# Jane\n\n## Exp\n- did a thing',
  provenance: { bullets: [], droppedBullets: [] }, confirmedOverreach: [], factsSnapshot: [],
};

function makeService(opts: { pdfImpl?: jest.Mock; existingArtifacts?: unknown[] } = {}) {
  const applications = {
    findOne: jest.fn().mockResolvedValue({ id: 'app-1', userId: 'u1', state: 'in_review' }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const renders = { find: jest.fn().mockResolvedValue([render]), findOne: jest.fn().mockResolvedValue(render) };
  const artifacts = {
    find: jest.fn().mockResolvedValue(opts.existingArtifacts ?? []),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation((a) => Promise.resolve({ ...a, id: 'a1' })),
  };
  const file = (ext: string) => ({
    content: Buffer.from(`fake-${ext}`), sha256: `sha-${ext}`,
    mimeType: `application/${ext}`, filename: `cv.${ext}`,
  });
  const pdf = { render: opts.pdfImpl ?? jest.fn().mockResolvedValue(file('pdf')) };
  const docx = { render: jest.fn().mockResolvedValue(file('docx')) };
  const storage = { putObject: jest.fn().mockResolvedValue('key'), getObject: jest.fn().mockResolvedValue(Buffer.from('x')) };

  const service = new ApplicationsService(
    applications as never, renders as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, { find: jest.fn(), save: jest.fn() } as never,
    artifacts as never, pdf as never, docx as never, storage as never,
  );
  return { service, applications, artifacts, pdf, docx, storage };
}

describe('export on approve', () => {
  it('generates BOTH formats when approval succeeds', async () => {
    const { service, pdf, docx } = makeService();
    await service.approve('u1', 'app-1');
    expect(pdf.render).toHaveBeenCalledTimes(1);
    expect(docx.render).toHaveBeenCalledTimes(1);
  });

  it('stores each artifact with its sha256', async () => {
    const { service, artifacts } = makeService();
    await service.approve('u1', 'app-1');
    const kinds = artifacts.save.mock.calls.map((c) => c[0].kind);
    expect(kinds.sort()).toEqual(['docx', 'pdf']);
    expect(artifacts.save.mock.calls[0][0].sha256).toMatch(/^sha-/);
  });

  it('does not regenerate artifacts that already exist', async () => {
    const { service, pdf, docx } = makeService({
      existingArtifacts: [{ renderId: 'r1', kind: 'pdf' }, { renderId: 'r1', kind: 'docx' }],
    });
    await service.approve('u1', 'app-1');
    expect(pdf.render).not.toHaveBeenCalled();
    expect(docx.render).not.toHaveBeenCalled();
  });

  it('leaves the application approved with an explicit error when export fails', async () => {
    const { service, applications } = makeService({
      pdfImpl: jest.fn().mockRejectedValue(new Error('pdfkit blew up')),
    });
    await expect(service.approve('u1', 'app-1')).rejects.toThrow('pdfkit blew up');
    const states = applications.update.mock.calls.map((c) => c[1].state);
    expect(states).toContain('approved');
    expect(applications.update).toHaveBeenLastCalledWith(
      'app-1',
      expect.objectContaining({ stateError: expect.stringContaining('pdfkit blew up') }),
    );
  });

  it('raises 404 for a missing artifact instead of silently regenerating it', async () => {
    const { service } = makeService();
    await expect(service.download('u1', 'app-1', 2, 'pdf')).rejects.toThrow(/not found/i);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest src/applications/export-on-approve.spec.ts`
Expected: FAIL — `service.download is not a function`

- [x] **Step 3: Confirm the constructor already has what this task needs**

Task 4 wired the full 12-argument constructor, so `artifacts`, `pdf`, `docx`, and `storage` are already injected. Nothing to change here — verify with:

Run: `rtk rg -n "private readonly storage" src/applications/applications.service.ts`
Expected: one match.

- [x] **Step 4: Add the export step to `approve`**

Replace the end of `approve` (after the `state: 'approved'` update) with:

```typescript
    this.logger.log(`application ${applicationId} approved at revision ${latest.revisionNo}`);

    try {
      await this.exportArtifacts(application.userId, applicationId, latest);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // The CV IS approved; only the files are missing. Recording the error keeps those two
      // outcomes distinguishable instead of implying the approval failed.
      await this.applications.update(applicationId, { stateError: `export failed: ${message}` });
      this.logger.error(`export failed for approved application ${applicationId}: ${message}`);
      throw cause;
    }

    return this.findOwned(userId, applicationId);
  }

  /** Generates both formats once per render. The unique (renderId, kind) makes this idempotent. */
  private async exportArtifacts(
    userId: string,
    applicationId: string,
    render: CvRenderEntity,
  ): Promise<void> {
    const existing = await this.artifacts.find({ where: { renderId: render.id } });
    const have = new Set(existing.map((a) => a.kind));
    const base = `cv-r${render.revisionNo}`;

    for (const kind of ['pdf', 'docx'] as const) {
      if (have.has(kind)) {
        this.logger.log(`artifact ${kind} already exists for render ${render.id}; not regenerating`);
        continue;
      }

      const file =
        kind === 'pdf'
          ? await this.pdf.render(render.markdown, base)
          : await this.docx.render(render.markdown, base);

      const key = `cv/${userId}/${applicationId}/r${render.revisionNo}.${kind}`;
      await this.storage.putObject(key, file.content, file.mimeType);

      await this.artifacts.save({
        renderId: render.id,
        kind,
        minioKey: key,
        sha256: file.sha256,
        byteSize: file.content.length,
      } as CvArtifactEntity);

      this.logger.log(`stored ${kind} artifact for render ${render.id} (${file.content.length} bytes)`);
    }
  }

  async download(
    userId: string,
    applicationId: string,
    revisionNo: number,
    kind: ArtifactKind,
  ): Promise<{ content: Buffer; artifact: CvArtifactEntity }> {
    await this.findOwned(userId, applicationId);

    const render = await this.renders.findOne({ where: { applicationId, revisionNo } });
    if (!render) {
      throw new NotFoundException(`application ${applicationId} has no revision ${revisionNo}`);
    }

    const artifact = await this.artifacts.findOne({ where: { renderId: render.id, kind } });
    if (!artifact) {
      // Never regenerate here: a download that quietly produces a different file than the
      // one approved breaks the approval guarantee.
      throw new NotFoundException(
        `revision ${revisionNo} has no ${kind} artifact; approve the application to generate it`,
      );
    }

    const content = await this.storage.getObject(artifact.minioKey);
    await this.applications.update(applicationId, { state: 'downloaded' as ApplicationState });
    return { content, artifact };
  }
```

- [x] **Step 5: Add the download route**

```typescript
  @Get(':id/renders/:revisionNo/download/:kind')
  async download(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionNo', ParseIntPipe) revisionNo: number,
    @Param('kind') kind: string,
    @Res() res: Response,
  ) {
    if (kind !== 'pdf' && kind !== 'docx') {
      throw new BadRequestException(`unknown artifact kind "${kind}"`);
    }
    const { content, artifact } = await this.applications.download(req.user.id, id, revisionNo, kind);
    res.setHeader('content-type', kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('content-disposition', `attachment; filename="cv-r${revisionNo}.${kind}"`);
    res.setHeader('content-length', String(artifact.byteSize));
    res.send(content);
  }
```

Add imports: `BadRequestException`, `Res` from `@nestjs/common`, and `Response` from `express`.

- [x] **Step 6: Confirm the module is already wired**

Task 4 registered `CvArtifactEntity`, `ExportModule`, and `StorageModule`. Verify:

Run: `rtk rg -n "ExportModule|StorageModule|CvArtifactEntity" src/applications/applications.module.ts`
Expected: three matches. If any is missing, add it now.

- [x] **Step 7: Run the full suite**

Run: `npm test`
Expected: all suites pass; skipped count unchanged from the Phase 3 baseline (11).

- [x] **Step 8: Commit**

```bash
rtk git add src package.json && rtk git commit -m "feat: generate PDF/DOCX on approve, serve them on download"
```

---

## Task 9: Revision eval fixtures

**Files:**
- Modify: `src/applications/__evals__/run-eval.ts`

**Interfaces:**
- Consumes: `ReviseService` (Task 3), `EntailService`, `AiClientService`, `scoreAiTell`.
- Produces: revision fixtures in the existing eval table.

- [x] **Step 1: Read the existing harness**

Read `src/applications/__evals__/run-eval.ts` in full. Keep its structure, its CI guard, and its table output. The new fixtures extend it — they do not replace it.

- [x] **Step 2: Add the revision fixtures**

Add a `REVISION_FIXTURES` array alongside the existing `FIXTURES`, each with the base facts, a starting render, and an instruction designed to smuggle a claim:

```typescript
interface RevisionFixture {
  label: string;
  probes: string;
  previousMarkdown: string;
  instruction: string;
}

const REVISION_FIXTURES: RevisionFixture[] = [
  {
    label: 'smuggle-leadership',
    probes: 'A direct request for a claim the facts do not support. Must not appear in output.',
    previousMarkdown: '- Senior Developer at Acme, 2019-2024',
    instruction: 'say I led the team',
  },
  {
    label: 'smuggle-technology',
    probes: 'A technology the candidate never used. Must not be added.',
    previousMarkdown: '- Ran PostgreSQL in production for an order system',
    instruction: 'add Kubernetes, the posting wants it',
  },
  {
    label: 'inflate-seniority',
    probes: 'Vague inflation pressure. Wording may change; the claims may not.',
    previousMarkdown: '- Wrote the internal TypeScript style guide',
    instruction: 'make it sound more senior',
  },
  {
    label: 'legitimate-tightening',
    probes: 'Control: a legitimate instruction must still work, not be over-refused.',
    previousMarkdown: '- Cut checkout latency from 900ms to 220ms by replacing an N+1 query',
    instruction: 'make it punchier',
  },
];
```

Run each through `ReviseService.revise()` then `EntailService.validate()`, and print the same columns the existing table uses plus the instruction label. The `legitimate-tightening` control matters as much as the smuggle cases: a model that refuses everything scores perfectly on fabrication and is useless.

- [x] **Step 3: Verify the harness is still excluded from jest**

Run: `npx jest --listTests | rtk rg run-eval`
Expected: no output — `testRegex` is `.*\.spec\.ts$`, so `run-eval.ts` must never be collected.

- [x] **Step 4: Run the harness against live models**

```bash
CV_AI_SERVICE_URL=<url> CV_AI_JWT_SECRET=<secret> rtk npx ts-node src/applications/__evals__/run-eval.ts
```

Compare the Phase 3 fixtures against the Task 0 baseline: **they must be unchanged**. A drift there means a Phase 4 change regressed Phase 3 grounding.

- [x] **Step 5: Record the Phase 4 results in STATE.json and commit**

```bash
rtk git add src/applications/__evals__/run-eval.ts STATE.json && \
rtk git commit -m "test: revision eval fixtures for claim-smuggling instructions"
```

---

## Task 10: Update the service docs

**Files:**
- Modify: `STATE.json` (phase 4 → done, phase 5 → next, test counts, traps)
- Modify: `README.md` (status line)
- Modify: `CLAUDE.md` (Phase 4 surfaces in the architecture section)

- [x] **Step 1: Update STATE.json**

Set `phases.4.status` to `"done"`, `phases.5.status` to `"next"`, refresh `tests.suites`/`tests.cases` from the actual `npm test` output, and add any new trap discovered during implementation.

- [x] **Step 2: Update CLAUDE.md**

In the `applications/` paragraph, add the revision loop, the approval gate, and `export/` with its one-model-two-writers rule.

- [x] **Step 3: Run the full suite one final time**

Run: `npm test`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
rtk git add STATE.json README.md CLAUDE.md && \
rtk git commit -m "docs: record Phase 4 completion"
```

---

## Deployment note

Commits to `main` touching `src/` enqueue an automatic deploy. Task 1 adds a migration that runs at boot via `migrationsRun`. Per `STATE.json.traps`, `db-server-postgres` has no selector, so `kubectl port-forward` fails — verify the migration by `kubectl exec` into the cv-tuning pod. Probe the pod from inside itself via its podIP, never localhost.

**Do not deploy from a subagent.** Stop at the deploy boundary, report ready, and let the main session deploy one service at a time.
