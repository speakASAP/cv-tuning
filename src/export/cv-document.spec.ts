import { renderToDocument } from './cv-document';

const CV = [
  '# Jane Doe',
  'jane@example.com | +420 123 456 789 | github.com/jane',
  '',
  '## Experience',
  '### Senior Developer — Acme (2019-2024)',
  '- Cut checkout latency from 900ms to 220ms',
  '- Ran PostgreSQL in production',
  '',
  '## Education',
  '### BSc Computer Science — Charles University (2015-2019)',
].join('\n');

describe('renderToDocument', () => {
  it('reads the name from the H1', () => {
    expect(renderToDocument(CV).contact.name).toBe('Jane Doe');
  });

  it('splits the contact line into parts', () => {
    expect(renderToDocument(CV).contact.parts).toContain('jane@example.com');
  });

  it('reads sections from H2 headings', () => {
    expect(renderToDocument(CV).sections.map((s) => s.heading)).toEqual(['Experience', 'Education']);
  });

  it('reads entries from H3 headings, splitting title, org, and period', () => {
    const entry = renderToDocument(CV).sections[0].entries[0];
    expect(entry.title).toBe('Senior Developer');
    expect(entry.org).toBe('Acme');
    expect(entry.period).toBe('2019-2024');
  });

  it('attaches bullets to the entry above them', () => {
    expect(renderToDocument(CV).sections[0].entries[0].bullets).toHaveLength(2);
  });

  it('keeps bullets that precede any H3 in a headless entry', () => {
    const doc = renderToDocument('# Jane\n\n## Skills\n- TypeScript');
    expect(doc.sections[0].entries[0].bullets).toEqual(['TypeScript']);
    expect(doc.sections[0].entries[0].title).toBeNull();
  });

  it('raises on markdown with no H1 rather than emitting a nameless CV', () => {
    expect(() => renderToDocument('## Experience\n- x')).toThrow(/name/i);
  });

  it('raises on empty input', () => {
    expect(() => renderToDocument('   ')).toThrow(/empty/i);
  });
});
