import { ContextualFact, StoredFact, hashFactContent, matchFactIds } from './fact-identity';

const stored = (id: string, text: string, position: number): StoredFact => ({
  id,
  contentHash: hashFactContent(text),
  position,
});

const extracted = (text: string, position: number): ContextualFact => ({
  text,
  position,
  kind: 'achievement',
  payload: {},
  metric: null,
  section: null,
  org: null,
  period: null,
});

describe('hashFactContent', () => {
  it('hashes content stably regardless of surrounding whitespace', () => {
    expect(hashFactContent('  Cut churn 23%  ')).toBe(hashFactContent('Cut churn 23%'));
  });

  it('collapses internal whitespace runs', () => {
    expect(hashFactContent('Cut   churn\t23%')).toBe(hashFactContent('Cut churn 23%'));
  });

  it('ignores case', () => {
    expect(hashFactContent('Cut Churn 23%')).toBe(hashFactContent('cut churn 23%'));
  });

  it('distinguishes genuinely different content', () => {
    expect(hashFactContent('Cut churn 23%')).not.toBe(hashFactContent('Cut churn 31%'));
  });
});

describe('derived context is outside fact identity', () => {
  it('keeps a fact id when only its org and period changed', () => {
    // section/org/period are DERIVED from the headings above a fact. If they entered the
    // content hash, re-titling a job heading would orphan every fact under it and break
    // every provenance link a tailored CV already holds.
    const before: ContextualFact = {
      ...extracted('Cut churn 23%', 0),
      section: 'Experience',
      org: 'Acme Corp',
      period: '2019 - 2024',
    };
    const after: ContextualFact = {
      ...extracted('Cut churn 23%', 0),
      section: 'Work History',
      org: 'Acme Corporation GmbH',
      period: '2019 - 2025',
    };

    const stored = [{ id: 'f1', contentHash: hashFactContent(before.text), position: 0 }];
    const matched = matchFactIds(stored, [after]);

    expect(matched[0].id).toBe('f1');
    expect(matched[0].isNew).toBe(false);
  });

  it('carries the derived context through onto the matched fact', () => {
    const fact: ContextualFact = {
      ...extracted('Cut churn 23%', 0),
      section: 'Experience',
      org: 'Acme Corp',
      period: '2019 - 2024',
    };

    const [matched] = matchFactIds([], [fact]);

    expect(matched.org).toBe('Acme Corp');
    expect(matched.period).toBe('2019 - 2024');
    expect(matched.section).toBe('Experience');
  });
});

describe('matchFactIds', () => {
  it('keeps the id of an unchanged fact', () => {
    const matched = matchFactIds([stored('f1', 'Cut churn 23%', 0)], [extracted('Cut churn 23%', 0)]);

    expect(matched[0].id).toBe('f1');
    expect(matched[0].isNew).toBe(false);
  });

  it('keeps the id when a fact moves position but the text is identical', () => {
    const previous = [stored('f1', 'Cut churn 23%', 0), stored('f2', 'Led migration', 1)];
    const matched = matchFactIds(previous, [extracted('Led migration', 0), extracted('Cut churn 23%', 1)]);

    expect(matched.find((f) => f.text === 'Cut churn 23%')?.id).toBe('f1');
    expect(matched.find((f) => f.text === 'Led migration')?.id).toBe('f2');
  });

  it('assigns a new id to edited text', () => {
    const matched = matchFactIds([stored('f1', 'Cut churn 23%', 0)], [extracted('Cut churn 31%', 0)]);

    expect(matched[0].id).not.toBe('f1');
    expect(matched[0].isNew).toBe(true);
  });

  it('does not reuse one stored fact for two identical extracted facts', () => {
    const matched = matchFactIds(
      [stored('f1', 'Mentored juniors', 0)],
      [extracted('Mentored juniors', 0), extracted('Mentored juniors', 1)],
    );

    expect(matched[0].id).toBe('f1');
    expect(matched[1].id).not.toBe('f1');
    expect(matched[1].isNew).toBe(true);
  });

  it('reuses both ids when two identical facts were already stored twice', () => {
    const previous = [stored('f1', 'Mentored juniors', 0), stored('f2', 'Mentored juniors', 1)];
    const matched = matchFactIds(previous, [extracted('Mentored juniors', 0), extracted('Mentored juniors', 1)]);

    expect(new Set(matched.map((f) => f.id))).toEqual(new Set(['f1', 'f2']));
    expect(matched.every((f) => !f.isNew)).toBe(true);
  });

  it('prefers the stored fact at the same position when text is duplicated', () => {
    const previous = [stored('f1', 'Mentored juniors', 0), stored('f2', 'Mentored juniors', 5)];
    const matched = matchFactIds(previous, [extracted('Mentored juniors', 5)]);

    expect(matched[0].id).toBe('f2');
  });

  it('returns an empty list for no extracted facts rather than throwing', () => {
    expect(matchFactIds([stored('f1', 'x', 0)], [])).toEqual([]);
  });

  it('treats every fact as new when nothing was stored before', () => {
    const matched = matchFactIds([], [extracted('Cut churn 23%', 0)]);

    expect(matched[0].isNew).toBe(true);
    expect(matched[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('preserves the extracted order and positions', () => {
    const matched = matchFactIds([], [extracted('a', 0), extracted('b', 1), extracted('c', 2)]);

    expect(matched.map((f) => f.text)).toEqual(['a', 'b', 'c']);
    expect(matched.map((f) => f.position)).toEqual([0, 1, 2]);
  });

  it('never emits duplicate ids', () => {
    const previous = [stored('f1', 'a', 0), stored('f2', 'b', 1)];
    const matched = matchFactIds(previous, [extracted('a', 0), extracted('a', 1), extracted('b', 2)]);

    expect(new Set(matched.map((f) => f.id)).size).toBe(3);
  });
});
