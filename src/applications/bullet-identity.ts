import { ConfirmedClaim, TailoredBullet } from './application.types';

/**
 * Stable per-render identity for a `TailoredBullet` (spec §6 layer 3).
 *
 * WHY THIS EXISTS. `confirmClaim` used to resolve its target with `bullets.find(b => b.text
 * === bulletText)`, and the approval gate compared `ConfirmedClaim.bulletText` against
 * `bullet.text`. Two `overreach` bullets with identical text in one render were therefore
 * indistinguishable: `find` always returned the first, the second could never be decided, and
 * the approval gate blocked forever on a claim the user had no way to resolve. That is a
 * permanent dead end reachable through normal use — a model can legitimately produce the same
 * sentence from two different master facts.
 *
 * WHY `sourceFactId` IS THE ID. It is already unique within a render's bullet array by
 * construction: both `TailorService` and `ReviseService` drop a bullet whose `sourceFactId`
 * was already used ("fabrication by division"), so no two bullets in a saved render can share
 * one. It is also *stable* across a `confirmClaim` re-render, which reuses the prior render's
 * bullet objects verbatim — a content hash over `text` would have been equally unique but
 * would detach a user's earlier decisions the moment a revision reworded the sentence, and a
 * positional index would detach the moment a `drop` removed an earlier bullet.
 *
 * Deriving rather than generating (no uuid) is what makes legacy rows safe: `provenance` and
 * `confirmedOverreach` are persisted `jsonb`, so renders written before this field exists have
 * no `bulletId`. `bulletIdOf` recomputes exactly the same value from the `sourceFactId` those
 * rows already carry, so an old render resolves identically to a new one — no migration, no
 * fallback to the ambiguous text match, and no possibility of silently mis-resolving a
 * decision onto the wrong bullet.
 *
 * The id is INTERNAL. It is never written into `cv_render.markdown` — `buildRenderMarkdown`
 * takes only `text`/`sourceFactId` — so the exported PDF/DOCX bytes and the artifact sha256
 * that spec §6.3 reuses for idempotency are untouched by it.
 */
const ID_PREFIX = 'b:';

/**
 * The identity of one bullet within its render.
 *
 * Accepts a stored `bulletId` when present and derives it from `sourceFactId` otherwise, so
 * the same bullet resolves to the same id whether it was written before or after this field
 * existed. Raises on a bullet carrying neither: an unidentifiable bullet cannot be confirmed
 * or dropped, and returning a placeholder would let two of them collide onto one decision —
 * exactly the bug this module exists to close.
 */
export function bulletIdOf(bullet: Pick<TailoredBullet, 'sourceFactId'> & { bulletId?: string }): string {
  if (typeof bullet.bulletId === 'string' && bullet.bulletId.trim()) {
    return bullet.bulletId.trim();
  }

  const factId = typeof bullet.sourceFactId === 'string' ? bullet.sourceFactId.trim() : '';
  if (!factId) {
    throw new Error(
      'tailored bullet has neither a bulletId nor a sourceFactId, so it cannot be identified ' +
        'for a confirm-or-drop decision; the render is corrupt',
    );
  }

  return `${ID_PREFIX}${factId}`;
}

/** Stamps `bulletId` onto freshly validated bullets, before they are persisted. */
export function withBulletIds(bullets: TailoredBullet[]): TailoredBullet[] {
  return bullets.map((bullet) => ({ ...bullet, bulletId: bulletIdOf(bullet) }));
}

/**
 * The set of bullet ids the user has already ruled on.
 *
 * A `ConfirmedClaim` written before `bulletId` existed carries only `bulletText`. Those are
 * matched back to a bullet by text — the only information the row has — but ONLY when the
 * text is unambiguous within the render. When two bullets share that text the legacy claim
 * cannot say which one was decided, so it resolves to neither and the approval gate keeps
 * blocking: a stale audit row must never be allowed to silently clear a claim the user did
 * not actually rule on. New claims always carry `bulletId` and never take this path.
 */
export function decidedBulletIds(
  claims: (ConfirmedClaim & { bulletId?: string })[],
  bullets: (Pick<TailoredBullet, 'text' | 'sourceFactId'> & { bulletId?: string })[],
): Set<string> {
  const decided = new Set<string>();

  const byText = new Map<string, string[]>();
  for (const bullet of bullets) {
    const ids = byText.get(bullet.text) ?? [];
    ids.push(bulletIdOf(bullet));
    byText.set(bullet.text, ids);
  }

  for (const claim of claims) {
    if (typeof claim.bulletId === 'string' && claim.bulletId.trim()) {
      decided.add(claim.bulletId.trim());
      continue;
    }

    const candidates = byText.get(claim.bulletText) ?? [];
    if (candidates.length === 1) {
      decided.add(candidates[0]);
    }
    // length 0: the claim refers to a bullet no longer in this render (it was dropped, or a
    // revision reworded it) — nothing to clear. length > 1: ambiguous, see the doc comment.
  }

  return decided;
}
