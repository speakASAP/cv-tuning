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
});
