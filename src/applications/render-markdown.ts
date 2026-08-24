import { FactSnapshot, TailoredBullet } from './application.types';

const H1 = /^#\s+(.+?)\s*$/;

/**
 * Heading for bullets whose source fact has no derivable `section` — either the fact predates
 * `section`/`org`/`period` (the migration deliberately did not backfill), the master CV had no
 * headings to derive from (a heading-less gdocs/document import), or `fact-provenance.ts`
 * refused to map it confidently.
 *
 * These bullets are NOT dropped and NOT folded into a neighbouring section: dropping a bullet
 * the user reviewed is a silent failure, and filing it under someone else's employer is the
 * fabrication this product exists to prevent. They get their own honestly-vague, trailing
 * heading instead. If the master CV genuinely has a section by this name, orphans join it
 * rather than creating a second section with the same heading.
 */
const GENERAL_SECTION = 'Additional Highlights';

/** `cv-document.ts`'s mandatory entry separator. A hyphen is not it — see ENTRY_HEADING there. */
const EM_DASH = '—';

/**
 * Assembles `cv_render.markdown` to the ONLY canonical heading convention in the repo
 * (`src/export/cv-document.ts`'s module doc comment): H1 = candidate name, H2 = section,
 * H3 = entry, `- ` = bullet.
 *
 * Since Phase 5 this is a real multi-section reconstruction. `FactSnapshot` now carries
 * `{section, org, period}`, derived deterministically **in code** by walking the master
 * markdown's headings (`master/fact-provenance.ts`) and never reported by the extraction
 * model — so grouping a bullet under its source fact's employer restates structure the user
 * themselves wrote, rather than inferring it. That distinction is the whole reason this is
 * now safe to do: inferring "Senior Developer — Acme (2019-2024)" from a fact's `kind` would
 * have relocated fabrication into the export path, past both grounding layers, onto a
 * document that goes to an employer.
 *
 * Nulls print as nothing and are never filled from a neighbour (see `GENERAL_SECTION` and
 * `entryHeading`). Facts carry no job title — nothing in the fact graph does — so entries are
 * written title-less, as `### — Org (Period)`.
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

/** One `### ` entry under a section: a distinct (org, period) pair and the bullets under it. */
interface RenderEntry {
  org: string | null;
  period: string | null;
  bullets: string[];
}

interface RenderSection {
  heading: string;
  entries: RenderEntry[];
}

/**
 * Builds structured render markdown: H1 name (from `sourceMarkdown`) followed by one H2 per
 * section the tailored bullets' source facts came from, each holding one H3 entry per distinct
 * (org, period).
 *
 * `sourceMarkdown` is either the pinned master's markdown (generate/revise) or a prior
 * render's own markdown (confirmClaim) — both carry the same single H1 by construction, since
 * every render this function has ever produced started from the master's name. Only the name
 * is read from it; all structure comes from `facts`, so the confirmClaim round-trip is
 * idempotent rather than accumulating a copy of the previous layout.
 *
 * `facts` is required, not defaulted: an omitted snapshot would quietly file every bullet
 * under `GENERAL_SECTION` and produce a structurally poorer CV with no error anywhere.
 *
 * ORDERING IS DETERMINISTIC BY CONTRACT. Sections, entries within a section, and bullets
 * within an entry are all ordered by first appearance in `bullets`, with `GENERAL_SECTION`
 * forced last. `facts` is used only as a lookup, so its own order cannot influence the output.
 * `cv-pdf.service.ts` pins `info.CreationDate` because spec §6.3 reuses the artifact sha256
 * for idempotency; a grouping whose order could vary would defeat that pin just as thoroughly
 * as a wall-clock timestamp.
 */
