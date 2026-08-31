import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Inject,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const context = body && typeof body === 'object' ? body.context : undefined;
    const applicationId = context?.applicationId;
    if (typeof applicationId !== 'string' || applicationId.length === 0) {
      throw new BadRequestException('nudge callback carries no context.applicationId');
    }
    if (!UUID.test(applicationId)) {
      // `cv_application.id` is a uuid column, so a malformed id reaches Postgres as a cast
      // error and surfaces as a bare 500 — "Internal server error" for what is plainly a
      // malformed callback, and BPCP then retries it three times as a transient failure.
      throw new BadRequestException(
        `nudge callback carries a context.applicationId that is not a uuid: "${applicationId}"`,
      );
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
