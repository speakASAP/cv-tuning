import { diffLines, diffWords } from './diff';

describe('diffWords', () => {
  it('returns a single unchanged part for identical text', () => {
    const parts = diffWords('shipped the parser', 'shipped the parser');

    expect(parts.every((p) => p.type === 'equal')).toBe(true);
    expect(parts.map((p) => p.value).join('')).toBe('shipped the parser');
  });

  it('marks only the changed word', () => {
    const parts = diffWords('cut latency by 40%', 'cut latency by 60%');

    const changed = parts.filter((p) => p.type !== 'equal').map((p) => p.value.trim());
    expect(changed).toEqual(['40%', '60%']);
  });

  it('reconstructs the original from equal + removed parts', () => {
    const before = 'built a service in Go';
    const parts = diffWords(before, 'built a parser in Rust');

    const reconstructed = parts.filter((p) => p.type !== 'added').map((p) => p.value).join('');
    expect(reconstructed).toBe(before);
  });

  it('reconstructs the new text from equal + added parts', () => {
    const after = 'built a parser in Rust';
    const parts = diffWords('built a service in Go', after);

    const reconstructed = parts.filter((p) => p.type !== 'removed').map((p) => p.value).join('');
    expect(reconstructed).toBe(after);
  });

  it('handles insertion at the end', () => {
    const parts = diffWords('shipped it', 'shipped it twice');

    expect(parts.filter((p) => p.type === 'added').map((p) => p.value.trim())).toEqual(['twice']);
  });

  it('handles empty before and after', () => {
    expect(diffWords('', '').filter((p) => p.type !== 'equal')).toEqual([]);
    expect(diffWords('', 'new').some((p) => p.type === 'added')).toBe(true);
    expect(diffWords('old', '').some((p) => p.type === 'removed')).toBe(true);
  });
});

describe('diffLines', () => {
  it('reports no hunks for identical documents', () => {
    const md = '# CV\n\n- shipped the parser\n';

    expect(diffLines(md, md)).toEqual([]);
  });

  it('reports a changed line as one hunk carrying word-level parts', () => {
    const hunks = diffLines('- cut latency by 40%', '- cut latency by 60%');

    expect(hunks).toHaveLength(1);
    expect(hunks[0].type).toBe('changed');
    expect(hunks[0].words?.filter((w) => w.type !== 'equal').map((w) => w.value.trim())).toEqual([
      '40%',
      '60%',
    ]);
  });

  it('reports an added line', () => {
    const hunks = diffLines('- one', '- one\n- two');

    expect(hunks).toHaveLength(1);
    expect(hunks[0].type).toBe('added');
    expect(hunks[0].after).toBe('- two');
  });

  it('reports a removed line', () => {
    const hunks = diffLines('- one\n- two', '- one');

    expect(hunks).toHaveLength(1);
    expect(hunks[0].type).toBe('removed');
    expect(hunks[0].before).toBe('- two');
  });

  it('diffs the first revision against the master markdown', () => {
    // Spec §7: the baseline for revision 1 is the master CV, so the first generation is
    // reviewable as a diff rather than appearing from nowhere.
    const master = '- Senior Developer at X\n- Ran PostgreSQL in production';
    const revision1 = '- Senior Developer at X\n- Ran PostgreSQL 14 in production for 40M rows';

    const hunks = diffLines(master, revision1);

    expect(hunks).toHaveLength(1);
    expect(hunks[0].type).toBe('changed');
  });

  it('carries line numbers so the UI can anchor a hunk', () => {
    const hunks = diffLines('- one\n- two\n- three', '- one\n- CHANGED\n- three');

    expect(hunks[0].beforeLine).toBe(2);
    expect(hunks[0].afterLine).toBe(2);
  });

  it('handles a document changing from empty to full', () => {
    const hunks = diffLines('', '- one\n- two');

    expect(hunks.every((h) => h.type === 'added')).toBe(true);
    expect(hunks).toHaveLength(2);
  });

  it('does not report a hunk for a trailing newline difference alone', () => {
    // A cosmetic trailing newline would otherwise show the user a phantom change.
    expect(diffLines('- one\n', '- one')).toEqual([]);
  });
});
