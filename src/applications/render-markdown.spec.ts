import { renderToDocument } from '../export/cv-document';
import { buildRenderMarkdown, extractH1Name, MissingMasterNameError } from './render-markdown';

describe('extractH1Name', () => {
  it('extracts the name from a leading H1', () => {
    expect(extractH1Name('# Jane Doe\n\nsome contact info')).toBe('Jane Doe');
  });

  it('extracts the name from an H1 that is not the first line', () => {
    expect(extractH1Name('\n\n# Jane Doe\n## Experience')).toBe('Jane Doe');
  });

  it('raises a clear, actionable error when there is no H1 at all', () => {
    expect(() => extractH1Name('some text\n- a bullet')).toThrow(MissingMasterNameError);
  });

  it('raises rather than guessing when multiple H1s appear, as linkedin.importer.ts#toMarkdown produces', () => {
    // linkedin.importer.ts:102 emits `# Experience` and `# Skills` as top-level section
    // headings with no candidate name anywhere — two H1s, neither of them a name.
    expect(() => extractH1Name('# Experience\n\n## Foo — Bar\n- did a thing\n\n# Skills\n- TypeScript')).toThrow(
      MissingMasterNameError,
    );
  });

  it('the missing-name error names what is missing and how to fix it', () => {
    expect(() => extractH1Name('no heading at all')).toThrow(/add a name heading|# Your Name/i);
  });
});

describe('buildRenderMarkdown', () => {
  it('produces H1 name + one H2 holding the tailored bullets', () => {
    const markdown = buildRenderMarkdown('# Jane Doe\n\nsome contact', [
      { text: 'Did a thing' },
      { text: 'Did another thing' },
    ]);

    expect(markdown).toBe(
      '# Jane Doe\n\n## Tailored Highlights\n\n- Did a thing\n- Did another thing',
    );
  });

  it('raises the missing-name error rather than fabricating a placeholder name', () => {
    expect(() => buildRenderMarkdown('# Experience\n- x\n# Skills\n- y', [])).toThrow(MissingMasterNameError);
  });

  it('produces output that renderToDocument can parse without raising', () => {
    // Guards against silent drift between this builder and Task 6's parser contract.
    const markdown = buildRenderMarkdown('# Jane Doe', [
      { text: 'Did a thing' },
    ]);
    expect(() => renderToDocument(markdown)).not.toThrow();
    expect(renderToDocument(markdown).contact.name).toBe('Jane Doe');
    expect(renderToDocument(markdown).sections[0].heading).toBe('Tailored Highlights');
  });

  it('collapses a multi-line bullet so a two-line model output cannot break export after it is stored (Important 1)', () => {
    const markdown = buildRenderMarkdown('# Jane Doe', [{ text: 'led team\nand did stuff' }]);

    expect(markdown).toBe('# Jane Doe\n\n## Tailored Highlights\n\n- led team and did stuff');
    expect(() => renderToDocument(markdown)).not.toThrow();
    expect(renderToDocument(markdown).sections[0].entries[0].bullets).toEqual(['led team and did stuff']);
  });

  it('collapses interior runs of whitespace/tabs in a bullet, not just newlines', () => {
    const markdown = buildRenderMarkdown('# Jane Doe', [{ text: 'led  team\t\tof twelve' }]);
    expect(markdown).toContain('- led team of twelve');
  });

  it('neutralizes a leading "#" in bullet text so it cannot be counted as a second H1 (Important 2)', () => {
    const markdown = buildRenderMarkdown('# Jane Doe', [{ text: '# 1 revenue driver on the team' }]);

    expect(markdown).toBe('# Jane Doe\n\n## Tailored Highlights\n\n- 1 revenue driver on the team');
    // The exact failure confirmClaim would otherwise re-trigger: re-parsing this render's own
    // markdown must not raise MissingMasterNameError.
    expect(() => extractH1Name(markdown)).not.toThrow();
    expect(extractH1Name(markdown)).toBe('Jane Doe');
    expect(() => renderToDocument(markdown)).not.toThrow();
  });
});
