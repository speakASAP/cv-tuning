---
status: done
owner: repository-owner
last_updated: 2026-09-02
---

# CV Tuning Phase 5 Implementation Plan — Outcome Tracking, Dashboard, Nudges

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the state machine past `downloaded` — the user asserts `marked_sent`, records an
outcome, sees a funnel dashboard over their applications, and gets a BPCP-timed nudge a day after
download so the outcome dataset stays alive.

**Architecture:** Three layers, each independently testable. (1) Two new transitions on
`ApplicationsService` (`markSent`, `recordOutcome`) with strict predecessor guards, plus the
`marked_sent`/`outcome` columns finally becoming live data. (2) A read-only `DashboardService`
that aggregates the funnel in SQL, never in JS, so the numbers stay correct as the row count
grows. (3) A `BpcpClientService` that starts a workflow instance at download and delivers a
`sent` / `outcome_recorded` signal on each transition; BPCP's existing `wait-for-signal` timeout
(`onTimeout: 'continue'`, already polled every minute by `InstanceTimeoutService`) calls back
into a new nudge callback endpoint on cv-tuning, which posts the nudge to
notifications-microservice. cv-tuning gains **no scheduler of its own** — the timer lives in BPCP,
which is what Phase 0 built it for.

**Tech Stack:** NestJS 10, TypeORM (migrations via `migrationsRun: true` at boot), Postgres,
Jest. Outbound HTTP through injected `fetch` tokens, matching `AiClientService` and
`JobFetcherService`.

**Spec:** `docs/specs/2026-08-22-cv-tailoring-platform-design.md` — §5 (state machine),
§12 (phase table, row **5**). BPCP contract:
`../business-process-control-plane/docs/specs/2026-08-22-bpcp-workflow-executor-design.md`.

## Global Constraints

- **No third-party users before Phase 7 (GDPR).** Do not add an ingress manifest to
  `deploy.config.sh`. Phase 5 runs on the owner's own data.
- **Free model tiers only** (`cheap` | `smart`). Phase 5 adds **no LLM calls at all** — outcome
  tracking, aggregation, and nudges are all deterministic. If a task tempts you toward an LLM
  call, the design is wrong.
- **No silent failures.** Every catch either re-throws or logs at error level with full context
  (function, URL, params, status, body). "Not found" and "lookup failed" must stay
  distinguishable. An empty aggregate result is a legitimate value; a failed aggregate query is
  not, and must raise.
- **`marked_sent` is user-asserted, not observed** (spec §5). It must be persisted in a way that
  keeps it distinguishable from the observed states, and never inferred from a download.
- **Nudges are fail-soft in one direction only**: a notifications-microservice outage must not
  corrupt cv-tuning state, but it MUST log at error level and leave the nudge un-recorded so it
  can be retried. It must never be swallowed.
- **State transitions never skip.** `outcome` is settable only from `marked_sent`
  (user decision, 2026-08-24). Never from `downloaded`.
- Commit to `main`; the ecosystem deploy queue picks it up. Do not run `deploy.sh` by hand.
- Test gate before every commit: `npm test` (typecheck + build + jest). Never `npx tsc`.
- Baseline test counts from `STATE.json`: 36 suites, 458 cases, 447 passed, **11 skipped**. A skip
  count above 11 means a regression.

---

## File Structure

**New files:**

| File | Responsibility |
|---|---|
| `src/applications/outcome.ts` | Pure transition rules: which state may become `marked_sent`, which may take an outcome. No I/O, no repository. |
| `src/applications/outcome.spec.ts` | Unit tests for the above. |
| `src/applications/dto/mark-sent.dto.ts` | Body for `POST :id/mark-sent` (optional `sentAt`). |
| `src/applications/dto/record-outcome.dto.ts` | Body for `POST :id/outcome`. |
| `src/dashboard/dashboard.service.ts` | Funnel + outcome aggregation, SQL-side. |
| `src/dashboard/dashboard.service.spec.ts` | Tests over an injected fake query builder. |
| `src/dashboard/dashboard.controller.ts` | `GET /api/dashboard`. |
| `src/dashboard/dashboard.module.ts` | Wiring. |
| `src/bpcp/bpcp-client.service.ts` | Start instance, deliver signal. Injected `fetch`. |
| `src/bpcp/bpcp-client.service.spec.ts` | Tests over an injected fake fetch. |
| `src/bpcp/bpcp.module.ts` | Wiring. |
| `src/notifications/notification-client.service.ts` | Posts the nudge to notifications-microservice. |
| `src/notifications/notification-client.service.spec.ts` | Tests over an injected fake fetch. |
| `src/notifications/nudge.controller.ts` | The BPCP action callback that sends a nudge. |
| `src/notifications/nudge.controller.spec.ts` | Tests. |
| `src/notifications/notifications.module.ts` | Wiring. |
| `src/database/migrations/1756800000000-AddOutcomeTracking.ts` | `sentAt`, `outcomeAt`, `nudgedAt` columns. |
| `docs/workflows/cv-application-outcome.workflow.json` | The BPCP workflow definition registered for this. |

**Modified files:**

| File | Change |
|---|---|
| `src/applications/application.types.ts` | Export `OUTCOMES` already exists; add `OutcomeView`/funnel types. |
| `src/applications/entities/cv-application.entity.ts` | Add `sentAt`, `outcomeAt`, `nudgedAt`. |
| `src/applications/applications.service.ts` | Add `markSent`, `recordOutcome`; start the BPCP instance in `download`. |
| `src/applications/applications.controller.ts` | Add `POST :id/mark-sent`, `POST :id/outcome`. |
| `src/applications/applications.module.ts` | Import `BpcpModule`. |
| `src/app.module.ts` | Import `DashboardModule`, `NotificationsModule`, `BpcpModule`. |
| `k8s/configmap.yaml` | Add `CV_BPCP_SERVICE_URL`, `CV_NOTIFICATIONS_SERVICE_URL`, `CV_PUBLIC_BASE_URL`, `CV_NUDGE_RECIPIENT`. |
| `STATE.json` | Phase 5 → done, new traps, updated test counts. |
| `CLAUDE.md` | Phase 5 architecture notes. |

---

### Task 1: Transition rules as a pure module

The state guards are the correctness core of this phase, so they go in a dependency-free module
that can be tested exhaustively without a database.

**Files:**
- Create: `src/applications/outcome.ts`
- Test: `src/applications/outcome.spec.ts`

**Interfaces:**
- Consumes: `ApplicationState`, `Outcome`, `OUTCOMES` from `src/applications/application.types.ts`.
- Produces:
  - `assertCanMarkSent(state: ApplicationState): void` — throws `Error` with a message naming the
    actual state when the transition is illegal.
  - `assertCanRecordOutcome(state: ApplicationState, outcome: string): asserts outcome is Outcome`
    — throws when the state is not `marked_sent`, or the outcome is not one of `OUTCOMES`.
  - `MARK_SENT_FROM: readonly ApplicationState[]` — exported so tests and callers agree on one list.

- [x] **Step 1: Write the failing test**

Create `src/applications/outcome.spec.ts`:

```typescript
import { APPLICATION_STATES, ApplicationState } from './application.types';
import { assertCanMarkSent, assertCanRecordOutcome, MARK_SENT_FROM } from './outcome';

describe('assertCanMarkSent', () => {
  it('allows the transition only from downloaded', () => {
    expect(MARK_SENT_FROM).toEqual(['downloaded']);
    expect(() => assertCanMarkSent('downloaded')).not.toThrow();
  });

  it('rejects every other state, naming the actual state so the failure is diagnosable', () => {
    const illegal = APPLICATION_STATES.filter((s) => s !== 'downloaded');
    for (const state of illegal) {
      expect(() => assertCanMarkSent(state)).toThrow(new RegExp(state));
    }
  });

  // A user who never downloaded cannot have sent anything. Allowing `approved` here would let
  // the funnel report a send with no artifact behind it.
  it('rejects approved, which has artifacts but no evidence the user took them', () => {
    expect(() => assertCanMarkSent('approved')).toThrow(/approved/);
  });
});

describe('assertCanRecordOutcome', () => {
  it('accepts each known outcome from marked_sent', () => {
    for (const outcome of ['interview', 'rejected', 'offer', 'ghosted']) {
      expect(() => assertCanRecordOutcome('marked_sent', outcome)).not.toThrow();
    }
  });

  it('rejects an outcome from downloaded, because sending is a prerequisite for a reply', () => {
    expect(() => assertCanRecordOutcome('downloaded', 'interview')).toThrow(/marked_sent/);
  });

  it('rejects an unknown outcome value rather than persisting free text', () => {
    expect(() => assertCanRecordOutcome('marked_sent', 'maybe')).toThrow(/maybe/);
  });

  it('names the legal outcomes in the error so the caller can correct the request', () => {
    expect(() => assertCanRecordOutcome('marked_sent', 'maybe')).toThrow(/interview/);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx jest src/applications/outcome.spec.ts`
Expected: FAIL — `Cannot find module './outcome'`.

- [x] **Step 3: Write the minimal implementation**

Create `src/applications/outcome.ts`:

```typescript
import { ApplicationState, Outcome, OUTCOMES } from './application.types';

/**
 * Spec §5. `marked_sent` follows `downloaded` and nothing else.
 *
 * `approved` is deliberately excluded: an approved application has artifacts, but nothing
 * shows the user ever took them. Accepting a send from `approved` would let the funnel count
 * a submission that never had a file behind it.
 */
export const MARK_SENT_FROM: readonly ApplicationState[] = ['downloaded'];

export function assertCanMarkSent(state: ApplicationState): void {
  if (!MARK_SENT_FROM.includes(state)) {
    throw new Error(
      `cannot mark an application as sent from state "${state}"; expected one of ${MARK_SENT_FROM.join(', ')}`,
    );
  }
}

/**
 * Spec §5. An outcome is a reply to a submission, so it is only meaningful once the user has
 * asserted the submission happened. Recording an outcome from `downloaded` would silently
 * invent the missing `marked_sent` step and make every conversion rate on the dashboard wrong.
 */
export function assertCanRecordOutcome(
  state: ApplicationState,
  outcome: string,
): asserts outcome is Outcome {
  if (state !== 'marked_sent') {
    throw new Error(
      `cannot record an outcome from state "${state}"; the application must be marked_sent first`,
    );
  }
  if (!(OUTCOMES as readonly string[]).includes(outcome)) {
    throw new Error(`unknown outcome "${outcome}"; expected one of ${OUTCOMES.join(', ')}`);
  }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx jest src/applications/outcome.spec.ts`
