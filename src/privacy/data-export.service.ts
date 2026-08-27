import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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

/**
 * Artifact metadata plus, where readable, the object's own bytes (base64). `reference` is always
 * the MinIO key so the artifact is identifiable even when its bytes could not be read; `data` is
 * null with an explicit `dataError` in that case rather than silently omitting the file.
 */
export interface ExportedArtifact {
  id: string;
  renderId: string | null;
  supplementId: string | null;
  kind: string;
  reference: string;
  sha256: string;
  byteSize: number;
  createdAt: Date;
  data: string | null;
  dataError?: string;
}

export interface UserDataExport {
  exportedAt: string;
  userId: string;
  profile: CvProfileEntity | null;
  masters: CvMasterEntity[];
  facts: CvFactEntity[];
  jobs: CvJobEntity[];
  applications: CvApplicationEntity[];
  renders: CvRenderEntity[];
  supplements: CvSupplementEntity[];
  chats: CvChatEntity[];
  artifacts: ExportedArtifact[];
}

/**
 * Right-to-portability export (spec §9): the full fact graph, every render and supplement, and the
 * artifacts — both their references and, where readable, their bytes.
 */
@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(
    @InjectRepository(CvProfileEntity) private readonly profiles: Repository<CvProfileEntity>,
    @InjectRepository(CvMasterEntity) private readonly masters: Repository<CvMasterEntity>,
    @InjectRepository(CvFactEntity) private readonly facts: Repository<CvFactEntity>,
    @InjectRepository(CvJobEntity) private readonly jobs: Repository<CvJobEntity>,
    @InjectRepository(CvApplicationEntity) private readonly applications: Repository<CvApplicationEntity>,
    @InjectRepository(CvRenderEntity) private readonly renders: Repository<CvRenderEntity>,
    @InjectRepository(CvSupplementEntity) private readonly supplements: Repository<CvSupplementEntity>,
    @InjectRepository(CvChatEntity) private readonly chats: Repository<CvChatEntity>,
    @InjectRepository(CvArtifactEntity) private readonly artifacts: Repository<CvArtifactEntity>,
    private readonly storage: MinioService,
  ) {}

  async export(userId: string): Promise<UserDataExport> {
    const profile = await this.profiles.findOne({ where: { userId } });

    const masters = await this.masters.find({ where: { userId }, order: { version: 'ASC' } });
    const masterIds = masters.map((m) => m.id);
    const facts = masterIds.length
      ? await this.facts.find({ where: { masterId: In(masterIds) }, order: { position: 'ASC' } })
      : [];

    const jobs = await this.jobs.find({ where: { userId }, order: { createdAt: 'ASC' } });

    const applications = await this.applications.find({ where: { userId }, order: { createdAt: 'ASC' } });
    const appIds = applications.map((a) => a.id);

    const renders = appIds.length
      ? await this.renders.find({ where: { applicationId: In(appIds) }, order: { revisionNo: 'ASC' } })
      : [];
    const supplements = appIds.length
      ? await this.supplements.find({ where: { applicationId: In(appIds) }, order: { revisionNo: 'ASC' } })
      : [];
    const chats = appIds.length
      ? await this.chats.find({ where: { applicationId: In(appIds) }, order: { createdAt: 'ASC' } })
      : [];

    const renderIds = renders.map((r) => r.id);
    const supplementIds = supplements.map((s) => s.id);
    const artifactRows: CvArtifactEntity[] = [];
    if (renderIds.length) {
      artifactRows.push(...(await this.artifacts.find({ where: { renderId: In(renderIds) } })));
    }
    if (supplementIds.length) {
      artifactRows.push(...(await this.artifacts.find({ where: { supplementId: In(supplementIds) } })));
    }

    const artifacts = await Promise.all(artifactRows.map((a) => this.exportArtifact(a)));

    return {
      exportedAt: new Date().toISOString(),
      userId,
      profile,
      masters,
      facts,
      jobs,
      applications,
      renders,
      supplements,
      chats,
      artifacts,
    };
  }

  private async exportArtifact(artifact: CvArtifactEntity): Promise<ExportedArtifact> {
    const meta = {
      id: artifact.id,
      renderId: artifact.renderId,
      supplementId: artifact.supplementId,
      kind: artifact.kind,
      reference: artifact.minioKey,
      sha256: artifact.sha256,
      byteSize: artifact.byteSize,
      createdAt: artifact.createdAt,
    };

    try {
      const content = await this.storage.getObject(artifact.minioKey);
      return { ...meta, data: content.toString('base64') };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A portability export should carry the actual bytes, but one unreadable object must not
      // sink the whole export. The failure is surfaced per-artifact, never silently dropped.
      this.logger.error(`export: could not read artifact ${artifact.id} object ${artifact.minioKey}: ${message}`);
      return { ...meta, data: null, dataError: message };
    }
  }
}
