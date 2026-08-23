import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CvFactEntity } from '../master/entities/cv-fact.entity';
import { MasterCvService } from '../master/master-cv.service';
import { JobsService } from '../jobs/jobs.service';
import { CvPdfService } from '../export/cv-pdf.service';
import { CvDocxService } from '../export/cv-docx.service';
import { MinioService } from '../storage/minio.service';
import { scoreAiTell } from './ai-tell';
import {
  ApplicationState,
  ArtifactKind,
  ChatRole,
  ConfirmedClaim,
  FactSnapshot,
  InputMode,
  RenderProvenance,
  TailoredBullet,
} from './application.types';
import { diffLines, DiffHunk } from './diff';
import { CvApplicationEntity } from './entities/cv-application.entity';
import { CvArtifactEntity } from './entities/cv-artifact.entity';
import { CvChatEntity } from './entities/cv-chat.entity';
import { CvRenderEntity } from './entities/cv-render.entity';
import { EntailService } from './entail.service';
import { buildRenderMarkdown } from './render-markdown';
import { ReviseService } from './revise.service';
import { TailorService } from './tailor.service';

const REQUESTED_TIER = 'smart';

/** How many of the user's own sentences are carried in as style exemplars (§6.1). */
const STYLE_EXEMPLAR_COUNT = 5;

/** Bounds worst-case model spend per application (spec §4). */
const MAX_REVISIONS = 20;

/** Bounds spend per user across all their applications (spec §8.3). */
const MAX_TURNS_PER_HOUR = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

export interface RenderView {
  render: CvRenderEntity;
  /** Bullets needing a confirm-or-drop decision from the user (§6 layer 3). */
  needsConfirmation: TailoredBullet[];
}

export interface DiffView {
  revisionNo: number;
  /** The revision this was diffed against; null means the master CV was the baseline. */
  baselineRevisionNo: number | null;
  hunks: DiffHunk[];
}

