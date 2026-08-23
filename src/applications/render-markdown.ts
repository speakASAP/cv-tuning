import { TailoredBullet } from './application.types';

const H1 = /^#\s+(.+?)\s*$/;

/**
 * Assembles `cv_render.markdown` so it matches the ONLY canonical heading convention in the
 * repo (`src/export/cv-document.ts`'s module doc comment, established by Task 6/7): H1 =
 * candidate name, H2 = section, H3 = entry.
 *
 * Deliberately NOT a full multi-section reconstruction. `FactSnapshot` carries only
 * `{factId, text, kind}` — no org, period, or section — and no importer (paste, upload,
 * gdocs, and least of all `linkedin.importer.ts#toMarkdown`, which emits `# Experience`
 * with no name heading at all) guarantees the master CV is H1/H2/H3-shaped either.
 * Inferring "Senior Developer — Acme (2019-2024)" from a fact's `kind` would not avoid
 * fabrication, it would relocate it into the export path, past both grounding layers, onto
 * a document that goes to an employer. So this builder only fills what the system can state
 * truthfully today: the candidate's own name (if the master CV states one) and the tailored
 * bullets, grouped under one honestly-named section. Full per-entry org/period
 * reconstruction needs facts (or the master markdown) to carry that structure explicitly —
 * logged as a Phase 5 candidate, not attempted here.
 */
export class MissingMasterNameError extends Error {
  constructor() {
    super(
      'the master CV has no "# Your Name" heading, so a render cannot state who the CV ' +
        'belongs to. Add a name heading (e.g. "# Jane Doe") to the top of the master CV, ' +
        'save it, then regenerate this application.',
    );
    this.name = 'MissingMasterNameError';
  }
}

/**
 * Pulls the candidate's name from the first H1 line in `markdown`. Never fabricates a
 * placeholder (no "CV", no email-derived name) — raises `MissingMasterNameError` instead,
 * because a fabricated name on an exported CV is a worse failure than a loud, immediate one.
 */
export function extractH1Name(markdown: string): string {
  const matches = markdown
    .split('\n')
    .map((line) => H1.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null);

  // Exactly one H1 is the convention's own definition of "this document states a name"
  // (`cv-document.ts` raises on a second H1 as ambiguous). Zero means no name was ever
  // given; two or more (e.g. `linkedin.importer.ts#toMarkdown`'s `# Experience` / `# Skills`
  // section headings) means the document does not conform to the H1-name convention at all,
  // so there is no single H1 to trust as a name either — both are the same "absent" case,
  // never a pick-one guess.
  if (matches.length !== 1) {
    throw new MissingMasterNameError();
  }

  return matches[0][1].trim();
}

/**
 * Builds structured render markdown: H1 name (from `masterMarkdown`) + one H2 holding the
 * tailored bullets. `sourceMarkdown` is either the pinned master's markdown (generate/revise)
 * or a prior render's own markdown (confirmClaim) — both carry the same H1 by construction,
 * since every render this function has ever produced started from the master's name.
 */
export function buildRenderMarkdown(sourceMarkdown: string, bullets: Pick<TailoredBullet, 'text'>[]): string {
  const name = extractH1Name(sourceMarkdown);
  const bulletLines = bullets.map((b) => `- ${b.text}`).join('\n');
  return `# ${name}\n\n## Tailored Highlights${bulletLines ? `\n\n${bulletLines}` : ''}`;
}
