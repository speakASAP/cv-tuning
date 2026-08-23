# cv-tuning Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `cv-tuning` with authentication, and let a user import a master CV and edit it as Markdown, with a fact graph derived from that Markdown and drift made detectable.

**Architecture:** NestJS service on port 3379 behind central auth. Markdown is the user-facing source of truth; the fact graph is a derived, versioned projection re-extracted on every save, with fact IDs matched by content hash so unchanged bullets keep their identity. A stored SHA of the Markdown the facts came from makes divergence raise instead of degrade.

**Tech Stack:** NestJS 10, TypeORM 0.3.17, pg 8.11.3, Jest 29 (ts-jest), Node 20+.

**Spec:** `docs/specs/2026-08-22-cv-tailoring-platform-design.md`

## Global Constraints

- **Port 3379.** 3378 is `logging-microservice`'s frontend — never reuse it.
- **Free models only** in Phases 1–6: `cheap` for parsing and extraction, `smart` for generation. `free` is a 0.5B *code* model and must never be used for prose. Premium is Phase 9.
- **All LLM calls go through `ai-microservice` (3380).** No service calls a provider directly, ever.
- **Record the served model, not the requested tier.** `cv_render.model_used` comes from `model_used` in the ai-microservice response. A mismatch against the requested tier marks the render `degraded`.
- **Dependency versions must match the house standard:** `@nestjs/typeorm ^10.0.0`, `typeorm ^0.3.17`, `pg ^8.11.3`.
- **No silent failures:** every catch re-throws or logs at error level with full context. "Not found" (404) and "lookup failed" (500) must be distinguishable. Never return an empty result in place of an error.
- **`synchronize: false`** everywhere. Migrations generated offline, applied to a scratch DB first. Never `prisma migrate dev` or its TypeORM equivalent against production.
- **New Vault keys must be named in `k8s/external-secret.yaml`** or they never reach pods while ESO reports `Synced`.
- **GDPR gate:** no third-party user may access this service before Phase 7 completes. Phases 1–6 run on the owner's own CV data only.
- **Never `npx tsc`** — use `./node_modules/.bin/tsc` or `npm run build`.
- Prefix shell commands with `rtk`; `rg` is a GNU grep shim, so use `-E`.

## File Structure

**Create:**
- `src/main.ts`, `src/app.module.ts`, `src/health/health.controller.ts`
- `src/database/database.module.ts`, `src/database/migrations/*`
- `src/auth/cv-auth.guard.ts` — copied from `catalog-microservice/src/auth/catalog-auth.guard.ts`
- `src/master/entities/cv-profile.entity.ts`, `cv-master.entity.ts`, `cv-fact.entity.ts`
- `src/master/fact-extractor.service.ts` — Markdown → facts, the core of this phase
- `src/master/fact-identity.ts` — content-hash ID matching
- `src/master/master-cv.service.ts` — save/read, drift detection
- `src/master/master-cv.controller.ts`, `src/master/dto/*`
- `src/master/master.module.ts`
- `src/ai/ai-client.service.ts` — the only path to ai-microservice
- Specs beside each service

Boundaries: `fact-extractor` turns text into facts and knows nothing about storage; `fact-identity` is pure functions over hashes; `master-cv.service` owns persistence and the drift rule. Keeping identity matching pure makes the trickiest logic in this phase testable without a database.

---

### Task 1: Service scaffold, health, and deployment shell

**Files:**
- Create: `package.json`, `tsconfig.json`, `nest-cli.json`, `Dockerfile`, `deploy.config.sh`, `.env.example`
- Create: `src/main.ts`, `src/app.module.ts`, `src/health/health.controller.ts`, `src/health/health.module.ts`
- Create: `k8s/configmap.yaml`, `k8s/external-secret.yaml`, `k8s/deployment.yaml`, `k8s/service.yaml`
- Create: `scripts/deploy.sh`

**Interfaces:**
- Consumes: nothing
- Produces: a service listening on 3379 with `GET /health` returning `{ status: 'ok', service: 'cv-tuning' }`

- [ ] **Step 1: Scaffold from the ecosystem standard**

Use the registration skill rather than hand-rolling — it assigns config, manifests, Vault paths, and agent docs consistently.

```bash
cd /home/ssf/Documents/Github/cv-tuning
/register-new-app cv-tuning 3379
```

If the skill cannot run, copy the shape of `catalog-microservice` (`package.json`, `tsconfig.json`, `nest-cli.json`, `Dockerfile`, `k8s/`, `scripts/deploy.sh`), replacing name and port throughout.

