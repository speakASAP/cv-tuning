import { buildCoverLetterMarkdown, LetterParts } from './cover-letter-render';
import { extractContactLines, extractH1Name } from './render-markdown';

const PARTS: LetterParts = {
  candidateName: 'Jane Doe',
  contactLine: 'jane@example.com | +420 777 123 456',
  jobTitle: 'Staff Engineer',
  company: 'Globex',
  paragraphs: [
    'I ran PostgreSQL in production for six years.',
    'I cut checkout latency from 900ms to 220ms.',
  ],
  language: 'en',
};

describe('buildCoverLetterMarkdown', () => {
  it('builds a complete letter with salutation, opening, body and closing', () => {
    const letter = buildCoverLetterMarkdown(PARTS);

    expect(letter).toContain('Jane Doe');
    expect(letter).toContain('jane@example.com');
    expect(letter).toContain('Staff Engineer');
    expect(letter).toContain('Globex');
    expect(letter).toContain('I ran PostgreSQL in production for six years.');
    expect(letter).toContain('I cut checkout latency from 900ms to 220ms.');
  });

  it('keeps the body paragraphs in array order', () => {
    const letter = buildCoverLetterMarkdown(PARTS);
    expect(letter.indexOf('PostgreSQL')).toBeLessThan(letter.indexOf('checkout latency'));
  });

  it('names only the role when the company is unknown, never guessing one', () => {
    // A null company prints nothing and is NEVER filled from a neighbouring value — the same
    // house rule render-markdown.ts follows for a null org.
    const letter = buildCoverLetterMarkdown({ ...PARTS, company: null });

    expect(letter).toContain('Staff Engineer');
    expect(letter).not.toContain('Globex');
    expect(letter).not.toContain('null');
    expect(letter).not.toContain('undefined');
  });

  it('names only the company when the job title is unknown', () => {
    const letter = buildCoverLetterMarkdown({ ...PARTS, jobTitle: null });

    expect(letter).toContain('Globex');
    expect(letter).not.toContain('Staff Engineer');
    expect(letter).not.toContain('null');
  });

  it('degrades to a form naming neither when both are unknown', () => {
    const letter = buildCoverLetterMarkdown({ ...PARTS, jobTitle: null, company: null });

    expect(letter).toContain('the role you advertised');
    expect(letter).not.toContain('null');
    expect(letter).not.toContain('undefined');
  });

  it('addresses the company by name when it is known, and generically when it is not', () => {
    expect(buildCoverLetterMarkdown(PARTS)).toContain('Dear Globex');
    expect(buildCoverLetterMarkdown({ ...PARTS, company: null })).toContain('Dear Hiring Manager');
  });

  it('omits the contact line entirely when the master CV has none', () => {
    // An empty contact line would render as a blank line in the letter's header.
    const letter = buildCoverLetterMarkdown({ ...PARTS, contactLine: null });
    expect(letter).not.toContain('jane@example.com');
    expect(letter).not.toMatch(/\n\n\n/);
  });

  it('leaves an em dash inside a paragraph intact', () => {
    // This is PROSE, not a heading. normalizeHeadingField rewrites the em dash because
    // cv-document.ts parses it as a title/org separator; no such parse happens here, and
    // rewriting a writer's own punctuation would be a silent edit to their words.
    const letter = buildCoverLetterMarkdown({
      ...PARTS,
      paragraphs: ['I did the work — all of it — myself.'],
    });
    expect(letter).toContain('I did the work — all of it — myself.');
  });

  it('produces byte-identical output for two identical calls', () => {
    // The letter is exported as a PDF whose sha256 is the artifact identity (spec 6.3), so a
    // wall-clock or Intl-dependent string here would break idempotency exactly as an unpinned
    // CreationDate did.
    expect(buildCoverLetterMarkdown(PARTS)).toBe(buildCoverLetterMarkdown(PARTS));
  });

  it('contains no date, so the same letter regenerated tomorrow is the same bytes', () => {
    const letter = buildCoverLetterMarkdown(PARTS);
    expect(letter).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(letter).not.toContain(String(new Date().getFullYear()));
  });

  it('still produces a valid letter when the model grounded no paragraphs at all', () => {
    // A letter with no body is a real outcome when every paragraph was dropped. It must not
    // be a crash, and it must not silently look like a complete letter either.
    const letter = buildCoverLetterMarkdown({ ...PARTS, paragraphs: [] });
    expect(letter).toContain('Dear Globex');
    expect(letter).toContain('Jane Doe');
  });

  it('signs off with the candidate name from the master CV', () => {
    const letter = buildCoverLetterMarkdown(PARTS);
    const signOff = letter.slice(letter.lastIndexOf('Sincerely'));
    expect(signOff).toContain('Jane Doe');
  });
});

describe('cover letter parts come from the master CV, not from a second parser', () => {
  it('uses render-markdown.ts own extraction for the name and contact block', () => {
    // Reusing the extraction rather than re-implementing it is what keeps the letter's header
    // and the CV's header from drifting apart — two parsers of the same markdown eventually
    // disagree, and the disagreement would show as a different email on two documents sent to
    // the same employer in the same application.
    const MASTER = '# Jane Doe\n\njane@example.com | +420 777\n\n## Experience\n\n- Cut latency\n';

    const letter = buildCoverLetterMarkdown({
      candidateName: extractH1Name(MASTER),
      contactLine: extractContactLines(MASTER).join(' | '),
      jobTitle: 'Staff Engineer',
      company: 'Globex',
      paragraphs: ['I cut checkout latency to 220ms.'],
      language: 'en',
    });

    expect(letter).toContain('# Jane Doe');
    expect(letter).toContain('jane@example.com | +420 777');
  });

  it('carries no contact line when the master states none', () => {
    const MASTER = '# Jane Doe\n\n## Experience\n\n- Cut latency\n';
    const contact = extractContactLines(MASTER);
    expect(contact).toEqual([]);

    const letter = buildCoverLetterMarkdown({
      candidateName: extractH1Name(MASTER),
      // An empty extraction becomes null, not an empty string: the builder omits the block.
      contactLine: contact.length ? contact.join(' | ') : null,
      jobTitle: null,
      company: null,
      paragraphs: [],
      language: 'en',
    });

    expect(letter).not.toMatch(/\n\n\n/);
  });
});
