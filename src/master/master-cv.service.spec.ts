import { Test } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CvFactEntity } from './entities/cv-fact.entity';
import { CvMasterEntity } from './entities/cv-master.entity';
import { CvProfileEntity } from './entities/cv-profile.entity';
import { FactExtractorService } from './fact-extractor.service';
import { ExtractedFact } from './fact-identity';
import { MasterCvService, StaleFactsError, hashMarkdown } from './master-cv.service';

const TEST_DSN = process.env.CV_TEST_DATABASE_URL;
const describeDb = TEST_DSN ? describe : describe.skip;

const fact = (text: string, position: number): ExtractedFact => ({
  kind: 'achievement',
  text,
  payload: {},
  metric: null,
  position,
});

describe('MasterCvService.assertFactsFresh', () => {
  const service = new MasterCvService(null as never, null as never);

  it('raises when stored facts do not match the stored markdown', () => {
    const master = { markdown: '# changed', factsExtractedFromMarkdownSha: hashMarkdown('# original') };

    // Drift must raise, never be silently tolerated: this is the frozen-table failure class.
    expect(() => service.assertFactsFresh(master as never)).toThrow(StaleFactsError);
  });

  it('does not raise when facts match the markdown', () => {
    const markdown = '# cv';
    const master = { markdown, factsExtractedFromMarkdownSha: hashMarkdown(markdown) };

    expect(() => service.assertFactsFresh(master as never)).not.toThrow();
  });
});

describeDb('MasterCvService', () => {
  let service: MasterCvService;
  let dataSource: DataSource;
  let extracted: ExtractedFact[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: TEST_DSN,
          entities: [CvProfileEntity, CvMasterEntity, CvFactEntity],
          synchronize: true,
          dropSchema: true,
        }),
        TypeOrmModule.forFeature([CvProfileEntity, CvMasterEntity, CvFactEntity]),
      ],
      providers: [
        MasterCvService,
        { provide: FactExtractorService, useValue: { extract: jest.fn(async () => extracted) } },
      ],
    }).compile();

    service = moduleRef.get(MasterCvService);
    dataSource = moduleRef.get(getDataSourceToken());
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    extracted = [fact('Cut churn 23%', 0)];
    await dataSource.query('TRUNCATE "cv_fact", "cv_master", "cv_profile" CASCADE');
  });

  it('stores the sha of the markdown the facts came from', async () => {
    const { master } = await service.save('u1', '# CV\n- Cut churn 23%', 'paste');

    expect(master.factsExtractedFromMarkdownSha).toBe(hashMarkdown('# CV\n- Cut churn 23%'));
  });

  it('creates a new version rather than mutating the current one', async () => {
    const first = await service.save('u1', '# v1', 'paste');
    extracted = [fact('Led migration', 0)];
    const second = await service.save('u1', '# v2', 'paste');

    expect(first.master.version).toBe(1);
    expect(second.master.version).toBe(2);

    const versions = await dataSource.getRepository(CvMasterEntity).find({ where: { userId: 'u1' } });
    expect(versions.filter((v) => v.isCurrent)).toHaveLength(1);
    expect(versions.find((v) => v.isCurrent)?.version).toBe(2);
  });

  it('reports which facts were added, removed, and kept', async () => {
    extracted = [fact('a', 0), fact('b', 1), fact('c', 2)];
    await service.save('u1', '# v1', 'paste');

    extracted = [fact('a', 0), fact('b-edited', 1), fact('c', 2)];
    const second = await service.save('u1', '# v2', 'paste');

    expect(second.factDiff.kept).toBe(2);
    expect(second.factDiff.added.map((f) => f.text)).toEqual(['b-edited']);
    expect(second.factDiff.removed.map((f) => f.text)).toEqual(['b']);
  });

  it('keeps factId stable for unchanged bullets across a save', async () => {
    extracted = [fact('a', 0), fact('b', 1)];
    const first = await service.save('u1', '# v1', 'paste');
    const factIdOfA = first.factDiff.added.find((f) => f.text === 'a')?.id;

    extracted = [fact('a', 0), fact('b-edited', 1)];
    const second = await service.save('u1', '# v2', 'paste');

    const factsNow = await dataSource.getRepository(CvFactEntity).find({ where: { masterId: second.master.id } });
    // The row id differs per version; factId is what provenance cites and must survive.
    expect(factsNow.find((f) => f.text === 'a')?.factId).toBe(factIdOfA);
    expect(factsNow.find((f) => f.text === 'b-edited')?.factId).not.toBe(factIdOfA);
  });

  it('gives a fact a new row per version while keeping its factId', async () => {
    extracted = [fact('a', 0)];
    const first = await service.save('u1', '# v1', 'paste');
    const second = await service.save('u1', '# v2', 'paste');

    const rows = await dataSource
      .getRepository(CvFactEntity)
      .find({ where: [{ masterId: first.master.id }, { masterId: second.master.id }] });
    const forA = rows.filter((r) => r.text === 'a');

    expect(forA).toHaveLength(2);
    expect(new Set(forA.map((r) => r.id)).size).toBe(2);
    expect(new Set(forA.map((r) => r.factId)).size).toBe(1);
    expect(forA.map((r) => r.masterId).sort()).toEqual([first.master.id, second.master.id].sort());
  });

  it('returns null for a user with no master CV rather than an empty master', async () => {
    await expect(service.getCurrent('nobody')).resolves.toBeNull();
  });

  it('returns the current master with its facts', async () => {
    await service.save('u1', '# CV', 'paste');

    const current = await service.getCurrent('u1');

    expect(current?.master.version).toBe(1);
    expect(current?.facts).toHaveLength(1);
  });

  it('raises on read when the stored facts have drifted from the markdown', async () => {
    const { master } = await service.save('u1', '# CV', 'paste');
    await dataSource.query('UPDATE "cv_master" SET markdown = $2 WHERE id = $1', [master.id, '# tampered']);

    await expect(service.getCurrent('u1')).rejects.toThrow(StaleFactsError);
  });

  it('creates the profile row on first save', async () => {
    await service.save('u1', '# CV', 'paste');

    const profile = await dataSource.getRepository(CvProfileEntity).findOne({ where: { userId: 'u1' } });
    expect(profile).not.toBeNull();
  });

  it('records the source type and reference', async () => {
    const { master } = await service.save('u1', '# CV', 'gdocs', 'https://docs.google.com/document/d/abc/edit');

    expect(master.sourceType).toBe('gdocs');
    expect(master.sourceRef).toBe('https://docs.google.com/document/d/abc/edit');
  });

  it('does not leave a half-written version when extraction fails', async () => {
    await service.save('u1', '# v1', 'paste');
    const extractor = (service as unknown as { extractor: { extract: jest.Mock } }).extractor;
    extractor.extract.mockRejectedValueOnce(new Error('model exploded'));

    await expect(service.save('u1', '# v2', 'paste')).rejects.toThrow('model exploded');

    const versions = await dataSource.getRepository(CvMasterEntity).find({ where: { userId: 'u1' } });
    expect(versions).toHaveLength(1);
    expect(versions[0].isCurrent).toBe(true);
  });
});