- [ ] **Step 2: Write the failing health test**

Create `src/health/health.controller.spec.ts`:

```ts
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports the service name and status', () => {
    expect(new HealthController().check()).toEqual({ status: 'ok', service: 'cv-tuning' });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
./node_modules/.bin/jest src/health/health.controller.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `src/health/health.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string; service: string } {
    return { status: 'ok', service: 'cv-tuning' };
  }
}
```

Create `src/health/health.module.ts` exporting it, and `src/main.ts` listening on `process.env.PORT ?? 3379` with `app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))`.

- [ ] **Step 5: Run to verify it passes and the service boots**

```bash
./node_modules/.bin/jest src/health/health.controller.spec.ts
npm run build && npm run start:prod &
sleep 3 && curl -sS localhost:3379/health && kill %1
```

Expected: test PASS; curl returns the JSON above.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold cv-tuning on port 3379"
```

---

### Task 2: Auth guard

**Files:**
- Create: `src/auth/cv-auth.guard.ts`, `src/auth/cv-auth.guard.spec.ts`, `src/auth/auth.module.ts`
- Reference: `catalog-microservice/src/auth/catalog-auth.guard.ts` (and its `.spec.ts`)

**Interfaces:**
- Consumes: `AUTH_SERVICE_URL`
- Produces: `CvAuthGuard`; `request.user = { id: string; email: string }`

- [ ] **Step 1: Read the existing pattern before writing anything**

```bash
rtk cat ../catalog-microservice/src/auth/catalog-auth.guard.ts
rtk cat ../catalog-microservice/src/auth/catalog-auth.guard.spec.ts
```

Follow it. Do not invent a different validation shape.

- [ ] **Step 2: Write the failing tests**

Create `src/auth/cv-auth.guard.spec.ts`:

```ts
import { UnauthorizedException } from '@nestjs/common';
import { CvAuthGuard } from './cv-auth.guard';

const contextWith = (headers: Record<string, string>) => {
  const request: Record<string, unknown> = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    __request: request,
  } as never;
};

describe('CvAuthGuard', () => {
  let fetchMock: jest.Mock;
  let guard: CvAuthGuard;

  beforeEach(() => {
    fetchMock = jest.fn();
    guard = new CvAuthGuard('http://auth-microservice:3370', fetchMock as unknown as typeof fetch);
  });

  it('rejects a request with no Authorization header', async () => {
    await expect(guard.canActivate(contextWith({}))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an invalid token', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'nope' });
    await expect(guard.canActivate(contextWith({ authorization: 'Bearer bad' }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches the user on a valid token', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'u1', email: 'a@b.c' }) });
    const ctx = contextWith({ authorization: 'Bearer good' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect((ctx as never as { __request: { user: unknown } }).__request.user).toEqual({ id: 'u1', email: 'a@b.c' });
  });

  it('raises rather than denying silently when auth is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    // An outage must not look like a rejected credential.
    await expect(guard.canActivate(contextWith({ authorization: 'Bearer good' }))).rejects.toThrow(/auth-microservice/);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

```bash
./node_modules/.bin/jest src/auth/cv-auth.guard.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement, following the catalog pattern**

Create `src/auth/cv-auth.guard.ts`. Key requirement beyond the copied pattern: a transport error must throw a `ServiceUnavailableException` mentioning `auth-microservice`, **not** an `UnauthorizedException` — an outage is not a bad credential, and conflating them hides the outage.

- [ ] **Step 5: Run to verify they pass**

```bash
./node_modules/.bin/jest src/auth/cv-auth.guard.spec.ts
```

Expected: PASS, all four.

- [ ] **Step 6: Commit**

```bash
git add src/auth
git commit -m "feat: JWT auth guard against auth-microservice"
```

---

### Task 3: Database module and master CV tables

**Files:**
- Create: `src/database/database.module.ts`, `src/database/migrations/1756100000000-CreateMasterTables.ts`
- Create: `src/master/entities/cv-profile.entity.ts`, `cv-master.entity.ts`, `cv-fact.entity.ts`
- Modify: `src/app.module.ts`, `.env.example`

**Interfaces:**
- Consumes: nothing
- Produces: `CvProfileEntity`, `CvMasterEntity`, `CvFactEntity`; `FactKind = 'role' | 'achievement' | 'skill' | 'education' | 'certification' | 'proof'`

- [ ] **Step 1: Install dependencies**

```bash
npm install --save @nestjs/typeorm@^10.0.0 typeorm@^0.3.17 pg@^8.11.3
```

