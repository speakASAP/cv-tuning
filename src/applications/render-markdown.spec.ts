import { renderToDocument } from '../export/cv-document';
import { buildRenderMarkdown, extractH1Name, extractH1JobTitle, MissingMasterNameError } from './render-markdown';

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

  it('refuses an H1 that follows other content, rather than promoting a pasted title to a name', () => {
    // The exact production failure this rule exists for (observed 2026-09-05). A master CV
    // whose name is PLAIN TEXT on line 1 — the shape every gdocs/PDF/OCR import produces,
    // since none of them emit a `#` — with a project write-up pasted below it. That
    // write-up's own `# Statex Microservices Ecosystem — Project Description` was the
    // document's ONLY H1, so a uniqueness-only check accepted it and rendered a project
    // title as the candidate's name on the H1 line of an exported CV.
    const markdown = [
      'Ing. Sergej Stasok',
      'AI, System Integration, Project Management',
      'Contact Information:',
      '* Email: someone@example.com',
      '',
      '# Statex Microservices Ecosystem — Project Description',
      '',
      '**Overview of applications and shared microservices.**',
    ].join('\n');

    expect(() => extractH1Name(markdown)).toThrow(MissingMasterNameError);
  });

  it('still accepts a leading H1 when unrelated content follows it', () => {
    // The position rule must not reject the normal case: a real name heading on line 1 with
    // arbitrary pasted content underneath is valid, so long as nothing precedes the H1.
    expect(extractH1Name('# Jane Doe\n\ncontact\n\n## Experience\n- did a thing')).toBe('Jane Doe');
  });

  it('the missing-name error explains that the heading must lead the document', () => {
    // A user whose master already contains a `# ...` further down needs to be told that
    // position is the problem; "add a name heading" alone would read as already-done.
    expect(() => extractH1Name('plain name line\n\n# A Pasted Title')).toThrow(/first line/i);
  });
});

describe('H1 headline: "<Job Title> - <Name>"', () => {
  const master = '# Jane Doe\n\njane@example.com\n\n## Professional Experience\n';
  const bullets = [{ text: 'Shipped a thing.', sourceFactId: 'f1' }];
  const facts = [
    {
      factId: 'f1',
      text: 'Shipped a thing.',
      kind: 'experience',
      section: 'Professional Experience',
      title: 'Developer',
      org: 'Acme',
      period: '2019-2024',
    },
  ];

  it('composes the target job title and the candidate name into the H1', () => {
    const markdown = buildRenderMarkdown(master, bullets, facts, 'App Developer');
    expect(markdown.split('\n')[0]).toBe('# App Developer - Jane Doe');
  });

  it('falls back to the name alone when the job title is absent or blank', () => {
    // A posting does not always yield a parseable title. A headline-less CV is correct;
    // "# - Jane Doe" is broken.
    expect(buildRenderMarkdown(master, bullets, facts, null).split('\n')[0]).toBe('# Jane Doe');
    expect(buildRenderMarkdown(master, bullets, facts, '   ').split('\n')[0]).toBe('# Jane Doe');
    expect(buildRenderMarkdown(master, bullets, facts).split('\n')[0]).toBe('# Jane Doe');
  });

  it('reduces a composed H1 back to the bare name, so confirmClaim cannot nest titles', () => {
    // confirmClaim re-renders from a PRIOR RENDER's markdown, feeding our own output back in.
    // Without the split this produced "App Developer - App Developer - Jane Doe", growing by
    // one title per decision.
    const first = buildRenderMarkdown(master, bullets, facts, 'App Developer');
    expect(extractH1Name(first)).toBe('Jane Doe');
    expect(extractH1JobTitle(first)).toBe('App Developer');

    const second = buildRenderMarkdown(first, bullets, facts, extractH1JobTitle(first));
    const third = buildRenderMarkdown(second, bullets, facts, extractH1JobTitle(second));
    expect(second.split('\n')[0]).toBe('# App Developer - Jane Doe');
    // Byte-idempotent: spec §6.3 reuses the artifact sha256 for identity.
    expect(second).toBe(first);
    expect(third).toBe(second);
  });

  it('neutralizes a separator inside the job title so the name half stays recoverable', () => {
    const markdown = buildRenderMarkdown(master, bullets, facts, 'Developer - Backend');
    expect(markdown.split('\n')[0]).toBe('# Developer Backend - Jane Doe');
    expect(extractH1Name(markdown)).toBe('Jane Doe');
  });

  it('extractH1JobTitle returns null for a bare-name H1', () => {
    expect(extractH1JobTitle('# Jane Doe\n\n## Experience')).toBeNull();
  });

  it('keeps a hyphenated NAME intact when there is no job title half', () => {
    // "Jane Doe-Smith" has no " - " separator, so nothing is split off.
    expect(extractH1Name('# Jane Doe-Smith\n\n## Experience')).toBe('Jane Doe-Smith');
  });
});

