import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { CvApplicationEntity } from '../applications/entities/cv-application.entity';
import { CvArtifactEntity } from '../applications/entities/cv-artifact.entity';
import { CvChatEntity } from '../applications/entities/cv-chat.entity';
import { CvRenderEntity } from '../applications/entities/cv-render.entity';
import { CvSupplementEntity } from '../applications/entities/cv-supplement.entity';
import { CvJobEntity } from '../jobs/entities/cv-job.entity';
import { CvFactEntity } from '../master/entities/cv-fact.entity';
import { CvMasterEntity } from '../master/entities/cv-master.entity';
import { CvProfileEntity } from '../master/entities/cv-profile.entity';
import { MinioService } from '../storage/minio.service';

export interface DeletedRowCounts {
  artifacts: number;
  chats: number;
  renders: number;
  supplements: number;
  applications: number;
  jobs: number;
  facts: number;
  masters: number;
  profile: number;
}

export interface AccountDeletionReport {
  userId: string;
  deletedObjectKeys: string[];
  deletedObjects: number;
  deletedRows: DeletedRowCounts;
}

/**
 * Hard-delete cascade (spec §9): `user_id → cv_* → MinIO objects`.
 *
 * Two ordering rules make it recoverable rather than merely fast:
 *   1. MinIO objects are deleted and VERIFIED gone BEFORE any row is removed. A row that still
 *      points at a deleted object is recoverable (re-run the cascade); a row deleted while its
 *      object lingers is an orphan with no reference left to find it by — the unrecoverable
 *      direction. Verification (never fire-and-forget) is delegated to `MinioService.deleteObject`.
 *   2. The row deletes run inside ONE database transaction, so the DB half is all-or-nothing.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(CvApplicationEntity) private readonly applications: Repository<CvApplicationEntity>,
    @InjectRepository(CvRenderEntity) private readonly renders: Repository<CvRenderEntity>,
    @InjectRepository(CvSupplementEntity) private readonly supplements: Repository<CvSupplementEntity>,
    @InjectRepository(CvArtifactEntity) private readonly artifacts: Repository<CvArtifactEntity>,
    @InjectRepository(CvMasterEntity) private readonly masters: Repository<CvMasterEntity>,
    private readonly storage: MinioService,
  ) {}

  async deleteAccount(userId: string): Promise<AccountDeletionReport> {
    const keys = await this.collectObjectKeys(userId);

    // MinIO first, each verified. Abort the whole operation if any object cannot be confirmed
    // deleted — better a retryable orphan-with-reference than an unreferenced orphan.
    for (const key of keys) {
      await this.storage.deleteObject(key);
    }

    const deletedRows = await this.dataSource.transaction(async (manager) => {
      const appIds = (
        await manager.find(CvApplicationEntity, { where: { userId }, select: ['id'] })
      ).map((a) => a.id);
      const renderIds = appIds.length
        ? (await manager.find(CvRenderEntity, { where: { applicationId: In(appIds) }, select: ['id'] })).map((r) => r.id)
        : [];
      const supplementIds = appIds.length
        ? (await manager.find(CvSupplementEntity, { where: { applicationId: In(appIds) }, select: ['id'] })).map((s) => s.id)
        : [];
      const masterIds = (
        await manager.find(CvMasterEntity, { where: { userId }, select: ['id'] })
      ).map((m) => m.id);

      const counts: DeletedRowCounts = {
        artifacts: 0,
        chats: 0,
        renders: 0,
        supplements: 0,
        applications: 0,
        jobs: 0,
        facts: 0,
        masters: 0,
        profile: 0,
      };

      if (renderIds.length) {
        counts.artifacts += (await manager.delete(CvArtifactEntity, { renderId: In(renderIds) })).affected ?? 0;
      }
      if (supplementIds.length) {
        counts.artifacts += (await manager.delete(CvArtifactEntity, { supplementId: In(supplementIds) })).affected ?? 0;
      }
      if (appIds.length) {
        counts.chats = (await manager.delete(CvChatEntity, { applicationId: In(appIds) })).affected ?? 0;
        counts.renders = (await manager.delete(CvRenderEntity, { applicationId: In(appIds) })).affected ?? 0;
        counts.supplements = (await manager.delete(CvSupplementEntity, { applicationId: In(appIds) })).affected ?? 0;
      }
      counts.applications = (await manager.delete(CvApplicationEntity, { userId })).affected ?? 0;
      counts.jobs = (await manager.delete(CvJobEntity, { userId })).affected ?? 0;
      if (masterIds.length) {
        counts.facts = (await manager.delete(CvFactEntity, { masterId: In(masterIds) })).affected ?? 0;
      }
      counts.masters = (await manager.delete(CvMasterEntity, { userId })).affected ?? 0;
      counts.profile = (await manager.delete(CvProfileEntity, { userId })).affected ?? 0;

      return counts;
    });

    this.logger.log(
      `GDPR hard-delete user=${userId} objects=${keys.length} rows=${JSON.stringify(deletedRows)}`,
    );

    return { userId, deletedObjectKeys: keys, deletedObjects: keys.length, deletedRows };
  }

  /**
   * Every MinIO object owned by the user: rendered/supplement artifacts, and the original
   * uploaded documents whose keys are stored on `cv_master.sourceRef` for `upload`/`linkedin`
   * masters (a `gdocs` source_ref is a URL, not an object key, and a `paste` has none).
   */
  private async collectObjectKeys(userId: string): Promise<string[]> {
    const appIds = (
      await this.applications.find({ where: { userId }, select: ['id'] })
    ).map((a) => a.id);
    const renderIds = appIds.length
      ? (await this.renders.find({ where: { applicationId: In(appIds) }, select: ['id'] })).map((r) => r.id)
      : [];
    const supplementIds = appIds.length
      ? (await this.supplements.find({ where: { applicationId: In(appIds) }, select: ['id'] })).map((s) => s.id)
      : [];

    const artifactRows: CvArtifactEntity[] = [];
    if (renderIds.length) {
      artifactRows.push(...(await this.artifacts.find({ where: { renderId: In(renderIds) } })));
    }
    if (supplementIds.length) {
      artifactRows.push(...(await this.artifacts.find({ where: { supplementId: In(supplementIds) } })));
    }

    const uploadMasters = await this.masters.find({
      where: [
        { userId, sourceType: 'upload' },
        { userId, sourceType: 'linkedin' },
      ],
    });

    const keys = new Set<string>();
    for (const artifact of artifactRows) {
      keys.add(artifact.minioKey);
    }
    for (const master of uploadMasters) {
      if (master.sourceRef) {
        keys.add(master.sourceRef);
      }
    }
    return [...keys];
  }
}
