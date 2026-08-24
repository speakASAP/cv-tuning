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

  it('raises on a stray prose line inside a section rather than dropping it', () => {
    const md = '# Jane\n\n## Exp\n### Dev — Acme (2020)\nstray prose line\n- real bullet';
    expect(() => renderToDocument(md)).toThrow(/stray prose line/);
  });

  it('raises on a malformed heading marker (missing space) rather than losing the entry', () => {
    const md = '# Jane\n\n## Exp\n###Dev — Acme (2020)\n- real bullet';
    expect(() => renderToDocument(md)).toThrow(/###Dev/);
  });

  it('raises on a starred bullet rather than dropping it silently', () => {
    const md = '# Jane\n\n## Exp\n### Dev — Acme (2020)\n* starred';
    expect(() => renderToDocument(md)).toThrow(/starred/);
  });

  it('raises on a second H1 rather than silently overwriting the name', () => {
    const md = '# Jane\n# Second\n\n## Exp\n- x';
    expect(() => renderToDocument(md)).toThrow(/second.*#|duplicate|already/i);
  });

  it('splits a hyphenated title and org on the em-dash, not the hyphen', () => {
    const md = '# Jane\n\n## Exp\n### Full-Stack Developer — Acme-Corp (2020-2024)\n- x';
    const entry = renderToDocument(md).sections[0].entries[0];
    expect(entry.title).toBe('Full-Stack Developer');
    expect(entry.org).toBe('Acme-Corp');
    expect(entry.period).toBe('2020-2024');
  });
});

describe('renderToDocument: title-less entry headings', () => {
  // Tailored renders (render-markdown.ts#buildRenderMarkdown) group bullets by the source
  // fact's derived {org, period}. A fact carries NO job title — nothing in the fact graph
  // does — so a tailored entry has an employer and a period but no title. The em dash stays
  // mandatory (a hyphen is common inside org names), so a title-less entry is written with a
  // LEADING em dash and must parse back to a null title rather than an org swallowed into it.
  it('parses "### — Acme (2019-2024)" as a title-less entry, not an org-shaped title', () => {
    const doc = renderToDocument('# Jane\n\n## Experience\n### — Acme (2019-2024)\n- shipped a thing');
    const entry = doc.sections[0].entries[0];
    expect(entry.title).toBeNull();
    expect(entry.org).toBe('Acme');
    expect(entry.period).toBe('2019-2024');
    expect(entry.bullets).toEqual(['shipped a thing']);
  });

  it('parses a title-less entry with no period at all', () => {
    // period is null whenever fact-provenance could not confidently derive one; nothing may
    // be substituted for it, so the heading simply carries no parenthesised group.
    const doc = renderToDocument('# Jane\n\n## Experience\n### — Acme\n- shipped a thing');
    const entry = doc.sections[0].entries[0];
    expect(entry.title).toBeNull();
    expect(entry.org).toBe('Acme');
    expect(entry.period).toBeNull();
  });

  it('still keeps a real title when one is present, so the master-CV shape is unchanged', () => {
    const doc = renderToDocument('# Jane\n\n## Experience\n### Senior Developer — Acme (2019-2024)\n- x');
    expect(doc.sections[0].entries[0].title).toBe('Senior Developer');
  });
});