describe('buildRenderMarkdown', () => {
  // Bullets whose source fact is absent from the snapshot land in the general section with no
  // org or period — the shape every render had before facts carried section/org/period, and
  // still the shape for facts extracted before that migration (which did not backfill).
  const UNMAPPED: {
    factId: string;
    text: string;
    kind: string;
    section: null;
    org: null;
    period: null;
    title: null;
  }[] = [];

  it('produces H1 name + one H2 holding bullets whose facts carry no derivable section', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe\n\nsome contact',
      [
        { text: 'Did a thing', sourceFactId: 'f1' },
        { text: 'Did another thing', sourceFactId: 'f2' },
      ],
      UNMAPPED,
    );

    // "some contact" is re-emitted between the H1 and the first H2: the master's contact
    // block is now carried through so the exported CV has an address to reply to.
    expect(markdown).toBe(
      '# Jane Doe\n\nsome contact\n\n## Additional Highlights\n\n### \u2014\n\n- Did a thing\n\n- Did another thing',
    );
  });

  it('raises the missing-name error rather than fabricating a placeholder name', () => {
    expect(() => buildRenderMarkdown('# Experience\n- x\n# Skills\n- y', [], [])).toThrow(
      MissingMasterNameError,
    );
  });

  it('produces output that renderToDocument can parse without raising', () => {
    // Guards against silent drift between this builder and Task 6's parser contract.
    const markdown = buildRenderMarkdown('# Jane Doe', [{ text: 'Did a thing', sourceFactId: 'f1' }], UNMAPPED);
    expect(() => renderToDocument(markdown)).not.toThrow();
    expect(renderToDocument(markdown).contact.name).toBe('Jane Doe');
    expect(renderToDocument(markdown).sections[0].heading).toBe('Additional Highlights');
  });

  it('collapses a multi-line bullet so a two-line model output cannot break export after it is stored (Important 1)', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [{ text: 'led team\nand did stuff', sourceFactId: 'f1' }],
      UNMAPPED,
    );

    expect(markdown).toBe('# Jane Doe\n\n## Additional Highlights\n\n### \u2014\n\n- led team and did stuff');
    expect(() => renderToDocument(markdown)).not.toThrow();
    expect(renderToDocument(markdown).sections[0].entries[0].bullets).toEqual(['led team and did stuff']);
  });

  it('collapses interior runs of whitespace/tabs in a bullet, not just newlines', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [{ text: 'led  team\t\tof twelve', sourceFactId: 'f1' }],
      UNMAPPED,
    );
    expect(markdown).toContain('- led team of twelve');
  });

  it('neutralizes a leading "#" in bullet text so it cannot be counted as a second H1 (Important 2)', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [{ text: '# 1 revenue driver on the team', sourceFactId: 'f1' }],
      UNMAPPED,
    );

    expect(markdown).toBe('# Jane Doe\n\n## Additional Highlights\n\n### \u2014\n\n- 1 revenue driver on the team');
    // The exact failure confirmClaim would otherwise re-trigger: re-parsing this render's own
    // markdown must not raise MissingMasterNameError.
    expect(() => extractH1Name(markdown)).not.toThrow();
    expect(extractH1Name(markdown)).toBe('Jane Doe');
    expect(() => renderToDocument(markdown)).not.toThrow();
  });
});

/**
 * Phase 5: multi-section reconstruction. Facts now carry derived {section, org, period}
 * (master/fact-provenance.ts), so a render can group its bullets the way the master CV was
 * actually organised instead of dumping everything under one flat heading.
 */
