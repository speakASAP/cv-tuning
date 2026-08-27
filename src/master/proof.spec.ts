import { ProofSource, parseProof, selectProofFacts } from './proof';

const fact = (factId: string, text: string, kind = 'proof'): ProofSource => ({
  factId,
  text,
  kind,
});

describe('parseProof', () => {
  it('extracts a bare url and uses the rest of the text as the label', () => {
    const item = parseProof(fact('f1', 'Payments rewrite case study https://example.com/payments'));

    expect(item).toEqual({
      factId: 'f1',
      label: 'Payments rewrite case study',
      url: 'https://example.com/payments',
      text: 'Payments rewrite case study https://example.com/payments',
    });
  });

  it('strips sentence punctuation that trails a url', () => {
    expect(parseProof(fact('f1', 'See https://example.com/a.')).url).toBe('https://example.com/a');
    expect(parseProof(fact('f2', 'See (https://example.com/b),')).url).toBe('https://example.com/b');
    expect(parseProof(fact('f3', 'See https://example.com/c;')).url).toBe('https://example.com/c');
  });

  it('keeps a trailing slash, which is part of the path and not punctuation', () => {
    expect(parseProof(fact('f1', 'Blog https://example.com/posts/')).url).toBe(
      'https://example.com/posts/',
    );
  });

  it('reads the `label — url` form', () => {
    const item = parseProof(fact('f1', 'Open-source parser — https://github.com/me/parser'));

    expect(item.label).toBe('Open-source parser');
    expect(item.url).toBe('https://github.com/me/parser');
  });

  it('takes the first url when a fact cites several', () => {
    const item = parseProof(fact('f1', 'Docs https://a.example/one and https://b.example/two'));

    expect(item.url).toBe('https://a.example/one');
    // The second url stays in the label rather than vanishing: dropping it would lose a
    // link the user wrote out.
    expect(item.label).toBe('Docs and https://b.example/two');
  });

  it('surfaces a proof fact that carries no url at all', () => {
    // A case study described in prose is still proof of work. Dropping it because it has no
    // link would silently lose something the user deliberately wrote.
    const item = parseProof(fact('f1', 'Rebuilt the billing pipeline, written up internally'));

    expect(item.url).toBeNull();
    expect(item.label).toBe('Rebuilt the billing pipeline, written up internally');
  });

  it('falls back to the raw text as the label when the url is the whole fact', () => {
    // An empty label would render as a bare dash with nothing to click through from.
    const item = parseProof(fact('f1', 'https://example.com/portfolio'));

    expect(item.url).toBe('https://example.com/portfolio');
    expect(item.label).toBe('https://example.com/portfolio');
  });

  it('collapses whitespace in the label', () => {
    expect(parseProof(fact('f1', '  Case   study \n https://example.com/x  ')).label).toBe(
      'Case study',
    );
  });

  it('ignores a url-like string that is not http(s)', () => {
    const item = parseProof(fact('f1', 'Reachable at ftp://example.com/drop'));

    expect(item.url).toBeNull();
    expect(item.label).toBe('Reachable at ftp://example.com/drop');
  });
});

describe('selectProofFacts', () => {
  it('returns only proof-kind facts', () => {
    const items = selectProofFacts([
      fact('f1', 'Cut churn 23%', 'achievement'),
      fact('f2', 'Portfolio https://example.com/p'),
      fact('f3', 'BSc Computer Science', 'education'),
    ]);

    expect(items.map((i) => i.factId)).toEqual(['f2']);
  });

  it('preserves the order facts arrive in', () => {
    const items = selectProofFacts([
      fact('f1', 'One https://example.com/1'),
      fact('f2', 'Two https://example.com/2'),
      fact('f3', 'Three https://example.com/3'),
    ]);

    expect(items.map((i) => i.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ]);
  });

  it('de-duplicates by url and keeps the first label', () => {
    const items = selectProofFacts([
      fact('f1', 'Parser https://github.com/me/parser'),
      fact('f2', 'My open-source parser https://github.com/me/parser'),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Parser');
  });

  it('de-duplicates urls case-insensitively on host but not on path', () => {
    // Hosts are case-insensitive per RFC 3986; paths are not, and treating them as such
    // would collapse two genuinely different pages into one.
    const items = selectProofFacts([
      fact('f1', 'A https://Example.com/Work'),
      fact('f2', 'B https://example.com/Work'),
      fact('f3', 'C https://example.com/work'),
    ]);

    expect(items.map((i) => i.factId)).toEqual(['f1', 'f3']);
  });

  it('de-duplicates url-less facts by their label', () => {
    const items = selectProofFacts([
      fact('f1', 'Rebuilt the billing pipeline'),
      fact('f2', 'rebuilt the   billing pipeline'),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].factId).toBe('f1');
  });

  it('does not conflate a url-less fact with a url-carrying one that shares its label', () => {
    const items = selectProofFacts([
      fact('f1', 'Billing pipeline'),
      fact('f2', 'Billing pipeline https://example.com/billing'),
    ]);

    expect(items).toHaveLength(2);
  });

  it('drops a proof fact whose text is empty rather than emitting a blank line', () => {
    expect(selectProofFacts([fact('f1', '   ')])).toEqual([]);
  });

  it('returns an empty array when there are no proof facts', () => {
    expect(selectProofFacts([fact('f1', 'Cut churn 23%', 'achievement')])).toEqual([]);
  });
});
