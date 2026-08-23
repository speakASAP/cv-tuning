import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MasterCvService } from '../master/master-cv.service';
import { CvJobEntity } from './entities/cv-job.entity';
import { FitReport, FitScorerService } from './fit-scorer.service';
import { JobFetcherService } from './job-fetcher.service';
import { JobParserService } from './job-parser.service';
import { FetchStatus, JobSource } from './job.types';

/** Third-party posting text is retained for 90 days; Phase 7 turns this into a sweep. */
const RAW_TEXT_TTL_DAYS = 90;

export interface JobView {
  job: CvJobEntity;
  /** Present whenever the posting could not be read, so the UI can offer the paste box. */
  pasteFallback?: { needed: true; reason: string };
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectRepository(CvJobEntity) private readonly jobs: Repository<CvJobEntity>,
    private readonly fetcher: JobFetcherService,
    private readonly parser: JobParserService,
    private readonly scorer: FitScorerService,
    private readonly master: MasterCvService,
  ) {}

  async submitUrl(userId: string, url: string): Promise<JobView> {
    const result = await this.fetcher.fetch(url);

    const job = this.jobs.create({
      userId,
      url,
      source: 'fetch' as JobSource,
      rawText: result.text || null,
      fetchStatus: result.status,
      fetchReason: result.reason ?? null,
      fetchedAt: new Date(),
      expiresAt: this.expiryDate(),
    });

    if (result.status !== 'ok') {
      // A blocked or thin fetch is a successful request with an actionable status, not an
      // error: the user can paste the text and carry on.
      const saved = await this.jobs.save(job);
      this.logger.warn(`job ${saved.id} fetch ${result.status} for ${url}: ${result.reason ?? 'no reason given'}`);
      return this.withFallback(saved);
    }

    return { job: await this.parseInto(job, result.text) };
  }

  async submitText(userId: string, text: string, url?: string): Promise<JobView> {
    const job = this.jobs.create({
      userId,
      url: url ?? null,
      source: 'paste' as JobSource,
      rawText: text,
      fetchStatus: 'ok' as FetchStatus,
      fetchedAt: new Date(),
      expiresAt: this.expiryDate(),
    });

    return { job: await this.parseInto(job, text) };
  }

  /** Supplies the text for a job whose fetch was blocked, then parses it. */
  async supplyText(userId: string, jobId: string, text: string): Promise<JobView> {
    const job = await this.findOwned(userId, jobId);

    job.source = 'paste';
    job.rawText = text;
    job.fetchStatus = 'ok';
    job.fetchReason = null;
    job.expiresAt = this.expiryDate();

    return { job: await this.parseInto(job, text) };
  }

  async list(userId: string): Promise<CvJobEntity[]> {
    return this.jobs.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  async get(userId: string, jobId: string): Promise<JobView> {
    return this.withFallback(await this.findOwned(userId, jobId));
  }

  async score(userId: string, jobId: string): Promise<FitReport> {
    const job = await this.findOwned(userId, jobId);

    if (!job.parsed) {
      // Distinguishes "we could not read the posting" from "something broke".
      throw new ConflictException(
        `job ${jobId} has no parsed requirements (fetch status: ${job.fetchStatus}); supply the posting text first`,
      );
    }

    const current = await this.master.getCurrent(userId);
    if (!current) {
      throw new ConflictException('you need a master CV before a job can be scored');
    }

    const report = await this.scorer.score(job.parsed.requirements, current.facts);
    this.logger.log(
      `scored job ${jobId} for user ${userId}: ${report.score}% ` +
        `(${report.matches.length} met, ${report.gaps.length} gaps)`,
    );
    return report;
  }

  private async parseInto(job: CvJobEntity, text: string): Promise<CvJobEntity> {
    const parsed = await this.parser.parse(text);

    job.parsed = parsed;
    job.title = parsed.title;
    job.company = parsed.company;
    job.language = parsed.language;

    const saved = await this.jobs.save(job);
    this.logger.log(`job ${saved.id} parsed: ${parsed.requirements.length} requirements, language=${parsed.language}`);
    return saved;
  }

  private async findOwned(userId: string, jobId: string): Promise<CvJobEntity> {
    // Scoped by userId so another tenant's job is indistinguishable from a missing one.
    const job = await this.jobs.findOne({ where: { id: jobId, userId } });
    if (!job) {
      throw new NotFoundException(`job ${jobId} not found`);
    }
    return job;
  }

  private withFallback(job: CvJobEntity): JobView {
    if (job.fetchStatus === 'ok') {
      return { job };
    }
    return {
      job,
      pasteFallback: {
        needed: true,
        reason:
          job.fetchReason ??
          'the posting could not be read automatically; paste its text to continue',
      },
    };
  }

  private expiryDate(): Date {
    return new Date(Date.now() + RAW_TEXT_TTL_DAYS * 24 * 60 * 60 * 1000);
  }
}
