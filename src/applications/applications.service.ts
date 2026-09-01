import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CvFactEntity } from '../master/entities/cv-fact.entity';
import { MasterCvService } from '../master/master-cv.service';
import { JobsService } from '../jobs/jobs.service';
import { CvPdfService } from '../export/cv-pdf.service';
import { CvDocxService } from '../export/cv-docx.service';
import { MinioService } from '../storage/minio.service';
import { BpcpClientService } from '../bpcp/bpcp-client.service';
import { scoreAiTell } from './ai-tell';
import {
  ApplicationState,
  ARTIFACT_KINDS,
  ArtifactKind,
  ChatRole,
  ConfirmedClaim,
  FactSnapshot,
  InputMode,
  Outcome,
  RenderProvenance,
  TailoredBullet,
} from './application.types';
import { bulletIdOf, decidedBulletIds } from './bullet-identity';
import { diffLines, DiffHunk } from './diff';
import { CvApplicationEntity } from './entities/cv-application.entity';
import { CvArtifactEntity } from './entities/cv-artifact.entity';
import { CvChatEntity } from './entities/cv-chat.entity';
import { CvRenderEntity } from './entities/cv-render.entity';
import { EntailService } from './entail.service';
import { assertCanMarkSent, assertCanRecordOutcome } from './outcome';
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

/**
 * One row of the applications list. Deliberately flat and explicit rather than the entity:
 * the client needs the job's identity to tell two applications apart, and the entity carries
 * neither that nor a safe boundary (see MasterCvController's CurrentMasterView for the same
 * reasoning).
 */
export interface ApplicationListItem {
  id: string;
  jobId: string;
  jobTitle: string | null;
  jobCompany: string | null;
  state: ApplicationState;
  stateError: string | null;
  outcome: Outcome | null;
  renderLanguage: string;
  revisionCount: number;
  createdAt: Date;
}

/** A stored render plus the claims still awaiting a decision on it. */
export type RenderListItem = CvRenderEntity & { needsConfirmation: TailoredBullet[] };

export interface DiffView {
  revisionNo: number;
  /** The last approved revision this was diffed against; null means none has been approved. */
  baselineRevisionNo: number | null;
  /** A pre-approval render has no review checkpoint to compare against. */
  noBaseline: boolean;
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
    private readonly bpcp: BpcpClientService,
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

      // Structured per the `cv-document.ts` H1/H2/H3 convention so PDF/DOCX export can parse
      // it. `snapshot` is passed so the builder can group bullets under the section, employer,
      // and period their source facts were derived from — see render-markdown.ts.
      const markdown = buildRenderMarkdown(pinned.master.markdown, validated.bullets, snapshot);
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

  /**
   * Applications carry no name of their own, so a list of them rendered from entity fields
   * alone reads as a column of identical states (in_review, in_review, ...) with nothing
   * to tell one application from another. The position is what the user recognises, so the
   * job's title and company are resolved here rather than left to the client: the client has
   * no way to join them without fetching every job separately.
   *
   * Jobs are fetched once and indexed, not looked up per application.
   */
  async list(userId: string): Promise<ApplicationListItem[]> {
    const [applications, jobs] = await Promise.all([
      this.applications.find({ where: { userId }, order: { createdAt: 'DESC' } }),
      this.jobs.list(userId),
    ]);

    const byId = new Map(jobs.map((job) => [job.id, job]));

    return applications.map((application) => {
      const job = byId.get(application.jobId);
      return {
        id: application.id,
        jobId: application.jobId,
        // Null rather than a placeholder string: "is this position named?" is the client's
        // decision to render, and a fabricated title would be indistinguishable from a real one.
        jobTitle: job?.title ?? null,
        jobCompany: job?.company ?? null,
        state: application.state,
        stateError: application.stateError,
        outcome: application.outcome,
        renderLanguage: application.renderLanguage,
        revisionCount: application.revisionCount,
        createdAt: application.createdAt,
      };
    });
  }

  async get(userId: string, applicationId: string): Promise<CvApplicationEntity> {
    return this.findOwned(userId, applicationId);
  }

  /**
   * Renders carry `needsConfirmation` alongside the entity fields, so a client never has to
   * work out which claims are still open by reading `verdict` - which cannot answer it, since
   * a confirmed bullet keeps `verdict: 'overreach'` and only `confirmedOverreach` records the
   * decision. Spread flat rather than nested so `revisionNo`/`markdown` stay where callers
   * already read them.
   */
  async listRenders(userId: string, applicationId: string): Promise<RenderListItem[]> {
    await this.findOwned(userId, applicationId);
    const renders = await this.renders.find({
      where: { applicationId },
      order: { revisionNo: 'ASC' },
    });
    return renders.map((render) => ({ ...render, needsConfirmation: this.toView(render).needsConfirmation }));
  }

