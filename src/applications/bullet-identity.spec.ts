import { bulletIdOf, decidedBulletIds, withBulletIds } from './bullet-identity';
import { ConfirmedClaim, TailoredBullet } from './application.types';

const bullet = (over: Partial<TailoredBullet> = {}): TailoredBullet => ({
  text: 'led a team of 12 engineers',
  sourceFactId: 'f1',
  targetRequirement: null,
  verdict: 'overreach',
  span: 'a team of 12',
  ...over,
});

const claim = (over: Partial<ConfirmedClaim> = {}): ConfirmedClaim => ({
  bulletId: 'b:f1',
  bulletText: 'led a team of 12 engineers',
  decision: 'confirm',
  decidedBy: 'u1',
  decidedAt: '2026-08-24T00:00:00.000Z',
  ...over,
});

describe('bulletIdOf', () => {
  it('gives two identical-text bullets DIFFERENT ids', () => {
    // The whole point. `TailorService`/`ReviseService` guarantee one bullet per sourceFactId,
    // so identical text always means two distinct source facts — and therefore two distinct
    // claims the user must be able to rule on independently.
    const a = bullet({ sourceFactId: 'f1' });
    const b = bullet({ sourceFactId: 'f2' });
    expect(bulletIdOf(a)).not.toEqual(bulletIdOf(b));
  });

  it('gives the same bullet the same id on a re-render, even after a reword', () => {
    // confirmClaim rebuilds a render from the prior one. An id that moved when the text moved
    // would detach every earlier decision the moment a revision touched a sentence.
    const before = bullet({ sourceFactId: 'f7', text: 'shipped the billing service' });
    const after = bullet({ sourceFactId: 'f7', text: 'shipped billing end to end' });
    expect(bulletIdOf(after)).toEqual(bulletIdOf(before));
  });

  it('derives the SAME id for a legacy bullet with no stored bulletId', () => {
    // `provenance` is persisted jsonb. Rows written before this field exists must resolve
    // identically, or a stored render becomes undecidable.
    const stored = { text: 'x', sourceFactId: 'f3' };
    expect(bulletIdOf(stored)).toEqual(bulletIdOf(bullet({ sourceFactId: 'f3' })));
  });

  it('prefers an explicitly stored bulletId over the derived one', () => {
    expect(bulletIdOf({ sourceFactId: 'f3', bulletId: 'b:legacy-pinned' })).toBe('b:legacy-pinned');
  });

  it('raises rather than inventing an id for a bullet with no sourceFactId', () => {
    // A placeholder id would let two unidentifiable bullets collide onto one decision, which
    // is precisely the failure this module closes. Corrupt data must surface, not degrade.
    expect(() => bulletIdOf({ sourceFactId: '' })).toThrow(/cannot be identified/i);
  });

  it('withBulletIds stamps every bullet without disturbing its other fields', () => {
    const stamped = withBulletIds([bullet({ sourceFactId: 'f1' }), bullet({ sourceFactId: 'f2' })]);
    expect(stamped.map((b) => b.bulletId)).toEqual([bulletIdOf({ sourceFactId: 'f1' }), bulletIdOf({ sourceFactId: 'f2' })]);
    expect(stamped[0].verdict).toBe('overreach');
    expect(stamped[0].span).toBe('a team of 12');
  });
});

describe('decidedBulletIds', () => {
  it('resolves a modern claim by its bulletId, not by its text', () => {
    const bullets = [bullet({ sourceFactId: 'f1' }), bullet({ sourceFactId: 'f2' })];
    const decided = decidedBulletIds([claim({ bulletId: bulletIdOf(bullets[1]) })], bullets);

    // Only the SECOND of two identical-text bullets was decided — the exact case the old
    // text-equality gate could not express at all.
    expect(decided.has(bulletIdOf(bullets[1]))).toBe(true);
    expect(decided.has(bulletIdOf(bullets[0]))).toBe(false);
  });

  it('resolves a LEGACY claim (no bulletId) by text when that text is unambiguous', () => {
    // A user who confirmed a claim before this field existed must not have to confirm it
    // again — their audit row is still a real human decision.
    const bullets = [bullet({ sourceFactId: 'f1', text: 'ran postgres' })];
    const legacy = { ...claim({ bulletText: 'ran postgres' }), bulletId: undefined };
    expect(decidedBulletIds([legacy as ConfirmedClaim], bullets)).toEqual(
      new Set([bulletIdOf(bullets[0])]),
    );
  });

  it('refuses to resolve a LEGACY claim whose text matches two bullets', () => {
    // The row genuinely cannot say which one was decided. Clearing either would silently
    // approve a claim the user never ruled on; clearing neither keeps the gate closed and
    // makes the user re-decide, which is the safe direction.
    const bullets = [bullet({ sourceFactId: 'f1' }), bullet({ sourceFactId: 'f2' })];
    const legacy = { ...claim(), bulletId: undefined };
    expect(decidedBulletIds([legacy as ConfirmedClaim], bullets).size).toBe(0);
  });

  it('ignores a claim about a bullet that is no longer in the render', () => {
    const bullets = [bullet({ sourceFactId: 'f1', text: 'ran postgres' })];
    const stale = { ...claim({ bulletText: 'a bullet that was dropped' }), bulletId: undefined };
    expect(decidedBulletIds([stale as ConfirmedClaim], bullets).size).toBe(0);
  });
});
