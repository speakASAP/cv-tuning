import { parseBenchmarkFixture, loadBenchmarkFixtures } from './benchmark-fixtures';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const validFixtureJson = (label: string) =>
  JSON.stringify({
    label,
    facts: [
      { factId: 'f1', text: 'Synthetic role at Example Corp, 2019-2024', kind: 'role' },
      { factId: 'f2', text: 'Synthetic achievement bullet', kind: 'achievement', section: 'Experience' },
    ],
    requirements: [{ text: 'Synthetic requirement', kind: 'must' }],
    jobTitle: 'Example Role',
    company: 'Example Co',
  });

describe('parseBenchmarkFixture', () => {
  it('parses a valid fixture and defaults optional fields', () => {
    const fixture = parseBenchmarkFixture(validFixtureJson('candidate-a'), 'candidate-a.json');

    expect(fixture.source).toBe('candidate-a.json');
    expect(fixture.label).toBe('candidate-a');
    expect(fixture.facts).toHaveLength(2);
    expect(fixture.facts[0]).toEqual({
      factId: 'f1',
      text: 'Synthetic role at Example Corp, 2019-2024',
      kind: 'role',
      section: null,
      title: null,
      org: null,
      period: null,
    });
    expect(fixture.facts[1].section).toBe('Experience');
    expect(fixture.requirements).toEqual([{ text: 'Synthetic requirement', kind: 'must' }]);
    expect(fixture.language).toBe('en');
    expect(fixture.styleExemplars).toEqual([]);
  });

  it('rejects non-JSON content with the file name in the error', () => {
    expect(() => parseBenchmarkFixture('not json', 'broken.json')).toThrow(/broken\.json/);
  });

  it('rejects a fixture missing a label', () => {
    const body = JSON.parse(validFixtureJson('x'));
    delete body.label;
    expect(() => parseBenchmarkFixture(JSON.stringify(body), 'no-label.json')).toThrow(/label/);
  });

  it('rejects a fixture with an empty facts array', () => {
    const body = JSON.parse(validFixtureJson('x'));
    body.facts = [];
    expect(() => parseBenchmarkFixture(JSON.stringify(body), 'no-facts.json')).toThrow(/facts/);
  });

  it('rejects a fact missing factId', () => {
    const body = JSON.parse(validFixtureJson('x'));
    delete body.facts[0].factId;
    expect(() => parseBenchmarkFixture(JSON.stringify(body), 'bad-fact.json')).toThrow(/factId/);
  });

  it('rejects a requirement with an invalid kind', () => {
    const body = JSON.parse(validFixtureJson('x'));
    body.requirements = [{ text: 'x', kind: 'wish' }];
    expect(() => parseBenchmarkFixture(JSON.stringify(body), 'bad-req.json')).toThrow(/kind/);
  });
});

describe('loadBenchmarkFixtures', () => {
  const dir = join(__dirname, '__fixtures_test_tmp__');

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads exactly the required count of fixture files, sorted by filename', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2-b.json'), validFixtureJson('candidate-b'));
    writeFileSync(join(dir, '1-a.json'), validFixtureJson('candidate-a'));

    const fixtures = loadBenchmarkFixtures(dir, 2);

    expect(fixtures.map((f) => f.label)).toEqual(['candidate-a', 'candidate-b']);
  });

  it('throws when the directory has fewer files than required', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'only-one.json'), validFixtureJson('candidate-a'));

    expect(() => loadBenchmarkFixtures(dir, 5)).toThrow(/expected exactly 5/);
  });

  it('throws when the directory has more files than required', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.json'), validFixtureJson('candidate-a'));
    writeFileSync(join(dir, 'b.json'), validFixtureJson('candidate-b'));

    expect(() => loadBenchmarkFixtures(dir, 1)).toThrow(/expected exactly 1/);
  });

  it('throws a descriptive error when the directory does not exist', () => {
    expect(() => loadBenchmarkFixtures(join(dir, 'missing'), 5)).toThrow(/could not read/);
  });

  it('ignores non-json files when counting', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.json'), validFixtureJson('candidate-a'));
    writeFileSync(join(dir, 'README.md'), '# not a fixture');

    const fixtures = loadBenchmarkFixtures(dir, 1);
    expect(fixtures).toHaveLength(1);
  });
});
