import { mergeQuestions } from './screening-questions';

describe('mergeQuestions', () => {
  it('returns the user questions when only the user supplied any', () => {
    expect(mergeQuestions(['Why us?', 'Salary expectations?'], [])).toEqual([
      { text: 'Why us?', source: 'user' },
      { text: 'Salary expectations?', source: 'user' },
    ]);
  });

  it('returns the parsed questions when the user supplied none', () => {
    expect(mergeQuestions([], ['Are you eligible to work in the EU?'])).toEqual([
      { text: 'Are you eligible to work in the EU?', source: 'parsed' },
    ]);
  });

  it('keeps the user list first, then parsed questions not already present', () => {
    // The user's list is the one they will paste answers back into, so it leads.
    const merged = mergeQuestions(['Why us?'], ['Notice period?']);
    expect(merged.map((q) => q.text)).toEqual(['Why us?', 'Notice period?']);
    expect(merged.map((q) => q.source)).toEqual(['user', 'parsed']);
  });

  it('collapses an overlap to ONE entry and the user wins the tie', () => {
    // A question the user actually saw on the portal is evidence; a parsed one is an
    // inference. Labelling the survivor `parsed` would understate what is known about it.
    const merged = mergeQuestions(['Why do you want to work here?'], ['why do you want to work here']);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('user');
  });

  it('keeps the user original casing and punctuation on a tie', () => {
    // Normalisation is for COMPARISON only. The user pastes this text into a real form, so it
    // must come back exactly as they wrote it.
    const merged = mergeQuestions(['Why Us?'], ['why us']);
    expect(merged[0].text).toBe('Why Us?');
  });

  it('treats a trailing question mark as insignificant when comparing', () => {
    expect(mergeQuestions(['Notice period?'], ['Notice period'])).toHaveLength(1);
  });

  it('treats differing internal whitespace as insignificant when comparing', () => {
    expect(mergeQuestions(['Why   us?'], ['Why us?'])).toHaveLength(1);
  });

  it('collapses whitespace in the text it returns', () => {
    expect(mergeQuestions(['Why   us?'], [])[0].text).toBe('Why us?');
  });

  it('drops whitespace-only and empty entries from both lists', () => {
    expect(mergeQuestions(['   ', ''], ['\t', 'Real question?'])).toEqual([
      { text: 'Real question?', source: 'parsed' },
    ]);
  });

  it('returns an empty array when neither list has anything', () => {
    expect(mergeQuestions([], [])).toEqual([]);
  });

  it('de-duplicates within the user list itself', () => {
    expect(mergeQuestions(['Why us?', 'why us'], [])).toHaveLength(1);
  });

  it('de-duplicates within the parsed list itself', () => {
    expect(mergeQuestions([], ['Why us?', 'WHY US'])).toHaveLength(1);
  });

  it('is deterministic for identical input', () => {
    const user = ['Why us?', 'Notice period?'];
    const parsed = ['Salary?', 'why us'];
    expect(mergeQuestions(user, parsed)).toEqual(mergeQuestions(user, parsed));
  });
});