export function buildRenderMarkdown(
  sourceMarkdown: string,
  bullets: Pick<TailoredBullet, 'text' | 'sourceFactId'>[],
  facts: Pick<FactSnapshot, 'factId' | 'section' | 'org' | 'period'>[],
): string {
  const name = extractH1Name(sourceMarkdown);

  const byFactId = new Map(facts.map((f) => [f.factId, f]));
  const sections: RenderSection[] = [];

  for (const bullet of bullets) {
    // An unresolvable sourceFactId is not a reason to lose the bullet: confirmClaim re-renders
    // from a stored snapshot, and a user must never silently lose content they already
    // reviewed. It lands in the general section, with no org or period attributed to it.
    const fact = byFactId.get(bullet.sourceFactId);
    const heading = fact?.section ?? GENERAL_SECTION;
    const org = fact?.org ?? null;
    const period = fact?.period ?? null;

    let section = sections.find((s) => s.heading === heading);
    if (!section) {
      section = { heading, entries: [] };
      sections.push(section);
    }

    // Entry identity is the exact (org, period) pair, nulls included: two stints at one
    // employer are two entries, and merging them would assert a continuous tenure the CV
    // never claimed. Equally, an org-less bullet never joins an org'd entry.
    let entry = section.entries.find((e) => e.org === org && e.period === period);
    if (!entry) {
      entry = { org, period, bullets: [] };
      section.entries.push(entry);
    }

    entry.bullets.push(normalizeBulletText(bullet.text));
  }

  // Explicit, stable sort key rather than relying on where the first orphan happened to land:
  // the general bucket is a catch-all and reads as noise above real sections.
  const ordered = [
    ...sections.filter((s) => s.heading !== GENERAL_SECTION),
    ...sections.filter((s) => s.heading === GENERAL_SECTION),
  ];

  const parts = [`# ${name}`];
  for (const section of ordered) {
    parts.push(`## ${section.heading}`);
    for (const entry of section.entries) {
      parts.push(`### ${entryHeading(entry)}`);
      parts.push(...entry.bullets.map((b) => `- ${b}`));
    }
  }

  // A render with no bullets still needs a section: `cv-document.ts` raises on a bullet or
  // entry that precedes any `## `, and a nameless-but-sectionless document is not a shape the
  // rest of the pipeline expects.
  if (ordered.length === 0) {
    parts.push(`## ${GENERAL_SECTION}`);
  }

  return parts.join('\n\n');
}

/**
 * `— Acme (2019-2024)`, `— Acme`, `— (2019-2024)`, or a bare `—`.
 *
 * The leading em dash marks the absent title: `cv-document.ts`'s `ENTRY_HEADING` requires the
 * em dash as the title/org separator (a hyphen is too common inside real org names to use),
 * and no fact carries a job title, so every entry this builder writes is title-less. A null
 * org or period contributes nothing — never a value borrowed from another entry.
 *
 * An entry with NEITHER org nor period still gets its bare `—` heading rather than no heading
 * at all. This is load-bearing, not cosmetic: `cv-document.ts` attaches a bullet to the entry
 * most recently opened, so an unattributed group emitted after `### — Acme (2019-2024)` with
 * no heading of its own would be read as more of Acme's work — a real employer stamped onto a
 * bullet the fact graph never connected to it, which is exactly the failure this product
 * exists to prevent. The bare heading resets attribution and renders as nothing in both
 * writers (they emit a heading only when a title or org is present).
 */
function entryHeading(entry: RenderEntry): string {
  const period = entry.period ? `(${entry.period})` : '';
  const org = entry.org ?? '';
  return [EM_DASH, org, period].filter(Boolean).join(' ');
}

/**
 * Neither `TailorService` nor `ReviseService` normalizes model output beyond truthiness, so a
 * bullet can arrive multi-line (breaking `cv-document.ts`'s one-bullet-per-line parse at
 * EXPORT time, after the render has already been saved, reviewed, and possibly approved — no
 * retry path exists) or starting with `# ` (which `extractH1Name` then counts as a second H1,
 * raising `MissingMasterNameError` for a problem that has nothing to do with the master CV).
 * Collapsing here — rather than at generation time — also covers renders already written to
 * the database, since `confirmClaim` re-parses a prior render's own markdown through this
 * same builder.
 */
function normalizeBulletText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  // A leading '#' (any run of them) would be read as a heading marker by the H1/H2/H3
  // convention this markdown is built for — neutralize it without disturbing the rest of
  // the sentence, e.g. "# 1 revenue driver" -> "1 revenue driver".
  return collapsed.replace(/^#+\s*/, '');
}