- [ ] **Step 2: Write the entities**

`cv-master.entity.ts` carries the drift detector. Columns per spec §4:

```ts
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('cv_master')
export class CvMasterEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_master_user')
  @Column({ type: 'text' })
  userId!: string;

  @Column({ type: 'int' })
  version!: number;

  @Column({ type: 'text' })
  sourceType!: 'paste' | 'upload' | 'gdocs' | 'linkedin';

  @Column({ type: 'text', nullable: true })
  sourceRef!: string | null;

  /** SOURCE OF TRUTH. Facts are derived from this. */
  @Column({ type: 'text' })
  markdown!: string;

  /** SHA-256 of the markdown the current facts were extracted from. */
  @Column({ type: 'text' })
  factsExtractedFromMarkdownSha!: string;

  @Column({ type: 'bool', default: false })
  isCurrent!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
```

`cv-fact.entity.ts` needs `contentHash` and `position` — they are what keep fact IDs stable across edits:

```ts
@Entity('cv_fact')
export class CvFactEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_fact_master')
  @Column({ type: 'uuid' })
  masterId!: string;

  @Column({ type: 'text' })
  kind!: FactKind;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  metric!: string | null;

  @Column({ type: 'text' })
  contentHash!: string;

  @Column({ type: 'int' })
  position!: number;
}
```

`cv-profile.entity.ts` includes the Phase 7 columns now so GDPR is a behaviour change, not a migration: `userId` (pk), `locale`, `consentVersion` (nullable), `consentAt` (nullable), `createdAt`.

- [ ] **Step 3: Write the migration and database module**

Mirror the BPCP executor plan's Task 1: raw SQL migration, `synchronize: false`, `migrationsRun: true`, and a hard throw when `CV_DATABASE_URL` is unset — a missing DSN must never degrade to an in-memory store.

- [ ] **Step 4: Verify the build**

```bash
npm run build
```

Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/database src/master/entities .env.example src/app.module.ts
git commit -m "feat: master CV schema with markdown-sha drift detector"
```

---

### Task 4: Fact identity — stable IDs across edits

Pure functions, no I/O. This is the subtlest logic in the phase, so it is isolated and tested on its own.

**Files:**
- Create: `src/master/fact-identity.ts`, `src/master/fact-identity.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `hashFactContent(text: string): string`, `matchFactIds(previous: StoredFact[], extracted: ExtractedFact[]): MatchedFact[]` where `MatchedFact = ExtractedFact & { id: string; isNew: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `src/master/fact-identity.spec.ts`:

```ts
import { hashFactContent, matchFactIds } from './fact-identity';

const stored = (id: string, text: string, position: number) => ({ id, contentHash: hashFactContent(text), position });
const extracted = (text: string, position: number) => ({ text, position, kind: 'achievement' as const, payload: {}, metric: null });