Expected: PASS, 6 cases.

- [x] **Step 5: Confirm the test fails when the behaviour is broken**

Temporarily change `MARK_SENT_FROM` to `['downloaded', 'approved']`, re-run, and confirm the
"rejects approved" case fails. Revert.

- [x] **Step 6: Commit**

```bash
git add src/applications/outcome.ts src/applications/outcome.spec.ts
git commit -m "feat(applications): transition rules for marked_sent and outcome"
```

---

### Task 2: Timestamp columns and migration

`state` alone cannot answer "how long until a reply?" or "was this nudged already?". Three
nullable timestamps carry that, and `nudgedAt` is what makes the nudge idempotent.

**Files:**
- Modify: `src/applications/entities/cv-application.entity.ts`
- Create: `src/database/migrations/1756800000000-AddOutcomeTracking.ts`
- Test: `src/applications/entities/phase4-entities.spec.ts` (extend; rename not required)

**Interfaces:**
- Produces: `CvApplicationEntity.sentAt: Date | null`, `.outcomeAt: Date | null`,
  `.nudgedAt: Date | null`.

- [x] **Step 1: Write the failing test**

Append to `src/applications/entities/phase4-entities.spec.ts`:

```typescript
import { getMetadataArgsStorage } from 'typeorm';
import { CvApplicationEntity } from './cv-application.entity';

describe('cv_application outcome-tracking columns', () => {
  const columnsFor = (target: Function): string[] =>
    getMetadataArgsStorage()
      .columns.filter((c) => c.target === target)
      .map((c) => c.propertyName);

  it('carries sentAt, outcomeAt and nudgedAt', () => {
    const columns = columnsFor(CvApplicationEntity);
    expect(columns).toContain('sentAt');
    expect(columns).toContain('outcomeAt');
    expect(columns).toContain('nudgedAt');
  });

  it('declares all three nullable, because they are absent for most of an application life', () => {
    const declared = getMetadataArgsStorage().columns.filter(
      (c) => c.target === CvApplicationEntity && ['sentAt', 'outcomeAt', 'nudgedAt'].includes(c.propertyName),
    );
    expect(declared).toHaveLength(3);
    for (const column of declared) {
      expect(column.options.nullable).toBe(true);
      expect(column.options.type).toBe('timestamptz');
    }
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx jest src/applications/entities/phase4-entities.spec.ts`
Expected: FAIL — `expect(columns).toContain('sentAt')`.

- [x] **Step 3: Add the columns to the entity**

In `src/applications/entities/cv-application.entity.ts`, add after the `outcome` column:

```typescript
  /**
   * When the user ASSERTED they submitted (spec §5). Distinct from `updatedAt`, which moves on
   * every write: the funnel measures reply latency from the send, so it needs the send's own
   * timestamp. Null until the user marks it sent — never inferred from a download.
   */
  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  /** When the outcome was recorded. Null while `outcome` is null; the two are written together. */
  @Column({ type: 'timestamptz', nullable: true })
  outcomeAt!: Date | null;

  /**
   * When the "any response?" nudge was sent (spec §5). Set once and checked before sending, so a
   * BPCP retry or a duplicate timeout delivery cannot nag the user twice about one application.
   */
  @Column({ type: 'timestamptz', nullable: true })
  nudgedAt!: Date | null;
```

- [x] **Step 4: Write the migration**

Create `src/database/migrations/1756800000000-AddOutcomeTracking.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 5, spec §5. All three columns are nullable with no backfill: an application that
 * predates outcome tracking genuinely has no send date, and inventing one — say, from
 * `updatedAt` — would put fabricated timestamps into the funnel the dashboard reports on.
 */
export class AddOutcomeTracking1756800000000 implements MigrationInterface {
  name = 'AddOutcomeTracking1756800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "cv_application" ADD COLUMN "sentAt" timestamptz`);
    await queryRunner.query(`ALTER TABLE "cv_application" ADD COLUMN "outcomeAt" timestamptz`);
    await queryRunner.query(`ALTER TABLE "cv_application" ADD COLUMN "nudgedAt" timestamptz`);
    // The dashboard funnel filters by user and groups by state; without this it seq-scans.
    await queryRunner.query(
      `CREATE INDEX "idx_application_user_state" ON "cv_application" ("userId", "state")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_application_user_state"`);
    await queryRunner.query(`ALTER TABLE "cv_application" DROP COLUMN "nudgedAt"`);
    await queryRunner.query(`ALTER TABLE "cv_application" DROP COLUMN "outcomeAt"`);
    await queryRunner.query(`ALTER TABLE "cv_application" DROP COLUMN "sentAt"`);
  }
}
```

- [x] **Step 5: Register the migration**

Migrations are discovered by glob, not by list — confirm with:

```bash
rtk rg -n "migrations" src/database/database.module.ts
```

If the module lists migrations explicitly, add `AddOutcomeTracking1756800000000` to that array.
If it globs (`migrations: [__dirname + '/migrations/*.js']` or similar), no change is needed.

- [x] **Step 6: Run the tests**

Run: `npx jest src/applications/entities/phase4-entities.spec.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/applications/entities/cv-application.entity.ts src/database/migrations/1756800000000-AddOutcomeTracking.ts src/applications/entities/phase4-entities.spec.ts
git commit -m "feat(applications): sentAt, outcomeAt and nudgedAt columns"
```

---

### Task 3: `markSent` and `recordOutcome` on the service

**Files:**
- Modify: `src/applications/applications.service.ts`
- Create: `src/applications/dto/mark-sent.dto.ts`, `src/applications/dto/record-outcome.dto.ts`
- Test: `src/applications/outcome-tracking.spec.ts`

**Interfaces:**
- Consumes: `assertCanMarkSent`, `assertCanRecordOutcome` (Task 1); `sentAt`/`outcomeAt` (Task 2);
  the existing private `findOwned(userId, applicationId): Promise<CvApplicationEntity>`.
- Produces:
  - `ApplicationsService.markSent(userId: string, applicationId: string, sentAt?: Date): Promise<CvApplicationEntity>`
  - `ApplicationsService.recordOutcome(userId: string, applicationId: string, outcome: string): Promise<CvApplicationEntity>`

- [x] **Step 1: Write the failing test**

Create `src/applications/outcome-tracking.spec.ts`. It builds the service with fake
repositories, following the pattern already used in `approval-recovery.spec.ts` — open that file
first and mirror its construction so the fakes stay consistent across the suite.

```typescript
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { CvApplicationEntity } from './entities/cv-application.entity';

/** Minimal repository double: one row, recording every update it is asked to apply. */
const makeApplicationsRepo = (row: Partial<CvApplicationEntity>) => {
  const stored = { id: 'app-1', userId: 'user-1', ...row } as CvApplicationEntity;
  const updates: Partial<CvApplicationEntity>[] = [];
  return {
    stored,
    updates,
    findOne: jest.fn(async ({ where }: any) =>
      where.id === stored.id && (where.userId === undefined || where.userId === stored.userId)
        ? stored
        : null,
    ),
    update: jest.fn(async (_id: string, patch: Partial<CvApplicationEntity>) => {
      updates.push(patch);
      Object.assign(stored, patch);
    }),
  };
};

const buildService = (repo: ReturnType<typeof makeApplicationsRepo>): ApplicationsService =>
  // Only the applications repository participates in these two methods; the remaining
  // collaborators are never reached, so passing null keeps the test honest — if a future edit
  // starts calling one, this test crashes loudly rather than quietly exercising a stub.
  //
  // Parameter order is the REAL one from applications.service.ts:62 — applications, renders,
  // jobs, master, tailor, entail, reviseService, chats, artifacts, pdf, docx, storage — with
  // `bpcp` appended as the 13th in Task 3.
  new ApplicationsService(
    repo as any,
    null as any, // renders
    null as any, // jobs
    null as any, // master
    null as any, // tailor
    null as any, // entail
    null as any, // reviseService
    null as any, // chats
    null as any, // artifacts
    null as any, // pdf
    null as any, // docx
    null as any, // storage
    { startOutcomeWatch: jest.fn(), deliverSignal: jest.fn() } as any, // bpcp
  );