describe('buildRenderMarkdown: multi-section grouping', () => {
  const fact = (
    factId: string,
    text: string,
    section: string | null,
    org: string | null,
    period: string | null,
    title: string | null = null,
  ) => ({ factId, text, kind: 'achievement', section, org, period, title });

  const bullet = (text: string, sourceFactId: string) => ({ text, sourceFactId });

  it('groups bullets under their fact section, then by (org, period) entry', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Cut latency to 220ms', 'f1'), bullet('Ran PostgreSQL', 'f2'), bullet('BSc CS', 'f3')],
      [
        fact('f1', 'x', 'Experience', 'Acme', '2019-2024'),
        fact('f2', 'y', 'Experience', 'Globex', '2016-2019'),
        fact('f3', 'z', 'Education', 'Charles University', '2012-2016'),
      ],
    );

    // Asserted through the real parser rather than by string match: the contract that matters
    // is that cv-document.ts reads back exactly the structure intended.
    const doc = renderToDocument(markdown);
    expect(doc.sections.map((s) => s.heading)).toEqual(['Experience', 'Education']);
    expect(doc.sections[0].entries.map((e) => [e.org, e.period, e.bullets])).toEqual([
      ['Acme', '2019-2024', ['Cut latency to 220ms']],
      ['Globex', '2016-2019', ['Ran PostgreSQL']],
    ]);
    expect(doc.sections[1].entries[0].org).toBe('Charles University');
  });

  it('merges bullets sharing the same (org, period) into ONE entry, not one entry each', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('First thing', 'f1'), bullet('Second thing', 'f2')],
      [fact('f1', 'x', 'Experience', 'Acme', '2019-2024'), fact('f2', 'y', 'Experience', 'Acme', '2019-2024')],
    );

    const entries = renderToDocument(markdown).sections[0].entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].bullets).toEqual(['First thing', 'Second thing']);
  });

  it('keeps the same org under two DIFFERENT periods as two separate entries', () => {
    // Two stints at one employer are two real entries; merging them would state a continuous
    // tenure the CV never claimed.
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Early stint', 'f1'), bullet('Later stint', 'f2')],
      [fact('f1', 'x', 'Experience', 'Acme', '2012-2014'), fact('f2', 'y', 'Experience', 'Acme', '2019-2024')],
    );

    const entries = renderToDocument(markdown).sections[0].entries;
    expect(entries.map((e) => [e.org, e.period])).toEqual([
      ['Acme', '2012-2014'],
      ['Acme', '2019-2024'],
    ]);
  });

  it('prints nothing for a null org and never borrows the adjacent entry’s employer', () => {
    // THE contract this whole task hangs on (STATE.json traps): a wrong employer on an
    // exported CV is exactly the failure this product exists to prevent.
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Attributed thing', 'f1'), bullet('Unattributed thing', 'f2')],
      [
        fact('f1', 'x', 'Experience', 'Acme', '2019-2024'),
        fact('f2', 'y', 'Experience', null, null),
      ],
    );

    const entries = renderToDocument(markdown).sections[0].entries;
    // Two entries, not one: the unattributed bullet must open its own entry rather than
    // trailing under Acme's heading, which cv-document.ts would read as more of Acme's work.
    expect(entries).toHaveLength(2);
    expect(entries[0].bullets).toEqual(['Attributed thing']);
    const unattributed = entries.find((e) => e.bullets.includes('Unattributed thing'));
    expect(unattributed).toBeDefined();
    expect(unattributed!.org).toBeNull();
    expect(unattributed!.period).toBeNull();
    expect(unattributed!.title).toBeNull();
  });

  it('prints an org with no period, and a period with no org, without inventing the other', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Org only', 'f1'), bullet('Period only', 'f2')],
      [
        fact('f1', 'x', 'Experience', 'Acme', null),
        fact('f2', 'y', 'Experience', null, '2019-2024'),
      ],
    );

    const entries = renderToDocument(markdown).sections[0].entries;
    expect(entries.map((e) => [e.org, e.period])).toEqual([
      ['Acme', null],
      [null, '2019-2024'],
    ]);
  });

  it('keeps a bullet whose fact has a NULL section, in a trailing general section', () => {
    // Losing a bullet because its fact could not be mapped to a heading is a silent failure.
    // Pre-existing facts (no backfill) and heading-less imports both land here routinely.
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Sectioned thing', 'f1'), bullet('Orphan thing', 'f2')],
      [fact('f1', 'x', 'Experience', 'Acme', '2019-2024'), fact('f2', 'y', null, null, null)],
    );

    const doc = renderToDocument(markdown);
    expect(doc.sections.map((s) => s.heading)).toEqual(['Experience', 'Additional Highlights']);
    expect(doc.sections[1].entries[0].bullets).toEqual(['Orphan thing']);
  });

  it('keeps a bullet whose sourceFactId is not in the snapshot at all', () => {
    // confirmClaim re-renders from a stored snapshot; a fact id it cannot resolve must still
    // not cost the user a bullet they already reviewed.
    const markdown = buildRenderMarkdown('# Jane Doe', [bullet('Ghost bullet', 'missing')], []);
    const doc = renderToDocument(markdown);
    expect(doc.sections.map((s) => s.heading)).toEqual(['Additional Highlights']);
    expect(doc.sections[0].entries[0].bullets).toEqual(['Ghost bullet']);
  });

  it('puts the general section LAST even when the orphan bullet came first', () => {
    // Ordering feeds the artifact sha256 (spec 6.3), so it must be a rule, not an accident
    // of which bullet the model happened to emit first.
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Orphan thing', 'f2'), bullet('Sectioned thing', 'f1')],
      [fact('f1', 'x', 'Experience', 'Acme', '2019-2024'), fact('f2', 'y', null, null, null)],
    );
    expect(renderToDocument(markdown).sections.map((s) => s.heading)).toEqual([
      'Experience',
      'Additional Highlights',
    ]);
  });

  it('orders sections, entries, and bullets by first appearance in the bullet array', () => {
    // First-appearance order is the deterministic rule. Same input -> same bytes -> same
    // artifact sha256, which spec 6.3 reuses for idempotency.
    const facts = [
      fact('f1', 'x', 'Education', 'Uni', '2012-2016'),
      fact('f2', 'y', 'Experience', 'Acme', '2019-2024'),
      fact('f3', 'z', 'Experience', 'Globex', '2016-2019'),
    ];
    const bullets = [bullet('B education', 'f1'), bullet('B acme', 'f2'), bullet('B globex', 'f3')];

    const first = buildRenderMarkdown('# Jane Doe', bullets, facts);
    // Same content, facts listed in a different order: grouping must follow the BULLETS, so
    // the output is byte-identical.
    const second = buildRenderMarkdown('# Jane Doe', bullets, [facts[2], facts[0], facts[1]]);
    expect(second).toBe(first);
    expect(renderToDocument(first).sections.map((s) => s.heading)).toEqual(['Education', 'Experience']);
  });

  it('is byte-identical across repeated calls with identical input', () => {
    const facts = [fact('f1', 'x', 'Experience', 'Acme', '2019-2024'), fact('f2', 'y', null, null, null)];
    const bullets = [bullet('One', 'f1'), bullet('Two', 'f2')];
    expect(buildRenderMarkdown('# Jane Doe', bullets, facts)).toBe(
      buildRenderMarkdown('# Jane Doe', bullets, facts),
    );
  });

  it('still emits a parseable document when there are no bullets at all', () => {
    const markdown = buildRenderMarkdown('# Jane Doe', [], []);
    expect(extractH1Name(markdown)).toBe('Jane Doe');
    expect(() => renderToDocument(markdown)).not.toThrow();
  });

  it('normalizes every bullet it emits, in every section', () => {
    // normalizeBulletText must not be skipped on the new grouped paths: a multi-line bullet
    // breaks the parser and a leading "#" is counted as a second H1 by extractH1Name.
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('# 1 revenue\ndriver', 'f1'), bullet('led  team\t\tof twelve', 'f2')],
      [fact('f1', 'x', 'Experience', 'Acme', '2019-2024'), fact('f2', 'y', null, null, null)],
    );

    expect(extractH1Name(markdown)).toBe('Jane Doe');
    const doc = renderToDocument(markdown);
    expect(doc.sections[0].entries[0].bullets).toEqual(['1 revenue driver']);
    expect(doc.sections[1].entries[0].bullets).toEqual(['led team of twelve']);
  });

  it('survives the confirmClaim round-trip: its own output re-parses through itself', () => {
    // confirmClaim (applications.service.ts) passes a PRIOR RENDER'S markdown back in as
    // `sourceMarkdown`, so multi-section output must not break extractH1Name's exactly-one-H1
    // rule. This is the exact path that would otherwise fail only in production.
    const facts = [
      fact('f1', 'x', 'Experience', 'Acme', '2019-2024'),
      fact('f2', 'y', 'Education', 'Uni', null),
      fact('f3', 'z', null, null, null),
    ];
    const bullets = [bullet('One', 'f1'), bullet('Two', 'f2'), bullet('Three', 'f3')];

    const first = buildRenderMarkdown('# Jane Doe', bullets, facts);
    // Drop one bullet, exactly as a `drop` decision does, and re-render from the first render.
    const second = buildRenderMarkdown(first, bullets.slice(0, 2), facts);
    expect(extractH1Name(second)).toBe('Jane Doe');
    expect(() => renderToDocument(second)).not.toThrow();
    expect(renderToDocument(second).sections.map((s) => s.heading)).toEqual(['Experience', 'Education']);

    // And a third pass from the second, since a render chain can be arbitrarily long.
    const third = buildRenderMarkdown(second, bullets.slice(0, 2), facts);
    expect(third).toBe(second);
  });

  it('does not treat a section named like the general bucket as a duplicate heading', () => {
    // If the master CV genuinely has an "Additional Highlights" H2, orphan bullets must join
    // it rather than produce two identically-named sections.
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Real one', 'f1'), bullet('Orphan', 'f2')],
      [fact('f1', 'x', 'Additional Highlights', null, null), fact('f2', 'y', null, null, null)],
    );

    const doc = renderToDocument(markdown);
    expect(doc.sections.map((s) => s.heading)).toEqual(['Additional Highlights']);
    expect(doc.sections[0].entries.flatMap((e) => e.bullets)).toEqual(['Real one', 'Orphan']);
  });
});