@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(
    @InjectRepository(CvApplicationEntity)
    private readonly applications: Repository<CvApplicationEntity>,
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

  /** Creates an application against the current master, pins it, and generates revision 1. */
  async create(userId: string, jobId: string, renderLanguage?: string): Promise<RenderView> {
    const { job } = await this.jobs.get(userId, jobId);

    if (!job.parsed) {
      throw new ConflictException(
        `job ${jobId} has no parsed requirements (fetch status: ${job.fetchStatus}); supply the posting text first`,
      );
    }

    const current = await this.master.getCurrent(userId);
    if (!current) {
      throw new ConflictException('you need a master CV before an application can be generated');
    }

    const application = await this.applications.save(
      this.applications.create({
        userId,
        jobId,
        // Read once, here. Every later read goes through getVersion(masterVersionId), so a
        // subsequent master edit cannot change what this application was built from (§4.2).
        masterVersionId: current.master.id,
        state: 'generating' as ApplicationState,
        renderLanguage: renderLanguage ?? job.language ?? 'en',
      }),
    );

    return this.generate(userId, application, 1);
  }

  /** Produces a new revision from the SAME pinned master version. */
  async regenerate(userId: string, applicationId: string): Promise<RenderView> {
    const application = await this.findOwned(userId, applicationId);
    const last = await this.renders.findOne({
      where: { applicationId },
      order: { revisionNo: 'DESC' },
    });

    return this.generate(userId, application, (last?.revisionNo ?? 0) + 1);
  }

  private async generate(
    userId: string,
    application: CvApplicationEntity,
    revisionNo: number,
  ): Promise<RenderView> {
    const pinned = await this.master.getVersion(userId, application.masterVersionId);
    if (!pinned) {
      // The pin is the guarantee that a render is reproducible. A missing pinned version is
      // data loss, not an empty result.
      throw new Error(
        `application ${application.id} pins master version ${application.masterVersionId}, which no longer exists`,
      );
    }

    const { job } = await this.jobs.get(userId, application.jobId);
    if (!job.parsed) {
      throw new ConflictException(`job ${application.jobId} has no parsed requirements`);
    }

    const snapshot = this.toSnapshot(pinned.facts);
    const idempotencyKey = `${application.id}:${revisionNo}`;

    const existing = await this.renders.findOne({ where: { idempotencyKey } });
    if (existing) {
      // A retried request must not spend a second pair of LLM calls.
      this.logger.warn(`render ${idempotencyKey} already exists; returning it instead of regenerating`);
      return this.toView(existing);
    }

    try {
      const drafted = await this.tailor.tailor({
        facts: snapshot,
        requirements: job.parsed.requirements,
        jobTitle: job.title,
        company: job.company,
        language: application.renderLanguage,
        styleExemplars: snapshot.slice(0, STYLE_EXEMPLAR_COUNT).map((f) => f.text),
      });

      const validated = await this.entail.validate(drafted.bullets, snapshot);

      // Structured per the `cv-document.ts` H1/H2/H3 convention so PDF/DOCX export (Task 8)
      // can parse it — see render-markdown.ts for why this is a name + one honest section
      // rather than a full multi-section reconstruction.
      const markdown = buildRenderMarkdown(pinned.master.markdown, validated.bullets);
      const provenance: RenderProvenance = {
        bullets: validated.bullets,
        droppedBullets: drafted.droppedBullets,
      };

      // Built as a plain object then cast at the boundary: TypeORM's DeepPartial rejects the
      // nested index signatures in `provenance`, and `create()` overloads on array input.
      const draft: CvRenderEntity = {
          applicationId: application.id,
          revisionNo,
          markdown,
          factsSnapshot: snapshot,
          provenance,
          aiTellScore: scoreAiTell(markdown).score,
          createdBy: 'ai',
          modelUsed: drafted.modelUsed,
          validatorModelUsed: validated.validatorModelUsed,
          requestedTier: REQUESTED_TIER,
          degraded: false,
          promptVersion: `${drafted.promptVersion}/${validated.validatorPromptVersion}`,
        idempotencyKey,
      } as unknown as CvRenderEntity;

      const render = await this.renders.save(draft);

      await this.applications.update(application.id, { state: 'in_review', stateError: null });

      const flagged = validated.bullets.filter((b) => b.verdict !== 'supported');
      this.logger.log(
        `render ${render.id} revision ${revisionNo}: ${validated.bullets.length} bullets, ` +
          `${flagged.length} need confirmation, ${drafted.droppedBullets.length} dropped, ` +
          `model=${drafted.modelUsed} validator=${validated.validatorModelUsed}`,
      );

      return this.toView(render);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // generation_failed exists so a mid-generation failure surfaces with its error rather
      // than leaving the application stuck in `generating` forever (spec §5).
      await this.applications.update(application.id, {
        state: 'generation_failed' as ApplicationState,
        stateError: message,
      });
      this.logger.error(`generation failed for application ${application.id} revision ${revisionNo}: ${message}`);
      throw cause;
    }
  }

  async list(userId: string): Promise<CvApplicationEntity[]> {
    return this.applications.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  async get(userId: string, applicationId: string): Promise<CvApplicationEntity> {
    return this.findOwned(userId, applicationId);
  }

  async listRenders(userId: string, applicationId: string): Promise<CvRenderEntity[]> {
    await this.findOwned(userId, applicationId);
    return this.renders.find({ where: { applicationId }, order: { revisionNo: 'ASC' } });
  }

  /** Diffs a revision against its predecessor, or against the master CV for revision 1. */
  async diff(userId: string, applicationId: string, revisionNo: number): Promise<DiffView> {
    const application = await this.findOwned(userId, applicationId);

    const render = await this.renders.findOne({ where: { applicationId, revisionNo } });
    if (!render) {
      throw new NotFoundException(`revision ${revisionNo} not found for application ${applicationId}`);
    }

    if (revisionNo > 1) {
      const previous = await this.renders.findOne({
        where: { applicationId, revisionNo: revisionNo - 1 },
      });
      if (!previous) {
        throw new Error(
          `revision ${revisionNo} of application ${applicationId} has no revision ${revisionNo - 1} to diff against`,
        );
      }
      return {
        revisionNo,
        baselineRevisionNo: previous.revisionNo,
        hunks: diffLines(previous.markdown, render.markdown),
      };
    }

    const pinned = await this.master.getVersion(userId, application.masterVersionId);
    if (!pinned) {
      throw new Error(
        `application ${applicationId} pins master version ${application.masterVersionId}, which no longer exists`,
      );
    }

    // Spec §7: revision 1 is diffed against the master, so the first generation is
    // reviewable as a diff rather than appearing from nowhere.
    return {
      revisionNo,
      baselineRevisionNo: null,
      hunks: diffLines(pinned.master.markdown, render.markdown),
    };
  }

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
      throw new ConflictException(`application ${applicationId}: revision already in progress`);
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

    await this.assertWithinRateLimit(userId);

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

      // Same structured convention as generate() — see render-markdown.ts.
      const markdown = buildRenderMarkdown(pinned.master.markdown, validated.bullets);
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
        // Carried forward, not reset (matches confirmClaim's own behaviour): a confirmation
        // remains true of the content even after an AI revision, so resetting it here would
        // silently lose a user's earlier audit record the moment they ran one more turn.
        confirmedOverreach: latest.confirmedOverreach,
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
    const application = await this.findOwned(userId, applicationId);

    // Matches revise()/approve()'s state guard. Without it confirmClaim would happily append
    // a render to an `approved` or `downloaded` application, producing a render newer than
    // the artifact the user already reviewed and downloaded — the same spec §6.3 divergence
    // Task 5's approve() guard exists to prevent, entered through this door instead.
    if (application.state !== 'in_review') {
      throw new ConflictException(
        `application ${applicationId} is in state ${application.state}; claims can only be ` +
          'confirmed or dropped while the application is in_review',
      );
    }

    const source = await this.renders.findOne({ where: { applicationId, revisionNo } });
    if (!source) {
      throw new NotFoundException(`application ${applicationId} has no revision ${revisionNo}`);
    }

    const renders = await this.renders.find({ where: { applicationId }, order: { revisionNo: 'DESC' } });
    const latest = renders[0];
    if (latest && latest.revisionNo !== revisionNo) {
      // The new revision number must come from the latest render, never from the caller-
      // supplied path param: deriving `revisionNo + 1` blindly is exactly what let two
      // sequential confirmations against the same stale UI state (confirm A, then confirm B
      // — both submitted against the revision the UI originally showed) collide on
      // `uq_render_revision`/`idx_render_idempotency` as an opaque Postgres error. Rejecting
      // here with the real latest revision number turns that into a clear, actionable domain
      // error instead: the caller re-fetches the render it just created and resubmits the
      // remaining decision against it, exactly as the UI is expected to do after any
      // render-producing call.
      throw new ConflictException(
        `revision ${revisionNo} of application ${applicationId} is no longer the latest ` +
          `revision (latest is ${latest.revisionNo}); fetch the latest render and retry ` +
          'the confirm-or-drop decision against it',
      );
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

    // `source.markdown` already carries the H1 name — it was built by buildRenderMarkdown
    // in generate()/revise() — so it is reused directly rather than re-fetching the master.
    const markdown = buildRenderMarkdown(source.markdown, bullets);
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

    if (application.state !== 'in_review') {
      // A transition into `approved`, not an idempotent setter (spec §5.2). Once Task 8 wires
      // export-on-approve, re-approving a `downloaded` application would silently regenerate
      // and replace an artifact the user already downloaded — exactly the guarantee spec §6.3
      // exists to prevent. Matches revise()'s state guard above.
      throw new ConflictException(
        `application ${applicationId} is in state ${application.state} and cannot be approved`,
      );
    }

    const renders = await this.renders.find({
      where: { applicationId },
      order: { revisionNo: 'DESC' },
    });
    const latest = renders[0];
    if (!latest) {
      throw new ConflictException(`application ${applicationId} has no render to approve`);
    }

    if (latest.provenance.bullets.length === 0) {
      // Every bullet was either never produced or dropped/dropped-via-decision. A name-only
      // CV under an empty heading is not a reviewable outcome — approving it would let the
      // user download a file with no content, with no error anywhere in the chain.
      throw new ConflictException(
        `application ${applicationId} revision ${latest.revisionNo} has no bullets; ` +
          'nothing to approve',
      );
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

  /**
   * Generates both formats once per render. `(renderId, kind)` is unique in `cv_artifact`
   * (Task 1), so checking `have` before rendering makes this idempotent even without that
   * constraint — a re-approve attempt after a partial failure (e.g. PDF succeeded, DOCX
   * failed) resumes rather than re-spending a render on the format that already exists.
   */
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

  /**
   * Spec §6.3. Never regenerates: a download that quietly produces a different file than the
   * one approved breaks the approval guarantee, so a missing artifact is a 404, not a retry.
   */
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
      throw new NotFoundException(
        `${kind} artifact not found for revision ${revisionNo}; approve the application to generate it`,
      );
    }

    const content = await this.storage.getObject(artifact.minioKey);
    await this.applications.update(applicationId, { state: 'downloaded' as ApplicationState });
    return { content, artifact };
  }

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

  private toSnapshot(facts: CvFactEntity[]): FactSnapshot[] {
    return facts.map((fact) => ({ factId: fact.factId, text: fact.text, kind: fact.kind }));
  }

  private toView(render: CvRenderEntity): RenderView {
    return {
      render,
      needsConfirmation: render.provenance.bullets.filter((b) => b.verdict !== 'supported'),
    };
  }

  private async findOwned(userId: string, applicationId: string): Promise<CvApplicationEntity> {
    // Scoped by userId so another tenant's application is indistinguishable from a missing one.
    const application = await this.applications.findOne({ where: { id: applicationId, userId } });
    if (!application) {
      throw new NotFoundException(`application ${applicationId} not found`);
    }
    return application;
  }
}