describe('markSent', () => {
  it('records the assertion and moves the state', async () => {
    const repo = makeApplicationsRepo({ state: 'downloaded', bpcpInstanceId: 'inst-1' });
    const service = buildService(repo);

    const result = await service.markSent('user-1', 'app-1');

    expect(result.state).toBe('marked_sent');
    expect(result.sentAt).toBeInstanceOf(Date);
  });

  it('refuses from a state that has no download behind it', async () => {
    const repo = makeApplicationsRepo({ state: 'in_review' });
    const service = buildService(repo);

    await expect(service.markSent('user-1', 'app-1')).rejects.toThrow(ConflictException);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('is idempotent: marking an already-sent application does not move sentAt', async () => {
    const originalSentAt = new Date('2026-08-01T10:00:00.000Z');
    const repo = makeApplicationsRepo({ state: 'marked_sent', sentAt: originalSentAt });
    const service = buildService(repo);

    const result = await service.markSent('user-1', 'app-1');

    expect(result.sentAt).toEqual(originalSentAt);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('accepts a user-supplied send date, because the user may mark it days later', async () => {
    const repo = makeApplicationsRepo({ state: 'downloaded' });
    const service = buildService(repo);
    const backdated = new Date('2026-08-20T09:00:00.000Z');

    const result = await service.markSent('user-1', 'app-1', backdated);

    expect(result.sentAt).toEqual(backdated);
  });

  it('rejects a send date in the future rather than storing an impossible funnel entry', async () => {
    const repo = makeApplicationsRepo({ state: 'downloaded' });
    const service = buildService(repo);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await expect(service.markSent('user-1', 'app-1', future)).rejects.toThrow(/future/);
  });
});

describe('recordOutcome', () => {
  it('stores the outcome and its timestamp together', async () => {
    const repo = makeApplicationsRepo({ state: 'marked_sent', sentAt: new Date() });
    const service = buildService(repo);

    const result = await service.recordOutcome('user-1', 'app-1', 'interview');

    expect(result.outcome).toBe('interview');
    expect(result.outcomeAt).toBeInstanceOf(Date);
  });

  it('refuses an outcome before the user asserted the send', async () => {
    const repo = makeApplicationsRepo({ state: 'downloaded' });
    const service = buildService(repo);

    await expect(service.recordOutcome('user-1', 'app-1', 'interview')).rejects.toThrow(
      ConflictException,
    );
  });

  it('refuses an unknown outcome instead of persisting free text', async () => {
    const repo = makeApplicationsRepo({ state: 'marked_sent' });
    const service = buildService(repo);

    await expect(service.recordOutcome('user-1', 'app-1', 'ghosting')).rejects.toThrow(
      ConflictException,
    );
  });

  it('allows a correction: ghosted then interview overwrites and re-stamps', async () => {
    const repo = makeApplicationsRepo({
      state: 'marked_sent',
      outcome: 'ghosted',
      outcomeAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const service = buildService(repo);

    const result = await service.recordOutcome('user-1', 'app-1', 'interview');

    expect(result.outcome).toBe('interview');
    expect(result.outcomeAt!.getTime()).toBeGreaterThan(new Date('2026-08-01T00:00:00.000Z').getTime());
  });

  it('does not find another user application', async () => {
    const repo = makeApplicationsRepo({ state: 'marked_sent' });
    const service = buildService(repo);

    await expect(service.recordOutcome('someone-else', 'app-1', 'offer')).rejects.toThrow(
      NotFoundException,
    );
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx jest src/applications/outcome-tracking.spec.ts`
Expected: FAIL — `service.markSent is not a function`.

- [x] **Step 3: Implement both methods**

Add to `src/applications/applications.service.ts`, after `download`:

```typescript
  /**
   * Spec §5. `marked_sent` is USER-ASSERTED: the app cannot observe a submission on a
   * third-party portal, so this records a claim, not an observation. It is stored with its own
   * timestamp and stays visually distinct from the observed states downstream.
   *
   * Idempotent by design. The nudge invites the user to answer "did you send it?", and a user
   * who taps twice must not have their original send date overwritten with today's — that would
   * silently reset the reply-latency the dashboard reports.
   */
  async markSent(
    userId: string,
    applicationId: string,
    sentAt?: Date,
  ): Promise<CvApplicationEntity> {
    const application = await this.findOwned(userId, applicationId);

    if (application.state === 'marked_sent') {
      return application;
    }

    try {
      assertCanMarkSent(application.state);
    } catch (cause) {
      // A wrong-state transition is the caller's error, not a server fault: 409, with the
      // reason preserved so the client can tell the user what to do instead.
      throw new ConflictException(cause instanceof Error ? cause.message : String(cause));
    }

    const now = new Date();
    const effectiveSentAt = sentAt ?? now;
    if (effectiveSentAt.getTime() > now.getTime()) {
      throw new ConflictException(
        `sentAt ${effectiveSentAt.toISOString()} is in the future; an application cannot be sent later than now`,
      );
    }

    await this.applications.update(applicationId, {
      state: 'marked_sent' as ApplicationState,
      sentAt: effectiveSentAt,
    });
    application.state = 'marked_sent';
    application.sentAt = effectiveSentAt;

    // The nudge exists to ask this exact question, so answering it retires the timer. A failure
    // here must not undo a state change the user already made, but it is logged loudly: a
    // silently-surviving watch would nag a user who has already replied.
    await this.retireOutcomeWatch(application, 'sent');

    this.logger.log(`application ${applicationId} marked sent at ${effectiveSentAt.toISOString()}`);
    return application;
  }

  /**
   * Spec §5. The terminal step of the funnel. Gated on `marked_sent` because an outcome is a
   * reply to a submission: accepting one from `downloaded` would invent the missing send and
   * make every conversion rate on the dashboard wrong.
   *
   * Re-recording is allowed and overwrites. `ghosted` is a provisional verdict by nature — a
   * reply three weeks later must be recordable, and refusing the correction would freeze the
   * dataset at its least accurate reading.
   */
  async recordOutcome(
    userId: string,
    applicationId: string,
    outcome: string,
  ): Promise<CvApplicationEntity> {
    const application = await this.findOwned(userId, applicationId);

    try {
      assertCanRecordOutcome(application.state, outcome);
    } catch (cause) {
      throw new ConflictException(cause instanceof Error ? cause.message : String(cause));
    }

    const outcomeAt = new Date();
    await this.applications.update(applicationId, { outcome, outcomeAt });
    application.outcome = outcome;
    application.outcomeAt = outcomeAt;

    await this.retireOutcomeWatch(application, 'outcome_recorded');

    this.logger.log(`application ${applicationId} outcome recorded as ${outcome}`);
    return application;
  }

  /**
   * Delivers the signal that ends the BPCP outcome watch. Fail-soft in exactly one direction:
   * the user's state change has already been persisted and must stand, but the failure is
   * logged at error level with full context so a stuck instance is visible rather than silent.
   */
  private async retireOutcomeWatch(
    application: CvApplicationEntity,
    signal: 'sent' | 'outcome_recorded',
  ): Promise<void> {
    if (!application.bpcpInstanceId) {
      return;
    }
    try {
      await this.bpcp.deliverSignal(application.bpcpInstanceId, signal, {
        applicationId: application.id,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(
        `failed to deliver "${signal}" to BPCP instance ${application.bpcpInstanceId} for application ${application.id}: ${message}`,
      );
    }
  }
```

Add the import at the top of the file:

```typescript
import { assertCanMarkSent, assertCanRecordOutcome } from './outcome';
```

Add `bpcp` to the constructor (the last parameter, matching the test's fake):

```typescript
    private readonly bpcp: BpcpClientService,
```

with `import { BpcpClientService } from '../bpcp/bpcp-client.service';`. `BpcpClientService` is
built in Task 5 — until then this will not compile, so implement Task 5 before running `npm test`.
To keep this task independently green, create the file now as a stub with the two method
signatures and a `throw new Error('not implemented')` body, and replace it in Task 5.

- [x] **Step 4: Write the DTOs**

Create `src/applications/dto/mark-sent.dto.ts`:

```typescript
import { IsDateString, IsOptional } from 'class-validator';

export class MarkSentDto {
  /**
   * When the user actually submitted, if not now. Optional because the common case is "I just
   * sent it"; present because the nudge arrives a day later and the honest answer is often
   * "yesterday".
   */
  @IsOptional()
  @IsDateString()
  sentAt?: string;
}
```

Create `src/applications/dto/record-outcome.dto.ts`:

```typescript
import { IsIn, IsString } from 'class-validator';
import { OUTCOMES } from '../application.types';

export class RecordOutcomeDto {
  @IsString()
  @IsIn(OUTCOMES as unknown as string[])
  outcome!: string;
}
```

- [x] **Step 5: Run the tests**

Run: `npx jest src/applications/outcome-tracking.spec.ts`
Expected: PASS, 10 cases.

- [x] **Step 6: Confirm the guard is load-bearing**

Temporarily change `assertCanRecordOutcome`'s state check to `state !== 'nonexistent'`, re-run,
and confirm "refuses an outcome before the user asserted the send" fails. Revert.

- [x] **Step 7: Commit**

```bash
git add src/applications/applications.service.ts src/applications/dto/mark-sent.dto.ts src/applications/dto/record-outcome.dto.ts src/applications/outcome-tracking.spec.ts
git commit -m "feat(applications): markSent and recordOutcome transitions"
```

---

### Task 4: Controller endpoints

**Files:**
- Modify: `src/applications/applications.controller.ts`
- Test: `src/applications/applications.controller.spec.ts` (extend)

**Interfaces:**
- Consumes: `markSent`, `recordOutcome` (Task 3); `MarkSentDto`, `RecordOutcomeDto`.
- Produces: `POST /api/applications/:id/mark-sent`, `POST /api/applications/:id/outcome`.

- [x] **Step 1: Write the failing test**

Append to `src/applications/applications.controller.spec.ts` (mirror the existing describe
block's service-double construction):

```typescript
describe('outcome endpoints', () => {
  it('passes the token user id, never a body-supplied one, to markSent', async () => {
    const service = { markSent: jest.fn(async () => ({ state: 'marked_sent' })) };
    const controller = new ApplicationsController(service as any);

    await controller.markSent({ user: { id: 'user-1' } } as any, 'app-1', {});

    expect(service.markSent).toHaveBeenCalledWith('user-1', 'app-1', undefined);
  });

  it('parses a supplied sentAt into a Date before it reaches the service', async () => {
    const service = { markSent: jest.fn(async () => ({ state: 'marked_sent' })) };
    const controller = new ApplicationsController(service as any);

    await controller.markSent({ user: { id: 'user-1' } } as any, 'app-1', {
      sentAt: '2026-08-20T09:00:00.000Z',
    });

    expect(service.markSent).toHaveBeenCalledWith(
      'user-1',
      'app-1',
      new Date('2026-08-20T09:00:00.000Z'),
    );
  });

  it('forwards the outcome value', async () => {
    const service = { recordOutcome: jest.fn(async () => ({ outcome: 'offer' })) };
    const controller = new ApplicationsController(service as any);

    await controller.recordOutcome({ user: { id: 'user-1' } } as any, 'app-1', {
      outcome: 'offer',
    });

    expect(service.recordOutcome).toHaveBeenCalledWith('user-1', 'app-1', 'offer');
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx jest src/applications/applications.controller.spec.ts`
Expected: FAIL — `controller.markSent is not a function`.

- [x] **Step 3: Add the endpoints**

In `src/applications/applications.controller.ts`, after `retryExport`:

```typescript
  /**
   * Spec §5. User-asserted submission — the app cannot observe a send on a third-party portal.
   */
  @Post(':id/mark-sent')
  async markSent(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MarkSentDto,
  ) {
    return this.applications.markSent(
      req.user.id,
      id,
      body.sentAt ? new Date(body.sentAt) : undefined,
    );
  }

  @Post(':id/outcome')
  async recordOutcome(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecordOutcomeDto,
  ) {
    return this.applications.recordOutcome(req.user.id, id, body.outcome);
  }
```

Add imports:

```typescript
import { MarkSentDto } from './dto/mark-sent.dto';
import { RecordOutcomeDto } from './dto/record-outcome.dto';
```

- [x] **Step 4: Run the tests**

Run: `npx jest src/applications/applications.controller.spec.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/applications/applications.controller.ts src/applications/applications.controller.spec.ts
git commit -m "feat(applications): mark-sent and outcome endpoints"
```

---

### Task 5: BPCP client

**Files:**
- Create: `src/bpcp/bpcp-client.service.ts`, `src/bpcp/bpcp-client.service.spec.ts`, `src/bpcp/bpcp.module.ts`
- Modify: `src/applications/applications.module.ts` (import `BpcpModule`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `BPCP_FETCH = 'CV_BPCP_FETCH'`, `BPCP_SERVICE_URL = 'CV_BPCP_SERVICE_URL'` (injection tokens)
  - `BpcpClientService.startOutcomeWatch(applicationId: string, userId: string): Promise<string | null>`
    — returns the new instance id, or `null` when BPCP is not configured.
  - `BpcpClientService.deliverSignal(instanceId: string, name: string, payload: Record<string, unknown>): Promise<void>`
  - `OUTCOME_WORKFLOW_ID = 'cv-application-outcome'`, `OUTCOME_WORKFLOW_VERSION = 1`

The contract is BPCP's real one, verified against
`../business-process-control-plane/src/instances/instance.controller.ts`:
`POST /api/instances` takes `{workflowId, workflowVersion, correlationKey, context}`;
`POST /api/instances/:id/signals` takes `{name, payload}`. Neither endpoint carries an auth
guard today.

- [x] **Step 1: Write the failing test**

Create `src/bpcp/bpcp-client.service.spec.ts`:

```typescript
import { BpcpClientService, OUTCOME_WORKFLOW_ID, OUTCOME_WORKFLOW_VERSION } from './bpcp-client.service';

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

describe('startOutcomeWatch', () => {
  it('starts an instance correlated to the application', async () => {
    const fetchImpl = jest.fn(async () => okResponse({ instanceId: 'inst-9' }));
    const service = new BpcpClientService(fetchImpl as any, 'http://bpcp:3375');

    const instanceId = await service.startOutcomeWatch('app-1', 'user-1');

    expect(instanceId).toBe('inst-9');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://bpcp:3375/api/instances');
    expect(JSON.parse(init.body as string)).toEqual({
      workflowId: OUTCOME_WORKFLOW_ID,
      workflowVersion: OUTCOME_WORKFLOW_VERSION,
      correlationKey: 'app-1',
      context: { applicationId: 'app-1', userId: 'user-1' },
    });
  });

  it('returns null when no BPCP url is configured, so a dev box runs without the workflow plane', async () => {
    const fetchImpl = jest.fn();
    const service = new BpcpClientService(fetchImpl as any, undefined);

    expect(await service.startOutcomeWatch('app-1', 'user-1')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('raises with status and body on a non-ok response rather than returning null', async () => {
    const fetchImpl = jest.fn(async () =>
      ({ ok: false, status: 500, text: async () => 'boom' }) as Response,
    );
    const service = new BpcpClientService(fetchImpl as any, 'http://bpcp:3375');

    // "Not configured" and "the call failed" are different outcomes and must not collapse
    // into the same null.
    await expect(service.startOutcomeWatch('app-1', 'user-1')).rejects.toThrow(/500.*boom/s);
  });

  it('raises when the response carries no instanceId', async () => {
    const fetchImpl = jest.fn(async () => okResponse({}));
    const service = new BpcpClientService(fetchImpl as any, 'http://bpcp:3375');

    await expect(service.startOutcomeWatch('app-1', 'user-1')).rejects.toThrow(/instanceId/);
  });
});

describe('deliverSignal', () => {
  it('posts the signal to the instance', async () => {
    const fetchImpl = jest.fn(async () => okResponse({ status: 'completed' }));
    const service = new BpcpClientService(fetchImpl as any, 'http://bpcp:3375');

    await service.deliverSignal('inst-9', 'sent', { applicationId: 'app-1' });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://bpcp:3375/api/instances/inst-9/signals');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'sent', payload: { applicationId: 'app-1' } });
  });

  it('raises on a non-ok response, with the status and body in the message', async () => {
    const fetchImpl = jest.fn(async () =>
      ({ ok: false, status: 404, text: async () => 'no such instance' }) as Response,
    );
    const service = new BpcpClientService(fetchImpl as any, 'http://bpcp:3375');

    await expect(service.deliverSignal('inst-9', 'sent', {})).rejects.toThrow(/404.*no such instance/s);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx jest src/bpcp/bpcp-client.service.spec.ts`
Expected: FAIL — module not found (or "not implemented" if Task 3's stub is in place).

- [x] **Step 3: Implement the client**

Create `src/bpcp/bpcp-client.service.ts`:

```typescript
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

export const BPCP_FETCH = 'CV_BPCP_FETCH';
export const BPCP_SERVICE_URL = 'CV_BPCP_SERVICE_URL';

/**
 * The workflow registered in `docs/workflows/cv-application-outcome.workflow.json`. Its single
 * `wait-for-signal` action carries `onTimeout: 'continue'`, so BPCP's minute-by-minute
 * `InstanceTimeoutService` sweep is what fires the nudge — cv-tuning owns no timer of its own.
 */
export const OUTCOME_WORKFLOW_ID = 'cv-application-outcome';
export const OUTCOME_WORKFLOW_VERSION = 1;

/** Well below the LiteLLM-facing budgets elsewhere: these are local control-plane calls. */
const TIMEOUT_MS = 10_000;

@Injectable()
export class BpcpClientService {
  private readonly logger = new Logger(BpcpClientService.name);

  constructor(
    @Optional() @Inject(BPCP_FETCH) private readonly fetchImpl: typeof fetch = fetch,
    @Optional() @Inject(BPCP_SERVICE_URL) private readonly baseUrl?: string,
  ) {}

  /**
   * Starts the outcome watch for one application. Returns the instance id, or `null` when no
   * BPCP url is configured — a local dev box without the workflow plane still runs the rest of
   * the product. That null is ONLY ever "not configured": a call that was attempted and failed
   * raises, because a silently-missing watch means a user is never nudged and nobody finds out.
   */
  async startOutcomeWatch(applicationId: string, userId: string): Promise<string | null> {
    if (!this.baseUrl) {
      this.logger.warn(
        `${BPCP_SERVICE_URL} is not set; application ${applicationId} gets no outcome watch and will never be nudged`,
      );
      return null;
    }

    const url = `${this.baseUrl}/api/instances`;
    const body = {
      workflowId: OUTCOME_WORKFLOW_ID,
      workflowVersion: OUTCOME_WORKFLOW_VERSION,
      correlationKey: applicationId,
      context: { applicationId, userId },
    };

    const response = await this.post(url, body);
    const payload = (await response.json()) as { instanceId?: string };
    if (!payload.instanceId) {
      throw new Error(
        `BPCP ${url} returned no instanceId for application ${applicationId}: ${JSON.stringify(payload)}`,
      );
    }

    this.logger.log(`started outcome watch ${payload.instanceId} for application ${applicationId}`);
    return payload.instanceId;
  }

  async deliverSignal(
    instanceId: string,
    name: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.baseUrl) {
      this.logger.warn(`${BPCP_SERVICE_URL} is not set; dropping signal "${name}" for ${instanceId}`);
      return;
    }
    await this.post(`${this.baseUrl}/api/instances/${instanceId}/signals`, { name, payload });
    this.logger.log(`delivered signal "${name}" to instance ${instanceId}`);
  }

  private async post(url: string, body: unknown): Promise<Response> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      // Status AND body: a bare "request failed" cannot be diagnosed from a log line.
      throw new Error(`BPCP ${url} failed with ${response.status}: ${text}`);
    }
    return response;
  }
}
```

Create `src/bpcp/bpcp.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { BpcpClientService, BPCP_SERVICE_URL } from './bpcp-client.service';

@Module({
  providers: [
    BpcpClientService,
    { provide: BPCP_SERVICE_URL, useFactory: () => process.env.CV_BPCP_SERVICE_URL },
  ],
  exports: [BpcpClientService],
})
export class BpcpModule {}
```

- [x] **Step 4: Wire it into the applications module**

In `src/applications/applications.module.ts`, add `BpcpModule` to `imports`.

- [x] **Step 5: Run the tests**

Run: `npx jest src/bpcp/`
Expected: PASS, 6 cases.

- [x] **Step 6: Commit**

```bash
git add src/bpcp/ src/applications/applications.module.ts
git commit -m "feat(bpcp): workflow instance client for outcome watches"
```

---

### Task 6: Start the watch at download

**Files:**
- Modify: `src/applications/applications.service.ts` (`download`)
- Test: `src/applications/outcome-watch.spec.ts`

**Interfaces:**
- Consumes: `BpcpClientService.startOutcomeWatch` (Task 5).
- Produces: `download` sets `bpcpInstanceId` when it starts a watch. No signature change.

- [x] **Step 1: Write the failing test**

Create `src/applications/outcome-watch.spec.ts`. Reuse the repository double from
`outcome-tracking.spec.ts` — copy it rather than importing across spec files, so each suite
stays readable on its own.

```typescript
import { ApplicationsService } from './applications.service';

// Fakes for the collaborators `download` actually touches; everything else stays null so an
// unexpected new call fails loudly instead of passing against a stub.
const buildDownloadService = (opts: {
  state: string;
  bpcpInstanceId: string | null;
  startOutcomeWatch: jest.Mock;
}) => {
  const stored: any = {
    id: 'app-1',
    userId: 'user-1',
    state: opts.state,
    bpcpInstanceId: opts.bpcpInstanceId,
  };
  const applications = {
    findOne: jest.fn(async () => stored),
    update: jest.fn(async (_id: string, patch: any) => Object.assign(stored, patch)),
  };
  const renders = { findOne: jest.fn(async () => ({ id: 'render-1', revisionNo: 1 })) };
  const artifacts = {
    findOne: jest.fn(async () => ({ minioKey: 'k', byteSize: 3, kind: 'pdf' })),
  };
  const storage = { getObject: jest.fn(async () => Buffer.from('pdf')) };

  // Real parameter order from applications.service.ts:62, with `bpcp` appended in Task 3.
  const service = new ApplicationsService(
    applications as any,
    renders as any,
    null as any, // jobs
    null as any, // master
    null as any, // tailor
    null as any, // entail
    null as any, // reviseService
    null as any, // chats
    artifacts as any,
    null as any, // pdf
    null as any, // docx
    storage as any,
    { startOutcomeWatch: opts.startOutcomeWatch, deliverSignal: jest.fn() } as any,
  );
  return { service, stored, applications };
};

describe('download starts the outcome watch', () => {
  it('records the instance id alongside the state change', async () => {
    const startOutcomeWatch = jest.fn(async () => 'inst-7');
    const { service, stored } = buildDownloadService({
      state: 'approved',
      bpcpInstanceId: null,
      startOutcomeWatch,
    });

    await service.download('user-1', 'app-1', 1, 'pdf');

    expect(startOutcomeWatch).toHaveBeenCalledWith('app-1', 'user-1');
    expect(stored.state).toBe('downloaded');
    expect(stored.bpcpInstanceId).toBe('inst-7');
  });

  it('does not start a second watch on a repeat download', async () => {
    const startOutcomeWatch = jest.fn(async () => 'inst-8');
    const { service } = buildDownloadService({
      state: 'downloaded',
      bpcpInstanceId: 'inst-7',
      startOutcomeWatch,
    });

    await service.download('user-1', 'app-1', 1, 'pdf');

    expect(startOutcomeWatch).not.toHaveBeenCalled();
  });

  it('still returns the file when BPCP is down, because a nudge is not worth failing a download', async () => {
    const startOutcomeWatch = jest.fn(async () => {
      throw new Error('bpcp unreachable');
    });
    const { service, stored } = buildDownloadService({
      state: 'approved',
      bpcpInstanceId: null,
      startOutcomeWatch,
    });

    const result = await service.download('user-1', 'app-1', 1, 'pdf');

    expect(result.content.toString()).toBe('pdf');
    expect(stored.state).toBe('downloaded');
    expect(stored.bpcpInstanceId).toBeNull();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx jest src/applications/outcome-watch.spec.ts`
Expected: FAIL — `startOutcomeWatch` not called.

- [x] **Step 3: Implement**

In `src/applications/applications.service.ts`, replace the final two lines of `download`:

```typescript
    const content = await this.storage.getObject(artifact.minioKey);
    await this.applications.update(applicationId, { state: 'downloaded' as ApplicationState });
    return { content, artifact };
```

with:

```typescript
    const content = await this.storage.getObject(artifact.minioKey);
    await this.applications.update(applicationId, { state: 'downloaded' as ApplicationState });

    // Spec §5: the nudge fires a day after download. Started here, once — a second download of
    // the same application must not queue a second nudge.
    if (!application.bpcpInstanceId) {
      try {
        const instanceId = await this.bpcp.startOutcomeWatch(applicationId, userId);
        if (instanceId) {
          await this.applications.update(applicationId, { bpcpInstanceId: instanceId });
        }
      } catch (cause) {
        // Fail-soft in one direction only: the user asked for their file and must get it, but a
        // missing watch means they will never be nudged, so it is logged at error level with
        // full context rather than swallowed.
        const message = cause instanceof Error ? cause.message : String(cause);
        this.logger.error(
          `failed to start the outcome watch for application ${applicationId} (user ${userId}): ${message}`,
        );
      }
    }

    return { content, artifact };
```

`download` currently discards the result of `findOwned`; change its first line to keep it:

```typescript
    const application = await this.findOwned(userId, applicationId);
```

- [x] **Step 4: Run the tests**

Run: `npx jest src/applications/outcome-watch.spec.ts`
Expected: PASS, 3 cases.

- [x] **Step 5: Commit**

```bash
git add src/applications/applications.service.ts src/applications/outcome-watch.spec.ts
git commit -m "feat(applications): start the BPCP outcome watch at download"
```

---

### Task 7: Notification client and nudge callback

**Files:**
- Create: `src/notifications/notification-client.service.ts`, `src/notifications/notification-client.service.spec.ts`, `src/notifications/nudge.controller.ts`, `src/notifications/nudge.controller.spec.ts`, `src/notifications/notifications.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `CvApplicationEntity` (Task 2, for `nudgedAt`).
- Produces:
  - `NOTIFICATIONS_FETCH = 'CV_NOTIFICATIONS_FETCH'`, `NOTIFICATIONS_SERVICE_URL = 'CV_NOTIFICATIONS_SERVICE_URL'`
  - `NotificationClientService.sendOutcomeNudge(input: {applicationId: string; recipient: string; company: string | null}): Promise<void>`
  - `NudgeController` — `POST /api/nudges/outcome`, the BPCP action callback.

The notifications contract is real, verified against
`../notifications-microservice/src/notifications/dto/send-notification.dto.ts`:
`POST /notifications/send` with `{type, recipient, message, subject?, channel?, service?, purpose?}`.
`type` must be one of the `NotificationType` enum — `custom` is the correct value here.

**BPCP calls this endpoint unauthenticated** (its `ActionDispatcherService` posts plain JSON with
no credential), so the controller must NOT be under `CvAuthGuard`. It is protected instead by a
shared secret header, and the endpoint is not in any ingress (Phase 5 has no ingress at all).

- [x] **Step 1: Write the failing test for the client**

Create `src/notifications/notification-client.service.spec.ts`:

```typescript
import { NotificationClientService } from './notification-client.service';

describe('sendOutcomeNudge', () => {
  it('posts a custom transactional notification naming the company', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }) as Response);
    const service = new NotificationClientService(fetchImpl as any, 'http://notifications:3368');

    await service.sendOutcomeNudge({
      applicationId: 'app-1',
      recipient: 'me@example.com',
      company: 'Acme',
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://notifications:3368/notifications/send');
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('custom');
    expect(body.recipient).toBe('me@example.com');
    expect(body.purpose).toBe('transactional');
    expect(body.service).toBe('cv-tuning');
    expect(body.message).toContain('Acme');
  });

  it('omits the company rather than printing a placeholder when it is unknown', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }) as Response);
    const service = new NotificationClientService(fetchImpl as any, 'http://notifications:3368');

    await service.sendOutcomeNudge({ applicationId: 'app-1', recipient: 'me@example.com', company: null });

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.message).not.toMatch(/null|undefined/);
    expect(body.message).toContain('your application');
  });

  it('raises with status and body on failure so a dropped nudge is never silent', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 502, text: async () => 'bad gateway' }) as Response);
    const service = new NotificationClientService(fetchImpl as any, 'http://notifications:3368');

    await expect(
      service.sendOutcomeNudge({ applicationId: 'app-1', recipient: 'me@example.com', company: 'Acme' }),
    ).rejects.toThrow(/502.*bad gateway/s);
  });

  it('raises when no notifications url is configured, because a nudge was genuinely requested', async () => {
    const service = new NotificationClientService(jest.fn() as any, undefined);

    await expect(
      service.sendOutcomeNudge({ applicationId: 'app-1', recipient: 'me@example.com', company: null }),
    ).rejects.toThrow(/CV_NOTIFICATIONS_SERVICE_URL/);
  });
});
```

Note the deliberate asymmetry with `BpcpClientService`: an unset BPCP url means "this deployment
has no workflow plane", which is a valid configuration; an unset notifications url reached at the
moment a nudge is due means the nudge is being dropped, which is not.

- [x] **Step 2: Run to verify it fails**

Run: `npx jest src/notifications/notification-client.service.spec.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement the client**

Create `src/notifications/notification-client.service.ts`:

```typescript
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

export const NOTIFICATIONS_FETCH = 'CV_NOTIFICATIONS_FETCH';
export const NOTIFICATIONS_SERVICE_URL = 'CV_NOTIFICATIONS_SERVICE_URL';

const TIMEOUT_MS = 10_000;

export interface OutcomeNudgeInput {
  applicationId: string;
  recipient: string;
  /** The employer, when the job record carries one. Null prints as nothing, never as a placeholder. */
  company: string | null;
}

@Injectable()
export class NotificationClientService {
  private readonly logger = new Logger(NotificationClientService.name);

  constructor(
    @Optional() @Inject(NOTIFICATIONS_FETCH) private readonly fetchImpl: typeof fetch = fetch,
    @Optional() @Inject(NOTIFICATIONS_SERVICE_URL) private readonly baseUrl?: string,
  ) {}

  /**
   * Spec §5: "any response?" a day after download, to keep the outcome dataset alive.
   *
   * Unlike `BpcpClientService`, a missing base url RAISES here. There it means "this deployment
   * has no workflow plane", a valid configuration. Here the nudge is already due, so an unset
   * url means a notification the product promised is being dropped.
   */
  async sendOutcomeNudge(input: OutcomeNudgeInput): Promise<void> {
    if (!this.baseUrl) {
      throw new Error(
        `${NOTIFICATIONS_SERVICE_URL} is not set; cannot send the outcome nudge for application ${input.applicationId}`,
      );
    }

    const subject = input.company
      ? `Any response from ${input.company}?`
      : 'Any response to your application?';
    const message = input.company
      ? `You downloaded a tailored CV for ${input.company} yesterday. Did you send it, and have you heard back? Recording the outcome takes a second and makes the next tailoring better.`
      : `You downloaded a tailored CV for your application yesterday. Did you send it, and have you heard back? Recording the outcome takes a second and makes the next tailoring better.`;

    const url = `${this.baseUrl}/notifications/send`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'custom',
        recipient: input.recipient,
        subject,
        message,
        purpose: 'transactional',
        service: 'cv-tuning',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`notifications ${url} failed with ${response.status}: ${text}`);
    }

    this.logger.log(`sent outcome nudge for application ${input.applicationId}`);
  }
}
```

- [x] **Step 4: Write the failing test for the callback controller**

Create `src/notifications/nudge.controller.spec.ts`:

```typescript
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { NudgeController } from './nudge.controller';

const buildController = (opts: {
  application: any;
  job?: any;
  send?: jest.Mock;
  secret?: string;
}) => {
  const applications = {
    findOne: jest.fn(async () => opts.application),
    update: jest.fn(async (_id: string, patch: any) => Object.assign(opts.application, patch)),
  };
  const jobs = { findOne: jest.fn(async () => opts.job ?? null) };
  const client = { sendOutcomeNudge: opts.send ?? jest.fn(async () => undefined) };
  const controller = new NudgeController(
    applications as any,
    jobs as any,
    client as any,
    opts.secret ?? 'shhh',
    'owner@example.com',
  );
  return { controller, applications, client };
};

describe('POST /api/nudges/outcome', () => {
  it('sends the nudge and stamps nudgedAt', async () => {
    const application = { id: 'app-1', userId: 'user-1', jobId: 'job-1', state: 'downloaded', nudgedAt: null, outcome: null };
    const { controller, client, applications } = buildController({
      application,
      job: { id: 'job-1', company: 'Acme' },
    });

    await controller.outcomeNudge('shhh', { context: { applicationId: 'app-1' } } as any);

    expect(client.sendOutcomeNudge).toHaveBeenCalledWith({
      applicationId: 'app-1',
      recipient: 'owner@example.com',
      company: 'Acme',
    });
    expect(applications.update).toHaveBeenCalledWith('app-1', { nudgedAt: expect.any(Date) });
  });

  it('rejects a caller without the shared secret', async () => {
    const { controller, client } = buildController({ application: { id: 'app-1' } });

    await expect(
      controller.outcomeNudge('wrong', { context: { applicationId: 'app-1' } } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(client.sendOutcomeNudge).not.toHaveBeenCalled();
  });

  it('does not nudge twice about one application', async () => {
    const application = { id: 'app-1', state: 'downloaded', nudgedAt: new Date(), outcome: null };
    const { controller, client } = buildController({ application });

    await controller.outcomeNudge('shhh', { context: { applicationId: 'app-1' } } as any);

    expect(client.sendOutcomeNudge).not.toHaveBeenCalled();
  });

  it('does not nudge an application whose outcome is already recorded', async () => {
    const application = { id: 'app-1', state: 'marked_sent', nudgedAt: null, outcome: 'interview' };
    const { controller, client } = buildController({ application });

    await controller.outcomeNudge('shhh', { context: { applicationId: 'app-1' } } as any);

    expect(client.sendOutcomeNudge).not.toHaveBeenCalled();
  });

  it('raises when the callback carries no applicationId', async () => {
    const { controller } = buildController({ application: null });

    await expect(controller.outcomeNudge('shhh', { context: {} } as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('raises when the application no longer exists', async () => {
    const { controller } = buildController({ application: null });

    await expect(
      controller.outcomeNudge('shhh', { context: { applicationId: 'gone' } } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('leaves nudgedAt unset when the send fails, so a retry can still deliver it', async () => {
    const application = { id: 'app-1', state: 'downloaded', nudgedAt: null, outcome: null, jobId: 'job-1' };
    const send = jest.fn(async () => {
      throw new Error('notifications down');
    });
    const { controller, applications } = buildController({ application, send });

    await expect(
      controller.outcomeNudge('shhh', { context: { applicationId: 'app-1' } } as any),
    ).rejects.toThrow(/notifications down/);
    expect(applications.update).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 5: Run to verify it fails**

Run: `npx jest src/notifications/nudge.controller.spec.ts`
Expected: FAIL — module not found.

- [x] **Step 6: Implement the controller**

Create `src/notifications/nudge.controller.ts`:

```typescript
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CvApplicationEntity } from '../applications/entities/cv-application.entity';
import { CvJobEntity } from '../jobs/entities/cv-job.entity';
import { NotificationClientService } from './notification-client.service';

export const NUDGE_CALLBACK_SECRET = 'CV_NUDGE_CALLBACK_SECRET';
export const NUDGE_RECIPIENT = 'CV_NUDGE_RECIPIENT';

/** The envelope BPCP's ActionDispatcherService posts: `{actionId, parameters, context}`. */
interface BpcpActionCallback {
  actionId?: string;
  parameters?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

/**
 * The BPCP timeout callback (spec §5). NOT under `CvAuthGuard`: BPCP's action dispatcher posts
 * plain JSON with no user credential, so a user-token guard would reject every call. It is
 * protected by a shared secret header instead, and the service has no ingress before Phase 7.
 */
@Controller('api/nudges')
export class NudgeController {
  private readonly logger = new Logger(NudgeController.name);

  constructor(
    @InjectRepository(CvApplicationEntity)
    private readonly applications: Repository<CvApplicationEntity>,
    @InjectRepository(CvJobEntity)
    private readonly jobs: Repository<CvJobEntity>,
    private readonly notifications: NotificationClientService,
    @Inject(NUDGE_CALLBACK_SECRET) private readonly secret: string,
    @Inject(NUDGE_RECIPIENT) private readonly recipient: string,
  ) {}

  @Post('outcome')
  async outcomeNudge(
    @Headers('x-cv-nudge-secret') suppliedSecret: string,
    @Body() body: BpcpActionCallback,
  ): Promise<{ nudged: boolean; reason?: string }> {
    if (!this.secret || suppliedSecret !== this.secret) {
      // Never echo the expected value; a mismatch is all the caller may learn.
      throw new ForbiddenException('invalid nudge callback secret');
    }

    const applicationId = body.context?.applicationId;
    if (typeof applicationId !== 'string' || applicationId.length === 0) {
      throw new BadRequestException('nudge callback carries no context.applicationId');
    }

    const application = await this.applications.findOne({ where: { id: applicationId } });
    if (!application) {
      // "No such application" and "the lookup failed" stay distinguishable: this is the former.
      throw new NotFoundException(`application ${applicationId} not found`);
    }

    if (application.nudgedAt) {
      this.logger.log(`application ${applicationId} was already nudged; skipping`);
      return { nudged: false, reason: 'already nudged' };
    }
    if (application.outcome) {
      this.logger.log(`application ${applicationId} already has an outcome; skipping`);
      return { nudged: false, reason: 'outcome already recorded' };
    }

    const job = application.jobId
      ? await this.jobs.findOne({ where: { id: application.jobId } })
      : null;

    // The send comes BEFORE the stamp on purpose: stamping first would mark a nudge delivered
    // that never left the building, and the user would never be asked again.
    await this.notifications.sendOutcomeNudge({
      applicationId,
      recipient: this.recipient,
      company: job?.company ?? null,
    });

    await this.applications.update(applicationId, { nudgedAt: new Date() });
    return { nudged: true };
  }
}
```

Before writing this, confirm the job entity's class name and its `company` column:

```bash
rtk rg -n "class Cv.*Entity|company" src/jobs/entities/*.ts
```

Adjust the import and the `company` read if the names differ.

- [x] **Step 7: Wire the module**

Create `src/notifications/notifications.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CvApplicationEntity } from '../applications/entities/cv-application.entity';
import { CvJobEntity } from '../jobs/entities/cv-job.entity';
import {
  NotificationClientService,
  NOTIFICATIONS_SERVICE_URL,
} from './notification-client.service';
import { NudgeController, NUDGE_CALLBACK_SECRET, NUDGE_RECIPIENT } from './nudge.controller';

@Module({
  imports: [TypeOrmModule.forFeature([CvApplicationEntity, CvJobEntity])],
  controllers: [NudgeController],
  providers: [
    NotificationClientService,
    { provide: NOTIFICATIONS_SERVICE_URL, useFactory: () => process.env.CV_NOTIFICATIONS_SERVICE_URL },
    { provide: NUDGE_CALLBACK_SECRET, useFactory: () => process.env.CV_NUDGE_CALLBACK_SECRET ?? '' },
    { provide: NUDGE_RECIPIENT, useFactory: () => process.env.CV_NUDGE_RECIPIENT ?? '' },
  ],
  exports: [NotificationClientService],
})
export class NotificationsModule {}
```

Add `NotificationsModule` and `BpcpModule` to `src/app.module.ts` imports.

- [x] **Step 8: Run the tests**

Run: `npx jest src/notifications/`
Expected: PASS, 11 cases.

- [x] **Step 9: Confirm the secret check is load-bearing**

Temporarily change the guard to `if (false)`, re-run, confirm "rejects a caller without the
shared secret" fails. Revert.

- [x] **Step 10: Commit**

```bash
git add src/notifications/ src/app.module.ts
git commit -m "feat(notifications): outcome nudge client and BPCP callback"
```

---

### Task 8: The BPCP workflow definition

**Files:**
- Create: `docs/workflows/cv-application-outcome.workflow.json`
- Test: `src/bpcp/workflow-definition.spec.ts`

**Interfaces:**
- Consumes: `OUTCOME_WORKFLOW_ID`, `OUTCOME_WORKFLOW_VERSION` (Task 5).
- Produces: the JSON document registered with BPCP via `POST /api/processes` /
  `POST /api/workflows` (confirm which registry accepts `bpcp.workflow.v1` — see step 3).

The shape is BPCP's real `WorkflowDefinition`, verified against
`../business-process-control-plane/src/workflows/workflow.types.ts`. The wait action's parameters
are read by `readWaitParameters`: `signalName`, `timeoutMs`, `onTimeout`.

- [x] **Step 1: Write the failing test**

Create `src/bpcp/workflow-definition.spec.ts`:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { OUTCOME_WORKFLOW_ID, OUTCOME_WORKFLOW_VERSION } from './bpcp-client.service';

const definition = JSON.parse(
  readFileSync(join(__dirname, '../../docs/workflows/cv-application-outcome.workflow.json'), 'utf8'),
);

describe('cv-application-outcome workflow', () => {
  it('matches the id and version the client starts', () => {
    expect(definition.workflowId).toBe(OUTCOME_WORKFLOW_ID);
    expect(definition.version).toBe(OUTCOME_WORKFLOW_VERSION);
    expect(definition.schemaVersion).toBe('bpcp.workflow.v1');
  });

  it('waits one day for the sent signal and CONTINUES on timeout', () => {
    const wait = definition.actions.find((a: any) => a.type === 'wait-for-signal');
    expect(wait.parameters.signalName).toBe('sent');
    expect(wait.parameters.timeoutMs).toBe(86_400_000);
    // 'fail' would mark the instance failed and never dispatch the nudge action, which is the
    // entire point of the timer.
    expect(wait.parameters.onTimeout).toBe('continue');
  });

  it('dispatches the nudge action after the wait, not in parallel with it', () => {
    const wait = definition.actions.find((a: any) => a.type === 'wait-for-signal');
    const nudge = definition.actions.find((a: any) => a.actionId === 'send-outcome-nudge');
    expect(nudge.dependsOn).toContain(wait.actionId);
    expect(typeof nudge.parameters.url).toBe('string');
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx jest src/bpcp/workflow-definition.spec.ts`
Expected: FAIL — ENOENT on the workflow file.

- [x] **Step 3: Write the definition**

Create `docs/workflows/cv-application-outcome.workflow.json`:

```json
{
  "schemaVersion": "bpcp.workflow.v1",
  "workflowId": "cv-application-outcome",
  "version": 1,
  "status": "active",
  "description": "Waits a day after a tailored CV is downloaded; if the user has not asserted they sent it, nudges them so the outcome dataset stays alive (cv-tuning spec 5).",
  "appliesToProcessRefs": [],
  "trigger": {
    "type": "cv-application-downloaded",
    "sourceService": "cv-tuning",
    "eventRef": "cv.application.downloaded",
    "correlationKeys": ["applicationId"]
  },
  "actions": [
    {
      "actionId": "await-sent",
      "type": "wait-for-signal",
      "serviceCapabilityRefs": [],
      "parameters": {
        "signalName": "sent",
        "timeoutMs": 86400000,
        "onTimeout": "continue"
      }
    },
    {
      "actionId": "send-outcome-nudge",
      "type": "call-service-capability",
      "dependsOn": ["await-sent"],
      "serviceCapabilityRefs": [],
      "parameters": {
        "url": "http://cv-tuning:3379/api/nudges/outcome"
      }
    }
  ],
  "requiredCapabilities": [],
  "missingRuntimeFacts": [],
  "createdAt": "2026-08-24T00:00:00.000Z",
  "updatedAt": "2026-08-24T00:00:00.000Z"
}
```

Note: BPCP's `ActionDispatcherService` posts `{actionId, parameters, context}` and reads the
`url` parameter — it sends no custom headers today. The shared-secret header the nudge controller
requires therefore needs one of:

**(a)** BPCP's dispatcher extended to forward a `headers` parameter, or
**(b)** the secret carried as a query string on the `url`.

Prefer **(a)**: it is a small, general improvement to BPCP and keeps the secret out of URLs and
access logs. Implement it in the BPCP repo as its own commit before finishing this task, and
adjust the `url` parameter here to add `"headers": {"x-cv-nudge-secret": "..."}` — sourced from a
BPCP-side env reference, never a literal in this JSON. If BPCP's dispatcher cannot be changed in
this phase, take **(b)** and record it as a trap in `STATE.json`, since a secret in a URL is
weaker and must not survive into Phase 7.

- [x] **Step 4: Run the tests**

Run: `npx jest src/bpcp/workflow-definition.spec.ts`
Expected: PASS, 3 cases.

- [x] **Step 5: Register the workflow with BPCP**

BPCP is a separate service and is **not** deployed by this plan. Register the definition against
the running instance and confirm it round-trips:

```bash
rtk curl -sS -X POST http://localhost:3375/api/processes \
  -H 'content-type: application/json' \
  --data @docs/workflows/cv-application-outcome.workflow.json | head -40
```

If that registry rejects a `bpcp.workflow.v1` document, use the workflow registry instead
(`src/workflows/workflow-registry.controller.ts` — read it for the exact route) and record the
correct command in `STATE.json`. Confirm with:

```bash
rtk curl -sS http://localhost:3375/api/workflows | head -20
```

- [x] **Step 6: Commit**

```bash
git add docs/workflows/cv-application-outcome.workflow.json src/bpcp/workflow-definition.spec.ts
git commit -m "feat(bpcp): cv-application-outcome workflow definition"
```

---

### Task 9: Dashboard aggregation

**Files:**
- Create: `src/dashboard/dashboard.service.ts`, `src/dashboard/dashboard.service.spec.ts`, `src/dashboard/dashboard.controller.ts`, `src/dashboard/dashboard.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `CvApplicationEntity` (Task 2), `OUTCOMES`, `APPLICATION_STATES`.
- Produces:
  - `DashboardService.summary(userId: string): Promise<DashboardSummary>`
  - `interface DashboardSummary { total: number; byState: Record<ApplicationState, number>; byOutcome: Record<Outcome, number>; funnel: {generated: number; approved: number; downloaded: number; sent: number; replied: number}; interviewRate: number | null; medianReplyDays: number | null }`

`interviewRate` is `null`, never `0`, when nothing has been sent — a rate over zero submissions is
undefined, and reporting `0%` would tell the user their CV is failing when they simply have not
sent one yet.

- [x] **Step 1: Write the failing test**

Create `src/dashboard/dashboard.service.spec.ts`:

```typescript
import { DashboardService } from './dashboard.service';

/** A query-builder double returning canned grouped rows, matching TypeORM's fluent shape. */
const makeRepo = (stateRows: any[], outcomeRows: any[], replyRows: any[]) => {
  const builders = [stateRows, outcomeRows, replyRows];
  let call = 0;
  return {
    createQueryBuilder: jest.fn(() => {
      const rows = builders[call++];
      const builder: any = {
        select: jest.fn(() => builder),
        addSelect: jest.fn(() => builder),
        where: jest.fn(() => builder),
        andWhere: jest.fn(() => builder),
        groupBy: jest.fn(() => builder),
        getRawMany: jest.fn(async () => rows),
      };
      return builder;
    }),
  };
};

describe('summary', () => {
  it('builds the funnel from grouped state counts', async () => {
    const repo = makeRepo(
      [
        { state: 'in_review', count: '3' },
        { state: 'approved', count: '2' },
        { state: 'downloaded', count: '4' },
        { state: 'marked_sent', count: '5' },
      ],
      [{ outcome: 'interview', count: '2' }, { outcome: 'rejected', count: '1' }],
      [],
    );
    const service = new DashboardService(repo as any);

    const summary = await service.summary('user-1');

    expect(summary.total).toBe(14);
    expect(summary.byState.downloaded).toBe(4);
    // The funnel is cumulative: an application sitting in marked_sent was necessarily
    // downloaded and approved on its way there, so each stage counts everything at or past it.
    expect(summary.funnel.approved).toBe(11);
    expect(summary.funnel.downloaded).toBe(9);
    expect(summary.funnel.sent).toBe(5);
  });

  it('reports every state and outcome key, so a zero renders as 0 rather than a hole', async () => {
    const repo = makeRepo([{ state: 'approved', count: '1' }], [], []);
    const service = new DashboardService(repo as any);

    const summary = await service.summary('user-1');

    expect(summary.byState.marked_sent).toBe(0);
    expect(summary.byOutcome.ghosted).toBe(0);
    expect(summary.byOutcome.offer).toBe(0);
  });

  it('returns a null interview rate when nothing has been sent, never zero', async () => {
    const repo = makeRepo([{ state: 'in_review', count: '2' }], [], []);
    const service = new DashboardService(repo as any);

    const summary = await service.summary('user-1');

    // 0% would read as "your CV is failing"; the honest answer is "no data yet".
    expect(summary.interviewRate).toBeNull();
  });

  it('computes the interview rate over sent applications', async () => {
    const repo = makeRepo(
      [{ state: 'marked_sent', count: '10' }],
      [{ outcome: 'interview', count: '3' }],
      [],
    );
    const service = new DashboardService(repo as any);

    const summary = await service.summary('user-1');

    expect(summary.interviewRate).toBeCloseTo(0.3);
  });

  it('counts an offer as an interview-or-better in the rate', async () => {
    const repo = makeRepo(
      [{ state: 'marked_sent', count: '10' }],
      [{ outcome: 'interview', count: '2' }, { outcome: 'offer', count: '1' }],
      [],
    );
    const service = new DashboardService(repo as any);

    // An offer necessarily passed the interview stage; excluding it would under-report success.
    expect((await service.summary('user-1')).interviewRate).toBeCloseTo(0.3);
  });

  it('reports the median reply time in days, null when nothing has replied', async () => {
    const empty = makeRepo([{ state: 'marked_sent', count: '1' }], [], []);
    expect((await new DashboardService(empty as any).summary('user-1')).medianReplyDays).toBeNull();

    const withReplies = makeRepo(
      [{ state: 'marked_sent', count: '3' }],
      [{ outcome: 'interview', count: '3' }],
      [{ days: '2' }, { days: '6' }, { days: '10' }],
    );
    expect((await new DashboardService(withReplies as any).summary('user-1')).medianReplyDays).toBe(6);
  });

  it('takes the mean of the middle two on an even count', async () => {
    const repo = makeRepo(
      [{ state: 'marked_sent', count: '4' }],
      [{ outcome: 'interview', count: '4' }],
      [{ days: '2' }, { days: '4' }, { days: '6' }, { days: '12' }],
    );
    expect((await new DashboardService(repo as any).summary('user-1')).medianReplyDays).toBe(5);
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx jest src/dashboard/dashboard.service.spec.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement the service**

Create `src/dashboard/dashboard.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  APPLICATION_STATES,
  ApplicationState,
  Outcome,
  OUTCOMES,
} from '../applications/application.types';
import { CvApplicationEntity } from '../applications/entities/cv-application.entity';

export interface DashboardFunnel {
  generated: number;
  approved: number;
  downloaded: number;
  sent: number;
  replied: number;
}

export interface DashboardSummary {
  total: number;
  byState: Record<ApplicationState, number>;
  byOutcome: Record<Outcome, number>;
  funnel: DashboardFunnel;
  /** Interviews-or-better over sent applications. Null when nothing has been sent. */
  interviewRate: number | null;
  /** Median days from send to recorded outcome. Null when nothing has replied. */
  medianReplyDays: number | null;
}

/**
 * The funnel is CUMULATIVE: an application in `marked_sent` was necessarily downloaded and
 * approved on the way there, so each stage counts everything at or past it. Reporting the raw
 * per-state counts as a funnel would show a "downloaded" bar that shrinks as users progress.
 */
const AT_OR_PAST: Record<keyof DashboardFunnel, readonly ApplicationState[]> = {
  generated: APPLICATION_STATES,
  approved: ['approved', 'downloaded', 'marked_sent'],
  downloaded: ['downloaded', 'marked_sent'],
  sent: ['marked_sent'],
  replied: [],
};

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @InjectRepository(CvApplicationEntity)
    private readonly applications: Repository<CvApplicationEntity>,
  ) {}

  async summary(userId: string): Promise<DashboardSummary> {
    // Aggregated in SQL, not in JS: loading every row to count them would grow linearly with
    // the user's history for a number Postgres produces in one pass.
    const stateRows = await this.applications
      .createQueryBuilder('app')
      .select('app.state', 'state')
      .addSelect('COUNT(*)', 'count')
      .where('app."userId" = :userId', { userId })
      .groupBy('app.state')
      .getRawMany<{ state: ApplicationState; count: string }>();

    const outcomeRows = await this.applications
      .createQueryBuilder('app')
      .select('app.outcome', 'outcome')
      .addSelect('COUNT(*)', 'count')
      .where('app."userId" = :userId', { userId })
      .andWhere('app.outcome IS NOT NULL')
      .groupBy('app.outcome')
      .getRawMany<{ outcome: Outcome; count: string }>();

    const replyRows = await this.applications
      .createQueryBuilder('app')
      .select('EXTRACT(EPOCH FROM (app."outcomeAt" - app."sentAt")) / 86400', 'days')
      .where('app."userId" = :userId', { userId })
      .andWhere('app."sentAt" IS NOT NULL')
      .andWhere('app."outcomeAt" IS NOT NULL')
      .getRawMany<{ days: string }>();

    // Every key present with an explicit 0: a missing key renders as a hole in a UI, while 0 is
    // a real and useful answer.
    const byState = Object.fromEntries(
      APPLICATION_STATES.map((state) => [state, 0]),
    ) as Record<ApplicationState, number>;
    for (const row of stateRows) {
      byState[row.state] = Number(row.count);
    }

    const byOutcome = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
    for (const row of outcomeRows) {
      byOutcome[row.outcome] = Number(row.count);
    }

    const total = Object.values(byState).reduce((sum, n) => sum + n, 0);
    const sumOf = (states: readonly ApplicationState[]): number =>
      states.reduce((sum, state) => sum + byState[state], 0);

    const replied = Object.values(byOutcome).reduce((sum, n) => sum + n, 0);
    const funnel: DashboardFunnel = {
      generated: total,
      approved: sumOf(AT_OR_PAST.approved),
      downloaded: sumOf(AT_OR_PAST.downloaded),
      sent: sumOf(AT_OR_PAST.sent),
      replied,
    };

    // An offer necessarily passed the interview stage; excluding it would under-report success.
    const interviews = byOutcome.interview + byOutcome.offer;
    const interviewRate = funnel.sent > 0 ? interviews / funnel.sent : null;

    return {
      total,
      byState,
      byOutcome,
      funnel,
      interviewRate,
      medianReplyDays: this.median(replyRows.map((r) => Number(r.days))),
    };
  }

  /** Median, not mean: one application answered after six months would drag a mean into fiction. */
  private median(values: number[]): number | null {
    if (values.length === 0) {
      return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
}
```

- [x] **Step 4: Add the controller and module**

Create `src/dashboard/dashboard.controller.ts`:

```typescript
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { CvAuthGuard, CvUser } from '../auth/cv-auth.guard';
import { DashboardService } from './dashboard.service';

@Controller('api/dashboard')
@UseGuards(CvAuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  async summary(@Req() req: { user: CvUser }) {
    // The user id always comes from the validated token; there is no path to another user's funnel.
    return this.dashboard.summary(req.user.id);
  }
}
```

Create `src/dashboard/dashboard.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CvApplicationEntity } from '../applications/entities/cv-application.entity';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [TypeOrmModule.forFeature([CvApplicationEntity])],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
```

Add `DashboardModule` to `src/app.module.ts` imports.

- [x] **Step 5: Run the tests**

Run: `npx jest src/dashboard/`
Expected: PASS, 7 cases.

- [x] **Step 6: Confirm the null-rate rule is load-bearing**

Temporarily change `interviewRate` to `interviews / funnel.sent` unconditionally, re-run, and
confirm "returns a null interview rate when nothing has been sent" fails with `NaN`. Revert.

- [x] **Step 7: Commit**

```bash
git add src/dashboard/ src/app.module.ts
git commit -m "feat(dashboard): funnel and outcome aggregation endpoint"
```

---

### Task 10: Full gate, config, and documentation

**Files:**
- Modify: `k8s/configmap.yaml`, `STATE.json`, `CLAUDE.md`, `README.md`

- [x] **Step 1: Run the full gate**

Run: `npm test`
Expected: PASS. Suites 36 → ~43, cases 458 → ~505, **skipped still exactly 11**. A higher skip
count is a regression — investigate before continuing.

- [x] **Step 2: Add the config keys**

In `k8s/configmap.yaml`, add:

```yaml
  CV_BPCP_SERVICE_URL: "http://bpcp:3375"
  CV_NOTIFICATIONS_SERVICE_URL: "http://notifications-microservice:3368"
  CV_NUDGE_RECIPIENT: "ssfskype@gmail.com"
```

Confirm the two in-cluster service names first — a wrong hostname makes every nudge fail at
runtime while the tests stay green:

```bash
rtk kubectl get svc -A | rtk rg -E 'bpcp|notification'
```

`CV_NUDGE_CALLBACK_SECRET` is a **secret, not a ConfigMap value**. Write it to Vault and let ESO
carry it:

```bash
/vault-secret cv-tuning set CV_NUDGE_CALLBACK_SECRET=<generated>
```

Then add the key to `k8s/external-secret.yaml` alongside the existing entries.

- [x] **Step 3: Update STATE.json**

Set `phases.5.status` to `"done"` and `phases.6.status` to `"next"`. Update `tests` to the counts
`npm test` actually printed in step 1 — never to the estimate above. Add to `traps`:

```
"The nudge callback POST /api/nudges/outcome is NOT under CvAuthGuard: BPCP's ActionDispatcherService posts plain JSON with no user credential, so a user-token guard would reject every call. It is protected by the x-cv-nudge-secret shared-secret header (CV_NUDGE_CALLBACK_SECRET, from Vault) and by the service having no ingress before Phase 7. Never 'fix' it by adding CvAuthGuard — that silently disables every nudge, and the failure appears only as instances stuck in BPCP.",
"The outcome nudge sends BEFORE stamping nudgedAt, deliberately. Stamping first would mark a nudge delivered that never left the building and the user would never be asked again; sending first means a crash between the two can at worst nudge twice. Duplicate nudges are recoverable, a silently-lost one is not.",
"BpcpClientService returns null for a missing base url; NotificationClientService RAISES for one. Not an inconsistency: an unset BPCP url means 'this deployment has no workflow plane', a valid configuration, while an unset notifications url is only ever reached when a nudge is already due, so it means a promised notification is being dropped.",
"The dashboard funnel is CUMULATIVE (each stage counts everything at or past it) and interviewRate is null, never 0, when nothing has been sent. A 0% rate over zero submissions reads to the user as 'your CV is failing' when the honest answer is 'no data yet'."
```

Update the superseded `openItems` entry about Phase 5 if one exists.

- [x] **Step 4: Update CLAUDE.md**

Add a `**dashboard/**`, `**bpcp/**`, and `**notifications/**` paragraph to the Architecture
section, in the same voice as the existing module paragraphs — each stating the constraint that
explains why the code looks the way it does, not what the code does.

- [x] **Step 5: Run the gate again after the doc edits**

Run: `npm test`
Expected: PASS, same counts as step 1.

- [x] **Step 6: Commit**

```bash
git add k8s/ STATE.json CLAUDE.md README.md
git commit -m "feat(cv-tuning): phase 5 config, state and docs"
```

- [x] **Step 7: Verify the deploy**

Committing to `main` queues the deploy automatically. Do not run `deploy.sh`.

```bash
../shared/scripts/deploy-queue/queuectl.sh status
rtk kubectl get pods -n statex-apps | rtk rg cv-tuning
```

Then probe the new endpoint from inside the pod, **via its podIP, not localhost** (the app does
not bind loopback — recorded trap):

```bash
POD=$(rtk kubectl get pod -n statex-apps -l app=cv-tuning -o jsonpath='{.items[0].metadata.name}')
IP=$(rtk kubectl get pod -n statex-apps $POD -o jsonpath='{.status.podIP}')
rtk kubectl exec -n statex-apps $POD -- curl -sS -o /dev/null -w '%{http_code}\n' http://$IP:3379/api/dashboard
```

Expected: `401` — the guard rejecting an unauthenticated call proves the route is mounted. A
`404` means the module was not wired into `app.module.ts`.

---

## Self-Review

**Spec coverage.** Spec §5's tail — `downloaded → marked_sent → outcome` — is Tasks 1, 3, 4.
"`marked_sent` is user-asserted, rendered distinctly" is carried by its own `sentAt` column
(Task 2) and the state value itself. "notifications-microservice nudges a day after download" is
Tasks 5–8. "`in_review` and `marked_sent` are the BPCP wait-for-signal states" is partly covered:
this plan wires the `marked_sent` watch. **`in_review` is not wired to BPCP by this plan** — the
approval gate already implements that wait in-process, and moving it to BPCP is a refactor with
no user-visible change, so it is left out deliberately rather than missed. §12 row 5's "Dashboard"
is Task 9. The `smart` tier in that row is unused because Phase 5 needs no LLM call — noted in
Global Constraints so it does not read as an omission.

**Placeholders.** None: every code step carries the real body, and the two places with genuine
environmental uncertainty (BPCP's registry route in Task 8 step 5, BPCP's header forwarding in
Task 8 step 3) name the exact command to resolve them and the decision to record either way.

**Type consistency.** `startOutcomeWatch(applicationId, userId)` and
`deliverSignal(instanceId, name, payload)` are used with those exact signatures in Tasks 3, 5, 6.
`DashboardSummary` fields in the Task 9 tests match the interface. `MARK_SENT_FROM`,
`assertCanMarkSent`, `assertCanRecordOutcome` are consistent across Tasks 1 and 3. The
`ApplicationsService` constructor today takes 12 parameters in the order
`applications, renders, jobs, master, tailor, entail, reviseService, chats, artifacts, pdf, docx, storage`
(verified at `applications.service.ts:62`); Task 3 appends `bpcp` as the 13th, and both new spec
files pass their fakes in exactly that order. If a task ahead of you has already changed the
order, fix the fakes to match the real constructor rather than reordering the constructor to
match the plan.