/**
 * Task 1: the contact block. `cv-document.ts` reads the plain line(s) between the H1 and the
 * first H2 into `contact.parts`, and both writers render them. Before this, `buildRenderMarkdown`
 * emitted only the H1, so every exported CV went out with no email, phone, or links — a CV an
 * employer cannot reply to.
 */
describe('buildRenderMarkdown: contact block', () => {
  const fact = (
    factId: string,
    section: string | null,
    org: string | null,
    period: string | null,
    title: string | null = null,
  ) => ({ factId, text: 'x', kind: 'achievement', section, org, period, title });

  const bullet = (text: string, sourceFactId: string) => ({ text, sourceFactId });

  const MASTER = [
    '# Jane Doe',
    '',
    'jane@example.com | +420 777 123 456 | linkedin.com/in/janedoe',
    '',
    '## Experience',
    '',
    '### Senior Developer — Acme (2019-2024)',
    '',
    '- Cut churn 23%',
  ].join('\n');

  it('carries the master contact line into the render, where renderToDocument reads it back', () => {
    const markdown = buildRenderMarkdown(MASTER, [bullet('Cut churn 23%', 'f1')], [
      fact('f1', 'Experience', 'Acme', '2019-2024', 'Senior Developer'),
    ]);

    // Asserted through the real parser: what matters is that contact.parts arrives populated,
    // because that is what both writers render from.
    expect(renderToDocument(markdown).contact.parts).toEqual([
      'jane@example.com',
      '+420 777 123 456',
      'linkedin.com/in/janedoe',
    ]);
  });

  it('joins multiple contact lines into contact.parts in the order the user wrote them', () => {
    const master = ['# Jane Doe', 'jane@example.com', '+420 777 123 456', '', '## Experience', '', '- x'].join('\n');
    const markdown = buildRenderMarkdown(master, [], []);

    expect(renderToDocument(markdown).contact.parts).toEqual(['jane@example.com', '+420 777 123 456']);
  });

  it('emits nothing at all when the master has no contact block', () => {
    // A master with no contact lines is normal input and must not raise or invent a line.
    const markdown = buildRenderMarkdown('# Jane Doe\n\n## Experience\n\n- x', [], []);

    expect(renderToDocument(markdown).contact.parts).toEqual([]);
    expect(renderToDocument(markdown).contact.name).toBe('Jane Doe');
  });

  it('is IDEMPOTENT across the confirmClaim re-render: pass two and pass three are identical', () => {
    // confirmClaim feeds a prior render's own markdown back in as `sourceMarkdown`, so the
    // contact block gets re-extracted from output this function itself wrote. A duplicated or
    // dropped contact block would only show up in production, on the artifact the user
    // downloads. This is the single easiest thing to get wrong in this change.
    const bullets = [bullet('Cut churn 23%', 'f1')];
    const facts = [fact('f1', 'Experience', 'Acme', '2019-2024', 'Senior Developer')];

    const first = buildRenderMarkdown(MASTER, bullets, facts);
    const second = buildRenderMarkdown(first, bullets, facts);
    const third = buildRenderMarkdown(second, bullets, facts);

    expect(second).toBe(first);
    expect(third).toBe(second);
    expect(renderToDocument(third).contact.parts).toEqual([
      'jane@example.com',
      '+420 777 123 456',
      'linkedin.com/in/janedoe',
    ]);
  });

  it('does not mistake an entry heading, a bullet, or a section heading for contact detail', () => {
    // A `-` line before the first H2 is a bullet the parser would otherwise never see; a
    // `###` line is an entry heading. Neither is contact detail, and swallowing one into the
    // contact line would put a CV bullet in the header of the exported document.
    const master = ['# Jane Doe', '', '- a stray bullet', '', '### Lead — Acme (2019)', '', '## Experience', '', '- x'].join('\n');
    const markdown = buildRenderMarkdown(master, [], []);

    expect(renderToDocument(markdown).contact.parts).toEqual([]);
  });

  it('keeps an em dash and parentheses inside a contact line intact', () => {
    // A contact line can legitimately contain the same characters the entry-heading grammar
    // uses ("Prague, CZ — open to relocation (EU)"). It must survive verbatim, not be parsed.
    const master = ['# Jane Doe', 'Prague, CZ — open to relocation (EU) | jane@example.com', '', '## Experience', '', '- x'].join('\n');
    const markdown = buildRenderMarkdown(master, [], []);
    const parts = renderToDocument(markdown).contact.parts;

    expect(parts).toEqual(['Prague, CZ — open to relocation (EU)', 'jane@example.com']);
    // ...and it survives the confirmClaim round-trip unchanged too.
    expect(buildRenderMarkdown(markdown, [], [])).toBe(markdown);
  });

  it('collapses a contact line the same way a bullet is collapsed, so it stays one line', () => {
    // Whitespace runs inside a contact line would otherwise vary the bytes and therefore the
    // artifact sha256 (spec §6.3).
    const master = ['# Jane Doe', 'jane@example.com   |   +420  777', '', '## Experience', '', '- x'].join('\n');
    const markdown = buildRenderMarkdown(master, [], []);

    expect(renderToDocument(markdown).contact.parts).toEqual(['jane@example.com', '+420 777']);
  });

  it('still emits a parseable document when the master is nothing but an H1 and a contact line', () => {
    const markdown = buildRenderMarkdown('# Jane Doe\njane@example.com', [], []);

    expect(() => renderToDocument(markdown)).not.toThrow();
    expect(renderToDocument(markdown).contact.parts).toEqual(['jane@example.com']);
  });
});