describe('fact identity', () => {
  it('hashes content stably regardless of surrounding whitespace', () => {
    expect(hashFactContent('  Cut churn 23%  ')).toBe(hashFactContent('Cut churn 23%'));
  });

  it('keeps the id of an unchanged fact', () => {
    const previous = [stored('f1', 'Cut churn 23%', 0)];
    const matched = matchFactIds(previous, [extracted('Cut churn 23%', 0)]);

    expect(matched[0].id).toBe('f1');
    expect(matched[0].isNew).toBe(false);
  });

  it('keeps the id when a fact moves position but the text is identical', () => {
    const previous = [stored('f1', 'Cut churn 23%', 0), stored('f2', 'Led migration', 1)];
    const matched = matchFactIds(previous, [extracted('Led migration', 0), extracted('Cut churn 23%', 1)]);

    expect(matched.find((f) => f.text === 'Cut churn 23%')?.id).toBe('f1');
    expect(matched.find((f) => f.text === 'Led migration')?.id).toBe('f2');
  });

  it('assigns a new id to edited text', () => {
    const previous = [stored('f1', 'Cut churn 23%', 0)];
    const matched = matchFactIds(previous, [extracted('Cut churn 31%', 0)]);

    expect(matched[0].id).not.toBe('f1');
    expect(matched[0].isNew).toBe(true);
  });

  it('does not reuse one stored fact for two identical extracted facts', () => {
    const previous = [stored('f1', 'Mentored juniors', 0)];
    const matched = matchFactIds(previous, [extracted('Mentored juniors', 0), extracted('Mentored juniors', 1)]);

    expect(matched[0].id).toBe('f1');
    expect(matched[1].id).not.toBe('f1');
    expect(matched[1].isNew).toBe(true);
  });

  it('returns an empty list for no extracted facts rather than throwing', () => {
    expect(matchFactIds([stored('f1', 'x', 0)], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
./node_modules/.bin/jest src/master/fact-identity.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/master/fact-identity.ts`. `hashFactContent` normalizes whitespace and lowercases before `sha256`. `matchFactIds` consumes each stored fact at most once — build a `Map<hash, id[]>` and shift an id off on match, so duplicate text does not collapse into one fact.

- [ ] **Step 4: Run to verify they pass**

```bash
./node_modules/.bin/jest src/master/fact-identity.spec.ts
```

Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add src/master/fact-identity.ts src/master/fact-identity.spec.ts
git commit -m "feat: content-hash fact identity matching"
```

---

### Task 5: AI client

**Files:**
- Create: `src/ai/ai-client.service.ts`, `src/ai/ai-client.service.spec.ts`, `src/ai/ai.module.ts`

**Interfaces:**
- Consumes: `AI_SERVICE_URL`
- Produces: `AiClientService.complete(input: { tier: 'cheap' | 'smart'; prompt: string; schema?: object; timeoutMs?: number }): Promise<AiCompletion>` where `AiCompletion = { text: string; modelUsed: string; degraded: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `src/ai/ai-client.service.spec.ts`:

```ts
import { AiClientService } from './ai-client.service';

describe('AiClientService', () => {
  let fetchMock: jest.Mock;
  let client: AiClientService;

  beforeEach(() => {
    fetchMock = jest.fn();
    client = new AiClientService('http://ai-microservice:3380', fetchMock as unknown as typeof fetch);
  });

  it('returns the completion and the served model', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello', model_used: 'openrouter/google/gemma-4-31b-it:free' }),
    });

    const result = await client.complete({ tier: 'smart', prompt: 'x' });

    expect(result.text).toBe('hello');
    expect(result.modelUsed).toBe('openrouter/google/gemma-4-31b-it:free');
    expect(result.degraded).toBe(false);
  });

  it('marks a response degraded when a fallback model served it', async () => {
    // smart -> smart-fallback silently returns a different model. It must be visible.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello', model_used: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free' }),
    });

    const result = await client.complete({ tier: 'smart', prompt: 'x' });

    expect(result.degraded).toBe(true);
  });

  it('marks degraded when the Ollama code model served a prose request', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello', model_used: 'ollama/qwen2.5-coder:0.5b' }),
    });

    expect((await client.complete({ tier: 'smart', prompt: 'x' })).degraded).toBe(true);
  });

  it('raises on an HTTP error with status and body in the message', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'upstream down' });

    await expect(client.complete({ tier: 'cheap', prompt: 'x' })).rejects.toThrow(/503.*upstream down/s);
  });

  it('raises rather than returning empty text when the response has no text', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ model_used: 'x' }) });

    await expect(client.complete({ tier: 'cheap', prompt: 'x' })).rejects.toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
./node_modules/.bin/jest src/ai/ai-client.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/ai/ai-client.service.ts`. Requirements:

```ts
/** Models each tier is allowed to be served by. Anything else is a silent downgrade. */
const EXPECTED_MODELS: Record<'cheap' | 'smart', string[]> = {
  cheap: ['openrouter/google/gemma-4-26b-a4b-it:free'],
  smart: ['openrouter/google/gemma-4-31b-it:free'],
};
```

`degraded` is `true` whenever `model_used` is not in the requested tier's list. Empty `text` throws — an empty completion is a failure, never a result. Default `timeoutMs` must be **larger** than the LiteLLM proxy's `request_timeout` (120s), or the fallback chain never runs; use 150000 and comment why.

- [ ] **Step 4: Run to verify they pass**

```bash
./node_modules/.bin/jest src/ai/ai-client.service.spec.ts
```

Expected: PASS, all five.

- [ ] **Step 5: Commit**

```bash
git add src/ai
git commit -m "feat: ai-microservice client with silent-downgrade detection"
```

---

### Task 6: Fact extraction from Markdown

**Files:**
- Create: `src/master/fact-extractor.service.ts`, `src/master/fact-extractor.service.spec.ts`

**Interfaces:**
- Consumes: `AiClientService` (5)
- Produces: `FactExtractorService.extract(markdown: string): Promise<ExtractedFact[]>` where `ExtractedFact = { kind: FactKind; text: string; payload: Record<string, unknown>; metric: string | null; position: number }`

- [ ] **Step 1: Write the failing tests**

Create `src/master/fact-extractor.service.spec.ts`:

```ts
import { FactExtractorService } from './fact-extractor.service';

