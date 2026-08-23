import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { CvFactEntity } from './entities/cv-fact.entity';
import { CvMasterEntity } from './entities/cv-master.entity';
import { CvProfileEntity } from './entities/cv-profile.entity';
import { FactExtractorService } from './fact-extractor.service';
import { MatchedFact, StoredFact, matchFactIds } from './fact-identity';
import { SourceType } from './master.types';

export class StaleFactsError extends Error {
  constructor(masterId: string) {
    super(
      `master CV ${masterId} has facts extracted from different markdown than it now stores; ` +
        'the fact graph is stale and must be re-extracted before it can be used',
    );
    this.name = 'StaleFactsError';
  }
}

export interface FactDiff {
  added: MatchedFact[];
  removed: CvFactEntity[];
  kept: number;
}

export interface SaveResult {
  master: CvMasterEntity;
  factDiff: FactDiff;
}

export interface CurrentMaster {
  master: CvMasterEntity;
  facts: CvFactEntity[];
}

/** Hash of the full markdown document, used to detect fact/markdown drift. */
export function hashMarkdown(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

@Injectable()
export class MasterCvService {
  private readonly logger = new Logger(MasterCvService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly extractor: FactExtractorService,
  ) {}

  /**
   * Markdown is the source of truth; facts are a derived projection re-extracted on every
   * save. Facts are never written back into the markdown.
   */
  async save(
    userId: string,
    markdown: string,
    sourceType: SourceType,
    sourceRef?: string,
  ): Promise<SaveResult> {
    // Extraction happens BEFORE the transaction: it is slow and can fail, and a failed
    // extraction must leave the existing version untouched rather than half-replaced.
    const extracted = await this.extractor.extract(markdown);

    return this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .insert()
        .into(CvProfileEntity)
        .values({ userId })
        .orIgnore()
        .execute();

      const previous = await manager.findOne(CvMasterEntity, { where: { userId, isCurrent: true } });
      const previousFacts = previous
        ? await manager.find(CvFactEntity, { where: { masterId: previous.id } })
        : [];

      const storedFacts: StoredFact[] = previousFacts.map((row) => ({
        id: row.factId,
        contentHash: row.contentHash,
        position: row.position,
      }));
      const matched = matchFactIds(storedFacts, extracted);

      const keptFactIds = new Set(matched.filter((f) => !f.isNew).map((f) => f.id));
      const factDiff: FactDiff = {
        added: matched.filter((f) => f.isNew),
        removed: previousFacts.filter((row) => !keptFactIds.has(row.factId)),
        kept: keptFactIds.size,
      };

      if (previous) {
        // Clear the old flag first: a partial unique index allows only one current row.
        await manager.update(CvMasterEntity, { id: previous.id }, { isCurrent: false });
      }

      const master = await manager.save(
        manager.create(CvMasterEntity, {
          userId,
          version: (previous?.version ?? 0) + 1,
          sourceType,
          sourceRef: sourceRef ?? null,
          markdown,
          factsExtractedFromMarkdownSha: hashMarkdown(markdown),
          isCurrent: true,
        }),
      );

      if (matched.length > 0) {
        await manager.insert(
          CvFactEntity,
          // TypeORM's DeepPartial cannot express payload's nested index signature.
          matched.map((f) => ({
            // A new row per version; f.id is the STABLE cross-version identity.
            factId: f.id,
            masterId: master.id,
            kind: f.kind,
            text: f.text,
            payload: f.payload,
            metric: f.metric,
            contentHash: f.contentHash,
            position: f.position,
          })) as never,
        );
      }

      this.logger.log(
        `master saved user=${userId} version=${master.version} ` +
          `facts kept=${factDiff.kept} added=${factDiff.added.length} removed=${factDiff.removed.length}`,
      );

      return { master, factDiff };
    });
  }

  async getCurrent(userId: string): Promise<CurrentMaster | null> {
    const master = await this.dataSource
      .getRepository(CvMasterEntity)
      .findOne({ where: { userId, isCurrent: true } });

    if (!master) {
      // A user with no CV and a failed lookup are different outcomes; null means the
      // former only, and every read path below raises rather than returning empty.
      return null;
    }

    this.assertFactsFresh(master);

    const facts = await this.dataSource
      .getRepository(CvFactEntity)
      .find({ where: { masterId: master.id }, order: { position: 'ASC' } });

    return { master, facts };
  }

  /**
   * If the stored markdown no longer hashes to the value its facts were extracted from,
   * every downstream stage would silently tailor against an outdated fact graph. That is
   * the frozen-table failure class, so it raises instead.
   */
  assertFactsFresh(master: Pick<CvMasterEntity, 'markdown' | 'factsExtractedFromMarkdownSha'>): void {
    const actual = hashMarkdown(master.markdown);
    if (actual !== master.factsExtractedFromMarkdownSha) {
      const id = (master as CvMasterEntity).id ?? '<unknown>';
      this.logger.error(
        `stale fact graph for master ${id}: markdown hashes to ${actual.slice(0, 12)} but facts came from ` +
          `${master.factsExtractedFromMarkdownSha.slice(0, 12)}`,
      );
      throw new StaleFactsError(id);
    }
  }
}