/**
 * Task 2: job titles on entries. The title is derived in code from the master's `### Role —
 * Org (Period)` heading (`master/fact-provenance.ts`) and carried on the fact snapshot — it is
 * never asked of the extraction model, because a model naming someone's job title fabricates
 * on a field an employer judges a CV by.
 */
describe('buildRenderMarkdown: entry titles', () => {
  const fact = (
    factId: string,
    section: string | null,
    org: string | null,
    period: string | null,
    title: string | null,
  ) => ({ factId, text: 'x', kind: 'achievement', section, org, period, title });

  const bullet = (text: string, sourceFactId: string) => ({ text, sourceFactId });

  it('writes the derived title into the entry heading', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Cut churn 23%', 'f1')],
      [fact('f1', 'Experience', 'Acme', '2019-2024', 'Senior Developer')],
    );

    const entry = renderToDocument(markdown).sections[0].entries[0];
    expect([entry.title, entry.org, entry.period]).toEqual(['Senior Developer', 'Acme', '2019-2024']);
  });

  it('prints nothing for a null title and never borrows a neighbouring entry’s title', () => {
    // The core anti-fabrication rule, applied to the new field: an unmappable title is
    // absent, not the title of whatever entry happens to sit above it.
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Titled thing', 'f1'), bullet('Untitled thing', 'f2')],
      [
        fact('f1', 'Experience', 'Acme', '2019-2024', 'Senior Developer'),
        fact('f2', 'Experience', 'Globex', '2016-2019', null),
      ],
    );

    const entries = renderToDocument(markdown).sections[0].entries;
    expect(entries.map((e) => [e.title, e.org])).toEqual([
      ['Senior Developer', 'Acme'],
      [null, 'Globex'],
    ]);
  });

  it('splits two DIFFERENT roles at the same employer over the same period into two entries', () => {
    // A promotion inside one company is two real entries on a CV. Keying entries on (org,
    // period) alone would merge them and silently discard one of the two job titles the
    // master CV actually states.
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('As a lead', 'f1'), bullet('As a principal', 'f2')],
      [
        fact('f1', 'Experience', 'Acme', '2019-2024', 'Lead Developer'),
        fact('f2', 'Experience', 'Acme', '2019-2024', 'Principal Engineer'),
      ],
    );

    const entries = renderToDocument(markdown).sections[0].entries;
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => [e.title, e.org, e.period])).toEqual([
      ['Lead Developer', 'Acme', '2019-2024'],
      ['Principal Engineer', 'Acme', '2019-2024'],
    ]);
    expect(entries.map((e) => e.bullets)).toEqual([['As a lead'], ['As a principal']]);
  });

  it('keeps the same title at two DIFFERENT employers as two entries', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('At Acme', 'f1'), bullet('At Globex', 'f2')],
      [
        fact('f1', 'Experience', 'Acme', '2019-2024', 'Developer'),
        fact('f2', 'Experience', 'Globex', '2016-2019', 'Developer'),
      ],
    );

    const entries = renderToDocument(markdown).sections[0].entries;
    expect(entries.map((e) => [e.title, e.org])).toEqual([
      ['Developer', 'Acme'],
      ['Developer', 'Globex'],
    ]);
  });

  it('merges bullets sharing title, org AND period into one entry', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('First', 'f1'), bullet('Second', 'f2')],
      [
        fact('f1', 'Experience', 'Acme', '2019-2024', 'Lead'),
        fact('f2', 'Experience', 'Acme', '2019-2024', 'Lead'),
      ],
    );

    const entries = renderToDocument(markdown).sections[0].entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].bullets).toEqual(['First', 'Second']);
  });

  it('does NOT merge a titled entry with an untitled one at the same employer', () => {
    // A null title means "unknown", not "same as the titled entry next to it". Merging would
    // stamp a job title onto a bullet the fact graph never connected to it.
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Known role', 'f1'), bullet('Unknown role', 'f2')],
      [
        fact('f1', 'Experience', 'Acme', '2019-2024', 'Lead'),
        fact('f2', 'Experience', 'Acme', '2019-2024', null),
      ],
    );

    const entries = renderToDocument(markdown).sections[0].entries;
    expect(entries.map((e) => [e.title, e.bullets])).toEqual([
      ['Lead', ['Known role']],
      [null, ['Unknown role']],
    ]);
  });

  it('keeps a title with no org and no period, without inventing either', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Freelance work', 'f1')],
      [fact('f1', 'Experience', null, null, 'Consultant')],
    );

    const entry = renderToDocument(markdown).sections[0].entries[0];
    expect([entry.title, entry.org, entry.period]).toEqual(['Consultant', null, null]);
  });

  it('still emits the bare "### —" reset for an entry with no title, org, or period', () => {
    // Load-bearing, not cosmetic (STATE.json traps): cv-document.ts attaches a bullet to the
    // most recently opened entry, so an unattributed group with no heading of its own would
    // be read as more of the previous employer's work.
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Attributed', 'f1'), bullet('Unattributed', 'f2')],
      [
        fact('f1', 'Experience', 'Acme', '2019-2024', 'Lead'),
        fact('f2', 'Experience', null, null, null),
      ],
    );

    expect(markdown).toContain('### —\n');
    const entries = renderToDocument(markdown).sections[0].entries;
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ title: null, org: null, period: null, bullets: ['Unattributed'] });
  });

  it('survives the confirmClaim round-trip with titles, contact, and orphans all present', () => {
    // The full shape, re-rendered from its own output twice — the production path.
    const master = ['# Jane Doe', 'jane@example.com | +420 777', '', '## Experience', '', '- x'].join('\n');
    const facts = [
      fact('f1', 'Experience', 'Acme', '2019-2024', 'Senior Developer'),
      fact('f2', 'Education', 'Charles University', '2012-2016', 'BSc Computer Science'),
      fact('f3', null, null, null, null),
    ];
    const bullets = [bullet('One', 'f1'), bullet('Two', 'f2'), bullet('Three', 'f3')];

    const first = buildRenderMarkdown(master, bullets, facts);
    const second = buildRenderMarkdown(first, bullets, facts);
    expect(second).toBe(first);

    const doc = renderToDocument(second);
    expect(doc.contact.parts).toEqual(['jane@example.com', '+420 777']);
    expect(doc.sections.map((s) => s.heading)).toEqual(['Experience', 'Education', 'Additional Highlights']);
    expect(doc.sections[0].entries[0].title).toBe('Senior Developer');
  });

  it('ordering still ignores the facts array order once titles are in the key', () => {
    // Spec §6.3 reuses the artifact sha256 for idempotency; `facts` is a lookup only.
    const facts = [
      fact('f1', 'Experience', 'Acme', '2019-2024', 'Lead'),
      fact('f2', 'Experience', 'Acme', '2019-2024', 'Principal'),
      fact('f3', 'Education', 'Uni', '2012-2016', 'BSc'),
    ];
    const bullets = [bullet('A', 'f1'), bullet('B', 'f2'), bullet('C', 'f3')];

    expect(buildRenderMarkdown('# Jane Doe', bullets, [facts[2], facts[0], facts[1]])).toBe(
      buildRenderMarkdown('# Jane Doe', bullets, facts),
    );
  });

  it('neutralizes a title that would break the entry-heading grammar', () => {
    // A title containing the em dash separator would make cv-document.ts read the heading as
    // `Lead` / `Deputy — Acme`, silently relabelling the employer. A newline would break the
    // one-heading-per-line parse outright.
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Did work', 'f1')],
      [fact('f1', 'Experience', 'Acme', '2019-2024', 'Lead — Deputy\nHead')],
    );

    const entry = renderToDocument(markdown).sections[0].entries[0];
    expect(entry.org).toBe('Acme');
    expect(entry.period).toBe('2019-2024');
    expect(entry.title).not.toBeNull();
    expect(entry.title).not.toContain('—');
  });
});

