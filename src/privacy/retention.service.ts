import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { CvArtifactEntity } from '../applications/entities/cv-artifact.entity';
import { CvRenderEntity } from '../applications/entities/cv-render.entity';
import { CvSupplementEntity } from '../applications/entities/cv-supplement.entity';
import { CvJobEntity } from '../jobs/entities/cv-job.entity';
import { MinioService } from '../storage/minio.service';

export interface RetentionReport {
  rawTextExpired: number;
  artifactsPurged: number;
  purgedKeys: string[];
}

/**
 * Retention cleanup (spec §9). Two independent operations, both idempotent so a re-run after a
 * partial failure is safe. No scheduler lives here — timing belongs to BPCP/ops (AGENTS.md); this
 * exposes the WHAT and leaves the WHEN to a caller.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @InjectRepository(CvJobEntity) private readonly jobs: Repository<CvJobEntity>,
    @InjectRepository(CvArtifactEntity) private readonly artifacts: Repository<CvArtifactEntity>,
    @InjectRepository(CvRenderEntity) private readonly renders: Repository<CvRenderEntity>,
    @InjectRepository(CvSupplementEntity) private readonly supplements: Repository<CvSupplementEntity>,
    private readonly storage: MinioService,
  ) {}

  async run(now = new Date()): Promise<RetentionReport> {
    const { expired } = await this.expireJobRawText(now);
    const { purged, keys } = await this.purgeOrphanedArtifacts();
    return { rawTextExpired: expired, artifactsPurged: purged, purgedKeys: keys };
  }

  /**
   * Null out `cv_job.raw_text` once it is past `expires_at`. The third-party posting text is the
   * regulated content; the derived `parsed` requirements and `screeningQuestions` are left in
   * place, so an application built on the posting stays reproducible after the raw text expires.
   * `LessThanOrEqual` excludes rows whose `expires_at` is null, so a job with no expiry set is
   * never touched.
   */
  async expireJobRawText(now = new Date()): Promise<{ expired: number }> {
    const due = await this.jobs.find({
      where: { expiresAt: LessThanOrEqual(now), rawText: Not(IsNull()) },
    });
    if (due.length === 0) {
      return { expired: 0 };
    }
    for (const job of due) {
      job.rawText = null;
    }
    await this.jobs.save(due);
    this.logger.log(`retention: expired raw_text on ${due.length} job(s)`);
    return { expired: due.length };
  }

  /**
   * Delete artifacts whose parent render or supplement no longer exists, and the MinIO object
   * with them. Exactly one of `renderId`/`supplementId` is set on a healthy row; an artifact
   * pointing at neither is also treated as orphaned. Object is deleted (and verified) BEFORE the
   * row, the same recoverable ordering the hard-delete cascade uses.
   */
  async purgeOrphanedArtifacts(): Promise<{ purged: number; keys: string[] }> {
    const artifacts = await this.artifacts.find();
    if (artifacts.length === 0) {
      return { purged: 0, keys: [] };
    }

    const liveRenderIds = new Set((await this.renders.find({ select: ['id'] })).map((r) => r.id));
    const liveSupplementIds = new Set((await this.supplements.find({ select: ['id'] })).map((s) => s.id));

    const orphans = artifacts.filter((a) => {
      const renderMissing = a.renderId != null && !liveRenderIds.has(a.renderId);
      const supplementMissing = a.supplementId != null && !liveSupplementIds.has(a.supplementId);
      const parentless = a.renderId == null && a.supplementId == null;
      return renderMissing || supplementMissing || parentless;
    });

    const keys: string[] = [];
    for (const orphan of orphans) {
      await this.storage.deleteObject(orphan.minioKey);
      await this.artifacts.delete({ id: orphan.id });
      keys.push(orphan.minioKey);
    }

    if (keys.length > 0) {
      this.logger.log(`retention: purged ${keys.length} orphaned artifact(s)`);
    }
    return { purged: keys.length, keys };
  }
}
