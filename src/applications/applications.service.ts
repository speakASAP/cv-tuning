import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CvFactEntity } from '../master/entities/cv-fact.entity';
import { MasterCvService } from '../master/master-cv.service';
import { JobsService } from '../jobs/jobs.service';
import { scoreAiTell } from './ai-tell';
import { ApplicationState, FactSnapshot, RenderProvenance, TailoredBullet } from './application.types';
import { diffLines, DiffHunk } from './diff';
import { CvApplicationEntity } from './entities/cv-application.entity';
import { CvRenderEntity } from './entities/cv-render.entity';
import { EntailService } from './entail.service';
import { TailorService } from './tailor.service';

const REQUESTED_TIER = 'smart';

/** How many of the user's own sentences are carried in as style exemplars (§6.1). */
const STYLE_EXEMPLAR_COUNT = 5;

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

      const markdown = validated.bullets.map((b) => `- ${b.text}`).join('\n');
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