describe('buildRenderMarkdown: proof of work', () => {
  const fact = (
    factId: string,
    text: string,
    kind: string,
    section: string | null = 'Experience',
    org: string | null = 'Acme',
    period: string | null = '2019-2024',
    title: string | null = 'Senior Developer',
  ) => ({ factId, text, kind, section, org, period, title });

  const bullet = (text: string, sourceFactId: string) => ({ text, sourceFactId });

  const ACHIEVEMENT = fact('f1', 'Cut latency to 220ms', 'achievement');

  it('emits a Proof of Work section from proof facts', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Cut latency to 220ms', 'f1')],
      [ACHIEVEMENT, fact('p1', 'Portfolio — https://jane.dev', 'proof')],
    );

    expect(markdown).toContain('## Proof of Work');
    expect(markdown).toContain('- Portfolio — https://jane.dev');
  });

  it('omits the section entirely when no proof facts exist', () => {
    // An empty heading is a defect the CV's reader sees.
    const markdown = buildRenderMarkdown('# Jane Doe', [bullet('Cut latency', 'f1')], [ACHIEVEMENT]);
    expect(markdown).not.toContain('Proof of Work');
  });

  it('omits the section when the only proof fact is blank', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Cut latency', 'f1')],
      [ACHIEVEMENT, fact('p1', '   ', 'proof')],
    );
    expect(markdown).not.toContain('Proof of Work');
  });

  it('writes a proof fact with no URL as its label alone, never as a dangling dash', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Cut latency', 'f1')],
      [ACHIEVEMENT, fact('p1', 'Rewrote the billing engine, described in a case study', 'proof')],
    );

    const doc = renderToDocument(markdown);
    const proof = doc.sections.find((s) => s.heading === 'Proof of Work');
    expect(proof?.entries[0].bullets).toEqual([
      'Rewrote the billing engine, described in a case study',
    ]);
  });

  it('places Proof of Work after the real sections and before the general catch-all', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Cut latency', 'f1'), bullet('Orphan bullet', 'f9')],
      [ACHIEVEMENT, fact('p1', 'https://jane.dev', 'proof')],
    );

    expect(renderToDocument(markdown).sections.map((s) => s.heading)).toEqual([
      'Experience',
      'Proof of Work',
      'Additional Highlights',
    ]);
  });

  it('is derived from the facts, not the bullets: a proof fact no bullet cites still renders', () => {
    // A proof link is not a tailored claim and has no sourceFactId binding — it is reproduced
    // verbatim, which is exactly why it needs no entailment pass.
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Cut latency to 220ms', 'f1')],
      [ACHIEVEMENT, fact('p1', 'https://github.com/jane/thing', 'proof')],
    );

    expect(markdown).toContain('https://github.com/jane/thing');
  });

  it('keeps proof items in facts-array order and de-duplicates by URL', () => {
    const markdown = buildRenderMarkdown(
      '# Jane Doe',
      [bullet('Cut latency', 'f1')],
      [
        ACHIEVEMENT,
        fact('p1', 'Portfolio — https://jane.dev', 'proof'),
        fact('p2', 'Repo — https://github.com/jane/thing', 'proof'),
        // Same URL, different label: one item, first label wins.
        fact('p3', 'My site — https://jane.dev', 'proof'),
      ],
    );

    const proof = renderToDocument(markdown).sections.find((s) => s.heading === 'Proof of Work');
    expect(proof?.entries[0].bullets).toEqual([
      'Portfolio — https://jane.dev',
      'Repo — https://github.com/jane/thing',
    ]);
  });

  it('ignores the facts array order for proof exactly as it does for sections', () => {
    const facts = [
      ACHIEVEMENT,
      fact('p1', 'Portfolio — https://jane.dev', 'proof'),
      fact('p2', 'Repo — https://github.com/jane/thing', 'proof'),
    ];
    const bullets = [bullet('Cut latency', 'f1')];

    // Proof order follows the FACTS array (a proof fact has no bullet to order it by), so
    // reordering the facts legitimately reorders proof. Pinned so the contract is explicit
    // rather than discovered later by a diffing sha256.
    const reordered = buildRenderMarkdown('# Jane Doe', bullets, [facts[0], facts[2], facts[1]]);
    const proof = renderToDocument(reordered).sections.find((s) => s.heading === 'Proof of Work');
    expect(proof?.entries[0].bullets).toEqual([
      'Repo — https://github.com/jane/thing',
      'Portfolio — https://jane.dev',
    ]);
  });

  it('is byte-identical across repeated calls with a proof section present', () => {
    const facts = [ACHIEVEMENT, fact('p1', 'Portfolio — https://jane.dev', 'proof')];
    const bullets = [bullet('Cut latency', 'f1')];
    expect(buildRenderMarkdown('# Jane Doe', bullets, facts)).toBe(
      buildRenderMarkdown('# Jane Doe', bullets, facts),
    );
  });

  it('survives the confirmClaim round-trip with a proof section present', () => {
    // confirmClaim re-renders from a prior render's OWN markdown. A new section must not
    // perturb the contact-block extraction between the H1 and the first `## `, and must not
    // accumulate a second copy of itself on pass three.
    const MASTER = '# Jane Doe\n\njane@example.com | +420 777\n\n## Experience\n\n- Cut latency\n';
    const facts = [ACHIEVEMENT, fact('p1', 'Portfolio — https://jane.dev', 'proof')];
    const bullets = [bullet('Cut latency to 220ms', 'f1')];

    const pass1 = buildRenderMarkdown(MASTER, bullets, facts);
    const pass2 = buildRenderMarkdown(pass1, bullets, facts);
    const pass3 = buildRenderMarkdown(pass2, bullets, facts);

    expect(pass2).toBe(pass1);
    expect(pass3).toBe(pass2);
    expect(extractH1Name(pass3)).toBe('Jane Doe');

    const doc = renderToDocument(pass3);
    expect(doc.contact.parts).toEqual(['jane@example.com', '+420 777']);
    expect(doc.sections.filter((s) => s.heading === 'Proof of Work')).toHaveLength(1);
  });

  it('does not let a proof URL be mistaken for a contact line on the round trip', () => {
    // The proof section sits after the first `## `, so extractContactLines must stop before
    // it. A link leaking into contact.parts would put a portfolio URL in the CV's header.
    const MASTER = '# Jane Doe\n\njane@example.com\n\n## Experience\n\n- Cut latency\n';
    const rendered = buildRenderMarkdown(
      MASTER,
      [bullet('Cut latency', 'f1')],
      [ACHIEVEMENT, fact('p1', 'Portfolio — https://jane.dev', 'proof')],
    );

    expect(renderToDocument(buildRenderMarkdown(rendered, [bullet('Cut latency', 'f1')], [
      ACHIEVEMENT,
      fact('p1', 'Portfolio — https://jane.dev', 'proof'),
    ])).contact.parts).toEqual(['jane@example.com']);
  });

  it('emits a proof section even when there are no bullets at all', () => {
    // A user with proof facts and no tailored bullets still has something worth exporting,
    // and the document must stay parseable.
    const markdown = buildRenderMarkdown('# Jane Doe', [], [fact('p1', 'https://jane.dev', 'proof')]);
    expect(() => renderToDocument(markdown)).not.toThrow();
    expect(renderToDocument(markdown).sections.map((s) => s.heading)).toEqual(['Proof of Work']);
  });
});
