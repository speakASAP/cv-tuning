import { AI_TELL_PHRASES, scoreAiTell } from './ai-tell';

describe('scoreAiTell', () => {
  it('scores 0 for prose with none of the tells', () => {
    const clean = 'Cut checkout latency from 900ms to 220ms by replacing the N+1 query with a join.';

    expect(scoreAiTell(clean).score).toBe(0);
    expect(scoreAiTell(clean).hits).toEqual([]);
  });

  it('flags a blocklisted phrase and names it', () => {
    const result = scoreAiTell('Spearheaded a cross-functional initiative.');

    expect(result.score).toBeGreaterThan(0);
    expect(result.hits.map((h) => h.phrase)).toContain('spearheaded');
  });

  it('is case-insensitive', () => {
    expect(scoreAiTell('LEVERAGED our platform.').hits).toHaveLength(1);
  });

  it('matches multi-word tells', () => {
    expect(scoreAiTell('A results-driven engineer with a proven track record.').hits.length).toBe(2);
  });

  it('scores denser prose higher than the same tells spread thin', () => {
    const dense = 'Leveraged spearheaded leveraged.';
    const sparse = `Leveraged the system. ${'Shipped a feature that cut load time. '.repeat(20)}`;

    // The score is per 100 words, so padding with clean prose must dilute it.
    expect(scoreAiTell(dense).score).toBeGreaterThan(scoreAiTell(sparse).score);
  });

  it('caps at 100 rather than overflowing', () => {
    expect(scoreAiTell('leveraged '.repeat(50)).score).toBeLessThanOrEqual(100);
  });

  it('handles empty text without dividing by zero', () => {
    expect(scoreAiTell('').score).toBe(0);
    expect(Number.isNaN(scoreAiTell('').score)).toBe(false);
  });

  it('does not match a tell embedded inside a longer word', () => {
    // "leveraged" inside "unleveraged" is not the AI tell classifiers key on.
    expect(scoreAiTell('An unleveraged position.').hits).toHaveLength(0);
  });

  it('covers every phrase the spec names', () => {
    for (const phrase of ['leveraged', 'spearheaded', 'passionate about', 'results-driven', 'proven track record']) {
      expect(AI_TELL_PHRASES).toContain(phrase);
    }
  });
});