  /** Diffs a render against the CV checkpoint the user most recently approved. */
  async diff(userId: string, applicationId: string, revisionNo: number): Promise<DiffView> {
    const application = await this.findOwned(userId, applicationId);
    const render = await this.renders.findOne({ where: { applicationId, revisionNo } });
    if (!render) {
      throw new NotFoundException(`revision ${revisionNo} not found for application ${applicationId}`);
    }

    if (application.approvedRevisionNo == null) {
      // Before the first approval there is no user-approved checkpoint. Comparing arbitrary
      // generated revisions would look authoritative while answering a different question.
      return { revisionNo, baselineRevisionNo: null, noBaseline: true, hunks: [] };
    }
    if (application.approvedRevisionNo >= revisionNo) {
      return { revisionNo, baselineRevisionNo: application.approvedRevisionNo, noBaseline: true, hunks: [] };
    }

    const approved = await this.renders.findOne({
      where: { applicationId, revisionNo: application.approvedRevisionNo },
    });
    if (!approved) {
      throw new Error(`application ${applicationId} records approved revision ${application.approvedRevisionNo}, which no longer exists`);
    }
    return {
      revisionNo,
      baselineRevisionNo: approved.revisionNo,
      noBaseline: false,
      // The proven review boundary is the approved render, not revisionNo - 1: decisions and
      // AI iterations between approvals are audit history, not the change a person is reviewing.
      hunks: diffLines(approved.markdown, render.markdown),
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

    if (application.state !== 'in_review' && application.state !== 'approved') {
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
      const markdown = buildRenderMarkdown(pinned.master.markdown, validated.bullets, snapshot);
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
   *
   * The target is addressed by `bulletId`, NOT by its text. Text equality could not name one
   * of two identical-text bullets in a render: `find` always returned the first, so the second
   * could never be decided and the approval gate blocked forever on a claim with no way to
   * resolve it. See `bullet-identity.ts` for why the id is derived from `sourceFactId` and how
   * renders stored before the field existed still resolve.
   */
  async confirmClaim(
    userId: string,
    applicationId: string,
    revisionNo: number,
    bulletId: string,
    decision: 'confirm' | 'drop',
  ): Promise<RenderView> {
    const application = await this.findOwned(userId, applicationId);

    // An approved application may deliberately return to review for a new decision, but no
    // terminal or in-progress state may mint a render through this path.
    if (application.state !== 'in_review' && application.state !== 'approved') {
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

    const target = source.provenance.bullets.find((b) => bulletIdOf(b) === bulletId);
    if (!target) {
      // A decision about a bullet that is not in this render is a client bug, not a no-op.
      throw new NotFoundException(`revision ${revisionNo} has no bullet with id "${bulletId}"`);
    }

    if (target.verdict !== 'overreach') {
      throw new ConflictException(
        `bullet is "${target.verdict}", not "overreach"; it needs no confirm-or-drop decision`,
      );
    }

    // A confirmation carries the bullet forward unchanged, so the bullet stays `overreach`
    // in the next render and looks undecided to anything reading `verdict` alone. Without
    // this guard a second press of the same button produced a second revision that differed
    // from its predecessor in nothing but the audit row - a user could stack revisions by
    // clicking, and the diff between them was empty. Resolved through decidedBulletIds so a
    // legacy text-only claim counts too, exactly as the approval gate resolves it.
    if (decidedBulletIds(source.confirmedOverreach, source.provenance.bullets).has(bulletId)) {
      throw new ConflictException(
        `claim "${target.text}" has already been decided on revision ${revisionNo}; it needs no second decision`,
      );
    }

    // Filtered by id, not by text: dropping by text would take the twin down with it — the
    // same ambiguity that made the second twin undecidable, doing damage in the other
    // direction by silently deleting a bullet the user never ruled on.
    const bullets =
      decision === 'drop'
        ? source.provenance.bullets.filter((b) => bulletIdOf(b) !== bulletId)
        : source.provenance.bullets;

    const confirmedOverreach: ConfirmedClaim[] = [
      ...source.confirmedOverreach,
      {
        bulletId,
        // Kept alongside the id: the audit trail must show a later reader WHAT was accepted,
        // which an opaque id alone does not.
        bulletText: target.text,
        decision,
        decidedBy: userId,
        decidedAt: new Date().toISOString(),
      },
    ];

    // `source.markdown` already carries the H1 name — it was built by buildRenderMarkdown
    // in generate()/revise() — so it is reused directly rather than re-fetching the master.
    // The section/entry structure is rebuilt from `source.factsSnapshot` (the SAME snapshot the
    // new render stores below), not carried over from the prior markdown, so re-rendering is
    // idempotent instead of accumulating a copy of the previous layout.
    const markdown = buildRenderMarkdown(source.markdown, bullets, source.factsSnapshot);
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
    await this.applications.update(applicationId, { state: 'in_review', stateError: null });
    this.logger.log(
      `claim ${bulletId} "${target.text.slice(0, 60)}" ${decision === 'drop' ? 'dropped' : 'confirmed'} ` +
        `by ${userId} on ${applicationId}`,
    );
    return this.toView(saved);
  }

  /**
   * Saves prose authored directly by the person. This intentionally skips entailment: unlike an
   * AI instruction, the product explicitly treats a user's own edit as trusted. Its existing
   * evidence audit is carried forward unchanged rather than inventing unsupported provenance.
   */
  async edit(userId: string, applicationId: string, markdown: string): Promise<RenderView> {
    const application = await this.findOwned(userId, applicationId);
    if (application.state !== 'in_review' && application.state !== 'approved') {
      throw new ConflictException(
        `application ${applicationId} is in state ${application.state}; it can only be edited while in_review or approved`,
      );
    }
    const renders = await this.renders.find({ where: { applicationId }, order: { revisionNo: 'DESC' } });
    const latest = renders[0];
    if (!latest) throw new ConflictException(`application ${applicationId} has no render to edit`);
    const revisionNo = latest.revisionNo + 1;
    const draft: CvRenderEntity = {
      applicationId, revisionNo, markdown, factsSnapshot: latest.factsSnapshot,
      provenance: latest.provenance, confirmedOverreach: latest.confirmedOverreach,
      aiTellScore: scoreAiTell(markdown).score, createdBy: 'user', modelUsed: latest.modelUsed,
      validatorModelUsed: latest.validatorModelUsed, requestedTier: latest.requestedTier,
      degraded: latest.degraded, promptVersion: latest.promptVersion,
      idempotencyKey: `${applicationId}:${revisionNo}`,
    } as unknown as CvRenderEntity;
    const saved = await this.renders.save(draft);
    await this.applications.update(applicationId, { state: 'in_review', stateError: null });
    this.logger.log(`manual edit created revision ${revisionNo} for application ${applicationId}`);
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

    // Matched by bullet id, not by text: two identical-text overreach bullets are two claims
    // and each needs its own decision. A legacy claim carrying only `bulletText` still clears
    // its bullet when that text is unambiguous, and deliberately clears NOTHING when it is
    // not — see bullet-identity.ts#decidedBulletIds.
    const decided = decidedBulletIds(latest.confirmedOverreach, latest.provenance.bullets);
    const unresolved = latest.provenance.bullets.filter(
      (b) => b.verdict === 'overreach' && !decided.has(bulletIdOf(b)),
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
      approvedRevisionNo: latest.revisionNo,
      stateError: null,
    });

    this.logger.log(`application ${applicationId} approved at revision ${latest.revisionNo}`);

    try {
      await this.exportArtifacts(application.userId, applicationId, latest);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // The CV IS approved; only the files are missing. Recording the error keeps those two
      // outcomes distinguishable instead of implying the approval failed — and it is the
      // marker `retryExport` requires, so the half-finished transition stays completable.
      await this.applications.update(applicationId, { stateError: `export failed: ${message}` });
      this.logger.error(
        `export failed for approved application ${applicationId}: ${message}; ` +
          'recoverable via POST :id/retry-export',
      );
      // A plain `Error` here reaches Nest's default filter as a bare, message-less 500 —
      // exactly the case the approval WAS recorded but the person sees only "Internal Server
      // Error" with no way to know the CV is safe and retry-export exists. Wrapped so the
      // real, actionable reason (e.g. an unsupported PDF character) reaches the response body.
      throw new UnprocessableEntityException(
        `application ${applicationId} was approved, but export failed: ${message}. ` +
          'Retry the export from the application once the underlying issue is addressed.',
      );
    }

    // Clearing the marker only once export has actually succeeded is what makes
    // "approved and exported" and "approved but export failed" distinguishable on the row.
    await this.applications.update(applicationId, { stateError: null });

    return this.findOwned(userId, applicationId);
  }

  /**
   * Completes an approval whose export failed (spec §5.2, §6.3).
   *
   * WHY A SEPARATE ENTRY POINT rather than relaxing `approve()`'s state guard. `approve()` is
   * a TRANSITION into `approved`, and its guard is the thing that makes re-approving a
   * `downloaded` application — regenerating an artifact the user already holds — structurally
   * impossible. Adding "…unless stateError is set and no artifacts exist" would turn one
   * absolute rule into a three-clause condition that every later reader has to re-derive
   * correctly, and any future caller that forgot one clause would reopen the §6.3 hole.
   * Reordering so the state advanced only after export succeeded was the other candidate and
   * was rejected for the opposite reason: it makes an export failure look like an approval
   * failure, losing the distinction that the CV *was* approved and the files merely are not
   * there — and it would leave the application in `in_review` with an `approvedAt` question
   * nobody can answer.
   *
   * So this is an idempotent completion of a half-finished transition, never a re-approval,
   * and it is gated on all three of:
   *   - `state === 'approved'` — never `downloaded` (the user demonstrably holds a file from
   *     this render, so nothing may be regenerated for it) and never `in_review` (there is no
   *     transition in flight to complete);
   *   - `stateError` set — the marker that an export actually failed. Without it this would be
   *     a second export of a healthy approval, i.e. a re-approval through a side door;
   *   - at least one artifact still missing — a complete set means the files exist and may
   *     already be in the user's hands.
   *
   * A retry that fails again re-records the error and re-throws. It never tidies the state.
   */
  async retryExport(userId: string, applicationId: string): Promise<CvApplicationEntity> {
    const application = await this.findOwned(userId, applicationId);

    if (application.state !== 'approved') {
      throw new ConflictException(
        `application ${applicationId} is in state ${application.state}; only an approved ` +
          'application whose export failed can have its export retried',
      );
    }

    if (!application.stateError) {
      throw new ConflictException(
        `application ${applicationId} has no recorded export failure; there is nothing to retry`,
      );
    }

    const latest = await this.renders.findOne({
      where: { applicationId },
      order: { revisionNo: 'DESC' },
    });
    if (!latest) {
      // An approved application with no render is data loss, not an empty result.
      throw new Error(
        `application ${applicationId} is approved but has no render; its export cannot be retried`,
      );
    }

    const existing = await this.artifacts.find({ where: { renderId: latest.id } });
    const missing = ARTIFACT_KINDS.filter((kind) => !existing.some((a) => a.kind === kind));
    if (missing.length === 0) {
      throw new ConflictException(
        `application ${applicationId} revision ${latest.revisionNo} already has both artifacts; ` +
          'nothing to retry. Download them instead — regenerating a file the user may already ' +
          'hold would break the approval guarantee',
      );
    }

    this.logger.warn(
      `retrying export for approved application ${applicationId} revision ${latest.revisionNo}; ` +
        `missing: ${missing.join(', ')}; previous failure: ${application.stateError}`,
    );

    try {
      await this.exportArtifacts(application.userId, applicationId, latest);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await this.applications.update(applicationId, { stateError: `export failed: ${message}` });
      this.logger.error(`export retry failed for application ${applicationId}: ${message}`);
      // Same reasoning as `approve()`: a bare `Error` here becomes a message-less 500, hiding
      // the actionable reason from the person retrying the export.
      throw new UnprocessableEntityException(
        `export retry failed for application ${applicationId}: ${message}`,
      );
    }

    await this.applications.update(applicationId, { stateError: null });
    this.logger.log(`export retry succeeded for application ${applicationId}`);

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

    // Iterated from ARTIFACT_KINDS, the same list `retryExport` computes its missing set from,
    // so the two can never drift into disagreeing about what a complete export is.
    for (const kind of ARTIFACT_KINDS) {
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
    const application = await this.findOwned(userId, applicationId);

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
  }

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
    return facts.map((fact) => ({
      factId: fact.factId,
      text: fact.text,
      kind: fact.kind,
      // Carried through so a render stays reproducible after the master headings change.
      section: fact.section,
      title: fact.title,
      org: fact.org,
      period: fact.period,
    }));
  }

  private toView(render: CvRenderEntity): RenderView {
    // Coalesced: a render just returned from save() carries no `confirmedOverreach` until the
    // column default is read back, and a first render has no decisions by definition. Reading
    // it raw threw inside decidedBulletIds and took the whole generate() call down with it.
    const decided = decidedBulletIds(render.confirmedOverreach ?? [], render.provenance.bullets);
    return {
      render,
      // `bulletId` is projected on rather than read raw: a render stored before the field
      // existed carries none, and the client cannot post a confirm-or-drop decision without
      // one. Derived through the same helper the service resolves with, so the id the UI
      // sends back is guaranteed to match.
      // Already-decided bullets are excluded, not just non-supported ones. A confirmed
      // bullet keeps `verdict: 'overreach'` forever - the decision lives in
      // `confirmedOverreach`, not on the bullet - so filtering on verdict alone kept
      // offering the user a decision they had already made, and every press minted another
      // revision. This is the same resolution the approval gate uses.
      needsConfirmation: render.provenance.bullets
        .filter((b) => b.verdict !== 'supported')
        .filter((b) => !decided.has(bulletIdOf(b)))
        .map((b) => ({ ...b, bulletId: bulletIdOf(b) })),
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