describe('FactExtractorService', () => {
  const aiWith = (payload: unknown) => ({
    complete: jest.fn(async () => ({ text: JSON.stringify(payload), modelUsed: 'openrouter/google/gemma-4-26b-a4b-it:free', degraded: false })),
  });

  it('extracts facts with positions assigned in order', async () => {
    const ai = aiWith({
      facts: [
        { kind: 'role', text: 'Senior Developer at X', payload: { company: 'X' }, metric: null },
        { kind: 'achievement', text: 'Cut churn 23%', payload: {}, metric: '23%' },
      ],
    });
    const service = new FactExtractorService(ai as never);

    const facts = await service.extract('# CV\n- Senior Developer at X\n- Cut churn 23%');

    expect(facts.map((f) => f.position)).toEqual([0, 1]);
    expect(facts[1].metric).toBe('23%');
  });

  it('uses the cheap tier', async () => {
    const ai = aiWith({ facts: [] });
    await new FactExtractorService(ai as never).extract('# CV');

    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({ tier: 'cheap' }));
  });

  it('raises on unparseable model output rather than returning no facts', async () => {
    const ai = { complete: jest.fn(async () => ({ text: 'not json', modelUsed: 'm', degraded: false })) };

    // Zero facts and a broken parse are different outcomes and must stay distinguishable.
    await expect(new FactExtractorService(ai as never).extract('# CV')).rejects.toThrow(/parse/i);
  });

  it('raises when the payload has no facts array', async () => {
    const ai = aiWith({ notFacts: [] });

    await expect(new FactExtractorService(ai as never).extract('# CV')).rejects.toThrow(/facts/);
  });

  it('returns an empty array for a genuinely empty CV', async () => {
    const ai = aiWith({ facts: [] });

    await expect(new FactExtractorService(ai as never).extract('# CV')).resolves.toEqual([]);
  });

  it('rejects a fact whose kind is not recognised', async () => {
    const ai = aiWith({ facts: [{ kind: 'invented', text: 'x', payload: {}, metric: null }] });

    await expect(new FactExtractorService(ai as never).extract('# CV')).rejects.toThrow(/kind/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
./node_modules/.bin/jest src/master/fact-extractor.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/master/fact-extractor.service.ts`. The prompt instructs the model to return `{"facts":[{kind,text,payload,metric}]}` and to extract only what is present — never to infer or embellish. Validate every `kind` against the `FactKind` union and throw on an unknown one. Distinguish a parse failure from an empty result, as the tests require.

- [ ] **Step 4: Run to verify they pass**

```bash
./node_modules/.bin/jest src/master/fact-extractor.service.spec.ts
```

Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add src/master/fact-extractor.service.ts src/master/fact-extractor.service.spec.ts
git commit -m "feat: extract fact graph from master CV markdown"
```

---

### Task 7: Master CV service — save, derive, detect drift

**Files:**
- Create: `src/master/master-cv.service.ts`, `src/master/master-cv.service.spec.ts`

**Interfaces:**
- Consumes: entities (3), `matchFactIds` / `hashFactContent` (4), `FactExtractorService` (6)
- Produces: `MasterCvService.save(userId, markdown, sourceType, sourceRef?): Promise<SaveResult>` where `SaveResult = { master: CvMasterEntity; factDiff: { added: MatchedFact[]; removed: StoredFact[]; kept: number } }`; `.getCurrent(userId): Promise<{ master; facts } | null>`; `.assertFactsFresh(master): void`

- [ ] **Step 1: Write the failing tests**

Create `src/master/master-cv.service.spec.ts`. Key behaviours — the conflict rule from spec §4.1:

```ts
import { MasterCvService } from './master-cv.service';
import { hashFactContent } from './fact-identity';

describe('MasterCvService', () => {
  it('stores the sha of the markdown the facts came from', async () => {
    // save() must persist factsExtractedFromMarkdownSha = sha256(markdown)
  });

  it('creates a new version rather than mutating the current one', async () => {
    // second save for the same user -> version 2, version 1 keeps isCurrent = false
  });

  it('reports which facts were added, removed, and kept', async () => {
    // editing one bullet of three -> added 1, removed 1, kept 2
  });

  it('raises when stored facts do not match the stored markdown', () => {
    const service = new MasterCvService(null as never, null as never, null as never);
    const master = { markdown: '# changed', factsExtractedFromMarkdownSha: hashFactContent('# original') } as never;

    // Drift must raise, never be silently tolerated — this is the frozen-table failure class.
    expect(() => service.assertFactsFresh(master)).toThrow(/stale|drift/i);
  });

  it('does not raise when facts match the markdown', () => {
    const service = new MasterCvService(null as never, null as never, null as never);
    const markdown = '# cv';
    const master = { markdown, factsExtractedFromMarkdownSha: hashFactContent(markdown) } as never;

    expect(() => service.assertFactsFresh(master)).not.toThrow();
  });

  it('returns null for a user with no master CV rather than an empty master', async () => {
    // getCurrent must return null, not a blank CvMasterEntity
  });
});
```

Fill in the four persistence tests against the test Postgres, following the pattern in the BPCP plan's Task 2 (`BPCP_TEST_DATABASE_URL` → `CV_TEST_DATABASE_URL`, `describe.skip` when unset).

- [ ] **Step 2: Run to verify they fail**

```bash
./node_modules/.bin/jest src/master/master-cv.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/master/master-cv.service.ts`. `save` runs in one transaction: hash the markdown, extract facts, match IDs against the previous version's facts, insert the new version with `isCurrent = true`, clear `isCurrent` on the prior version, and return the fact diff for the confirmation UI. `assertFactsFresh` compares `hashFactContent(master.markdown)` against `master.factsExtractedFromMarkdownSha` and throws a named error on mismatch. Never write markdown from facts.

- [ ] **Step 4: Run to verify they pass**

```bash
export CV_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/cv_test
./node_modules/.bin/jest src/master/master-cv.service.spec.ts
```

Expected: PASS, all six.

- [ ] **Step 5: Confirm the drift test can fail**

Temporarily make `assertFactsFresh` a no-op and re-run. The drift test MUST fail. Restore it.

- [ ] **Step 6: Commit**

```bash
git add src/master/master-cv.service.ts src/master/master-cv.service.spec.ts
git commit -m "feat: master CV versioning with markdown-as-source-of-truth"
```

---

### Task 8: Import endpoints

**Files:**
- Create: `src/master/master-cv.controller.ts`, `src/master/master-cv.controller.spec.ts`
- Create: `src/master/dto/save-master.dto.ts`, `src/master/dto/import-gdocs.dto.ts`
- Create: `src/master/importers/gdocs.importer.ts`, `src/master/importers/gdocs.importer.spec.ts`
- Create: `src/master/master.module.ts`

**Interfaces:**
- Consumes: `MasterCvService` (7), `CvAuthGuard` (2)
- Produces: `POST /api/master` (paste/type), `POST /api/master/import/gdocs`, `GET /api/master`, `GET /api/master/facts`

Upload of PDF/DOCX and LinkedIn archive import are **Task 9**, kept separate because they need MinIO and a parser.

- [ ] **Step 1: Write the failing controller tests**

Create `src/master/master-cv.controller.spec.ts`:

```ts
import { NotFoundException } from '@nestjs/common';
import { MasterCvController } from './master-cv.controller';

describe('MasterCvController', () => {
  let service: any;
  let gdocs: any;
  let controller: MasterCvController;

  beforeEach(() => {
    service = {
      save: jest.fn(async () => ({ master: { id: 'm1', version: 1 }, factDiff: { added: [], removed: [], kept: 0 } })),
      getCurrent: jest.fn(async () => null),
    };
    gdocs = { fetchMarkdown: jest.fn(async () => '# CV') };
    controller = new MasterCvController(service, gdocs);
  });

  it('saves pasted markdown for the authenticated user', async () => {
    await controller.save({ user: { id: 'u1' } } as never, { markdown: '# CV' } as never);
    expect(service.save).toHaveBeenCalledWith('u1', '# CV', 'paste', undefined);
  });

  it('returns the fact diff so the user can confirm it', async () => {
    const result = await controller.save({ user: { id: 'u1' } } as never, { markdown: '# CV' } as never);
    expect(result.factDiff).toBeDefined();
  });

  it('404s when the user has no master CV', async () => {
    await expect(controller.getCurrent({ user: { id: 'u1' } } as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('imports from a Google Docs link', async () => {
    await controller.importGdocs({ user: { id: 'u1' } } as never, { url: 'https://docs.google.com/document/d/abc/edit' } as never);
    expect(service.save).toHaveBeenCalledWith('u1', '# CV', 'gdocs', 'https://docs.google.com/document/d/abc/edit');
  });
});
```

- [ ] **Step 2: Write the failing importer tests**

Create `src/master/importers/gdocs.importer.spec.ts`:

```ts
import { GdocsImporter } from './gdocs.importer';

describe('GdocsImporter', () => {
  it('converts an edit URL to the plain-text export URL', () => {
    expect(GdocsImporter.exportUrl('https://docs.google.com/document/d/abc123/edit?usp=sharing'))
      .toBe('https://docs.google.com/document/d/abc123/export?format=txt');
  });

  it('rejects a non-Google-Docs URL', () => {
    expect(() => GdocsImporter.exportUrl('https://example.com/cv')).toThrow(/google docs/i);
  });

  it('raises a clear error when the document is not link-shared', async () => {
    const fetchMock = jest.fn(async () => ({ ok: false, status: 401, text: async () => 'login required' }));
    const importer = new GdocsImporter(fetchMock as never);

    // v1 supports link-shared docs only; private docs need OAuth, which is not built.
    await expect(importer.fetchMarkdown('https://docs.google.com/document/d/abc/edit'))
      .rejects.toThrow(/link.?shar|not publicly accessible/i);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

```bash
./node_modules/.bin/jest src/master/master-cv.controller.spec.ts src/master/importers/gdocs.importer.spec.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

Create the DTOs (`markdown` required, non-empty; `url` required), `GdocsImporter` (static `exportUrl` regex on `/document/d/([^/]+)/`, instance `fetchMarkdown` mapping 401/403 to a "must be link-shared" error), the controller guarded by `CvAuthGuard`, and `master.module.ts`.

- [ ] **Step 5: Run to verify they pass**

```bash
./node_modules/.bin/jest src/master/
npm run build
```

Expected: PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/master
git commit -m "feat: master CV import via paste and Google Docs link"
```

---

### Task 9: File upload import (PDF/DOCX, LinkedIn archive)

**Files:**
- Create: `src/storage/minio.service.ts` (pattern: `catalog-microservice/src/media/media.service.ts`)
- Create: `src/master/importers/document.importer.ts`, `document.importer.spec.ts`
- Create: `src/master/importers/linkedin.importer.ts`, `linkedin.importer.spec.ts`
- Modify: `src/master/master-cv.controller.ts`

**Interfaces:**
- Consumes: `AiClientService` (5), `MasterCvService` (7)
- Produces: `POST /api/master/import/upload`; `MinioService.putObject(key, buffer, contentType): Promise<string>`

- [ ] **Step 1: Read the existing MinIO pattern**

```bash
rtk cat ../catalog-microservice/src/media/media.service.ts
rtk cat ../catalog-microservice/k8s/external-secret.yaml
```

- [ ] **Step 2: Write the failing tests**

`document.importer.spec.ts` must cover: PDF text extraction returns markdown; a scanned/image-only PDF with no text layer **raises** rather than returning empty markdown; DOCX extraction works; an unsupported MIME type is rejected by name.

`linkedin.importer.spec.ts` must cover: a `Positions.csv` from the archive maps to role facts; a missing expected CSV raises naming the file; an empty archive raises.

- [ ] **Step 3: Run to verify they fail**

```bash
./node_modules/.bin/jest src/master/importers/
```

Expected: FAIL.

- [ ] **Step 4: Implement**

Store the original upload in MinIO (bucket `cv-uploads`, key `${userId}/${uuid}.${ext}`) and record the key as `sourceRef`. Extract text, then hand it to `FactExtractorService` via the normal save path. Never let an empty extraction stand in for a failure.

- [ ] **Step 5: Run to verify they pass, then commit**

```bash
./node_modules/.bin/jest src/master/importers/
git add src/storage src/master
git commit -m "feat: import master CV from PDF, DOCX, and LinkedIn archive"
```

---

### Task 10: Deploy Phase 1

**Files:**
- Modify: `k8s/configmap.yaml`, `k8s/external-secret.yaml`, `k8s/deployment.yaml`

- [ ] **Step 1: Create the database and role**

```bash
kubectl port-forward -n statex-apps svc/db-server-postgres 5433:5432 &
psql "postgresql://postgres@localhost:5433/postgres" -c "CREATE DATABASE cv;"
psql "postgresql://postgres@localhost:5433/postgres" -c "CREATE ROLE cv_app LOGIN PASSWORD '<generated>';"
psql "postgresql://postgres@localhost:5433/postgres" -c "GRANT ALL PRIVILEGES ON DATABASE cv TO cv_app;"
```

- [ ] **Step 2: Store secrets in Vault and name every key in the manifest**

```bash
/vault-secret cv-tuning set CV_DATABASE_URL=postgresql://cv_app:<generated>@db-server-postgres:5432/cv
/vault-secret cv-tuning set MINIO_ACCESS_KEY=<value>
/vault-secret cv-tuning set MINIO_SECRET_KEY=<value>
```

Add all three to `k8s/external-secret.yaml` under `spec.data`. A key absent here never reaches the pod while ESO still reports `Synced`.

- [ ] **Step 3: Dry-run, then verify the migration on a scratch DB**

```bash
DRY_RUN=1 ./scripts/deploy.sh
createdb -h localhost -p 5433 cv_scratch
CV_DATABASE_URL=postgresql://cv_app@localhost:5433/cv_scratch npm run start:prod
```

Expected: migrations apply cleanly; `cv_profile`, `cv_master`, `cv_fact` exist. Drop the scratch DB.

- [ ] **Step 4: Commit and let auto-deploy run**

```bash
git add k8s/
git commit -m "feat: deployment wiring for cv-tuning phase 1"
git push
```

- [ ] **Step 5: Verify by pod age, not log lines**

```bash
../shared/scripts/deploy-queue/queuectl.sh status
../shared/scripts/wait-for-rollout.sh -n statex-apps cv-tuning
kubectl get pods -n statex-apps -l app=cv-tuning -o wide
```

Compare pod age to the commit time. Then reproduce the real scenario end to end:

```bash
TOKEN=<owner token>
curl -sS -XPOST https://cv.alfares.cz/api/master \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"markdown":"# Test CV\n- Cut churn 23%"}'
curl -sS https://cv.alfares.cz/api/master/facts -H "authorization: Bearer $TOKEN"
```

Expected: the save returns a fact diff; the facts endpoint lists the extracted fact with a stable id.

---

## Later Phases

Each gets its own plan document, written when its phase starts — Phase 3's task breakdown depends on what Phase 1 and 2 actually produce, and writing it now would be speculation.

| Phase | Scope | Key risk to resolve in its plan |
|---|---|---|
| **2** | JD ingest (fetch + readability + paste fallback), fit score, gap report | Fetch blocking rates; `fetch_status` must surface the paste fallback, never an empty CV |
| **3** | Tailoring generation, constrained-to-one-master-bullet, entailment validator, eval harness, diff UI | The eval harness must exist **before** the validator is trusted; copy `ai-microservice/src/teacher-assistant/__evals__/run-eval.ts` |
| **4** | Voice revision loop (Web Speech API), approve, PDF via pdfkit, DOCX via `docx` | Reuse `invoices-microservice/src/invoices/invoice-pdf.service.ts` including its sha256 return |
| **5** | Dashboard, outcome tracking, notification nudges | `marked_sent` is user-asserted and must render distinctly from observed states |
| **6** | Cover letters, screening answers, proof-of-work fact surfacing | Same grounding rules apply — no new claims |
| **7** | **GDPR**: pseudonymization, consent, delete-cascade incl. MinIO objects, export, retention, offboarding reconciliation | Gate: no third-party users before this completes |
| **8** | **Model benchmark** across tiers on real CVs | Produces the €/application figure and the AI-tell comparison |
| **9** | **Premium enablement**, only if Phase 8 justifies it | Requires lifting per-call approval on `premium` in ai-microservice |
| **10** | Billing, pricing, free-tier limits | Schema already accommodates it |

## Self-Review

**Spec coverage (Phase 1 only):** §3 topology → Tasks 1, 3. §3.1 reuse → Tasks 2, 9. §3.2 auth → Task 2. §4 data model → Task 3. §4.1 MD↔fact conflict rule → Tasks 4, 6, 7. §4.3 multi-language → `cv_profile.locale` in Task 3; render-language selection is Phase 3. §8 tiers → Task 5. §8.0 model attribution → Task 5 (`modelUsed`, `degraded`); `cv_render` columns arrive in Phase 3. §8.1 silent degradation → Task 5. §10 failure handling → every task. §11 testing → Tasks 2, 4, 5, 6, 7.

**Deliberately out of Phase 1:** everything in §5 (state machine), §6 (grounding), §7 (diff UX), §9 (GDPR) — those are Phases 2–7 per §12.

**Type consistency:** `FactKind` defined in Task 3, used in 4, 6, 7. `ExtractedFact` defined in Task 6, consumed by `matchFactIds` from Task 4 — Task 4's tests construct it with the same `{ text, position, kind, payload, metric }` shape. `AiCompletion.modelUsed` (Task 5) is the field Task 6 relies on. `MasterCvService.save` returns `SaveResult` with the `factDiff` the Task 8 controller returns.
