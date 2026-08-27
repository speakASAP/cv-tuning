import { FactSnapshot, TailoredBullet } from './application.types';
import { selectProofFacts } from '../master/proof';

const H1 = /^#\s+(.+?)\s*$/;

/** A markdown list or blockquote marker: structure, never contact detail. */
const LIST_OR_QUOTE = /^(?:[-*+]\s|>)/;

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

/**
 * Heading for `cv_fact.kind = 'proof'` facts — portfolio links, repositories, case studies.
 *
 * Emitted between the real sections and `GENERAL_SECTION`: proof is stronger evidence than the
 * orphan catch-all and belongs above it, but it is not one of the master CV's own sections and
 * must not displace them.
 */
const PROOF_SECTION = 'Proof of Work';

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
 * `entryHeading`). The job title is derived the same way, from the `### Role — Org (Period)`
 * heading, so an entry reads `### Senior Developer — Acme (2019-2024)`; an entry whose title
 * could not be derived keeps the older title-less `### — Acme (2019-2024)` form rather than
 * borrowing a neighbour's role.
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
 * One `### ` entry under a section: a distinct (title, org, period) triple and its bullets.
 */
interface RenderEntry {
  title: string | null;
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
 * (title, org, period), preceded by the master's own contact line(s).
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
  facts: Pick<FactSnapshot, 'factId' | 'text' | 'kind' | 'section' | 'title' | 'org' | 'period'>[],
): string {
  const name = extractH1Name(sourceMarkdown);
  const contact = extractContactLines(sourceMarkdown);

  const byFactId = new Map(facts.map((f) => [f.factId, f]));
  const sections: RenderSection[] = [];

  for (const bullet of bullets) {
    // An unresolvable sourceFactId is not a reason to lose the bullet: confirmClaim re-renders
    // from a stored snapshot, and a user must never silently lose content they already
    // reviewed. It lands in the general section, with no org or period attributed to it.
    const fact = byFactId.get(bullet.sourceFactId);
    const heading = fact?.section ?? GENERAL_SECTION;
    const title = normalizeHeadingField(fact?.title ?? null);
    const org = fact?.org ?? null;
    const period = fact?.period ?? null;

    let section = sections.find((s) => s.heading === heading);
    if (!section) {
      section = { heading, entries: [] };
      sections.push(section);
    }

    // Entry identity is the exact (title, org, period) TRIPLE, nulls included.
    //
    // Why the title is part of the key: a promotion inside one company ("Lead Developer" then
    // "Principal Engineer" at Acme, overlapping periods) is two real entries on a CV, and
    // keying on (org, period) alone would merge them and silently discard one of the two job
    // titles the master CV actually states. The reverse case — the same role at two employers
    // — was already two entries and stays two, since the org differs.
    //
    // Nulls are values, not wildcards: a title-less bullet never joins a titled entry at the
    // same employer, because "unknown role" is not "the role of whatever entry sits next to
    // it". Same rule that already keeps two stints at one employer apart, and that keeps an
    // org-less bullet out of an org'd entry.
    let entry = section.entries.find(
      (e) => e.title === title && e.org === org && e.period === period,
    );
    if (!entry) {
      entry = { title, org, period, bullets: [] };
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
  // Re-emitted in `cv-document.ts`'s position for contact detail: after the H1, before the
  // first `## `. Joined with ` | ` because that is the separator the parser splits on, which
  // is what makes this round-trip stable (see `extractContactLines`).
  if (contact.length > 0) {
    parts.push(contact.join(' | '));
  }
  const proof = selectProofFacts(facts);

  for (const section of ordered) {
    // Proof sits above the orphan catch-all, so it is emitted when the general section is
    // reached rather than appended after the loop.
    if (section.heading === GENERAL_SECTION) {
      appendProofSection(parts, proof);
    }
    parts.push(`## ${section.heading}`);
    for (const entry of section.entries) {
      parts.push(`### ${entryHeading(entry)}`);
      parts.push(...entry.bullets.map((b) => `- ${b}`));
    }
  }

  const hasGeneralSection = ordered.some((s) => s.heading === GENERAL_SECTION);
  if (!hasGeneralSection) {
    appendProofSection(parts, proof);
  }

  // A render with no bullets still needs a section: `cv-document.ts` raises on a bullet or
  // entry that precedes any `## `, and a nameless-but-sectionless document is not a shape the
  // rest of the pipeline expects. A proof-only render already satisfies that, so the empty
  // catch-all is emitted only when nothing else was.
  if (ordered.length === 0 && proof.length === 0) {
    parts.push(`## ${GENERAL_SECTION}`);
  }

  return parts.join('\n\n');
}

/**
 * Writes the proof section, or nothing at all when there is no proof to write.
 *
 * The emptiness check is the whole point of the helper: an `## Proof of Work` heading with no
 * items under it is a defect the CV's reader sees, on a document that goes to an employer.
 *
 * Items are reproduced verbatim from the fact text (see `master/proof.ts`), which is why this
 * path needs no entailment pass — a proof link is not a tailored claim, nothing was rewritten,
 * and there is no `sourceFactId` binding to validate. It is deliberately derived from `facts`
 * rather than from the bullets for the same reason: no bullet cites a portfolio URL, so a
 * bullets-derived proof section would always be empty.
 *
 * Every item is emitted under a bare `### —` entry heading. `cv-document.ts` attaches a bullet
 * to the most recently opened entry, so proof bullets emitted with no heading of their own
 * would be read as more of the previous section's last employer — a real company stamped onto
 * a link the fact graph never connected to it.
 */
function appendProofSection(parts: string[], proof: ReturnType<typeof selectProofFacts>): void {
  if (proof.length === 0) {
    return;
  }

  parts.push(`## ${PROOF_SECTION}`);
  parts.push(`### ${EM_DASH}`);
  parts.push(
    ...proof.map((item) => `- ${item.url ? `${item.label} ${EM_DASH} ${item.url}` : item.label}`),
  );
}

/**
 * `Senior Developer — Acme (2019-2024)`, `— Acme`, `— (2019-2024)`, or a bare `—`.
 *
 * The em dash is `cv-document.ts`'s `ENTRY_HEADING` separator (a hyphen is too common inside
 * real titles and org names to use), and it is emitted unconditionally — a LEADING em dash is
 * how a title-less entry is written, which is the shape every entry had before facts carried
 * `title`, and still the shape whenever the title could not be derived. A null title, org, or
 * period contributes nothing — never a value borrowed from another entry.
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
  const title = entry.title ?? '';
  return [title, EM_DASH, org, period].filter(Boolean).join(' ');
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

/**
 * The contact line(s) the master CV states between its H1 and its first `## ` heading —
 * email, phone, links. `cv-document.ts` parses exactly that position into `contact.parts`
 * (splitting on `|`) and both writers render them, so without this the exported CV goes out
 * with no way for an employer to reply to it.
 *
 * IDEMPOTENCY IS THE HARD PART. `confirmClaim` (applications.service.ts) feeds a PRIOR
 * RENDER'S OWN markdown back in as `sourceMarkdown`, so this re-reads output this function
 * itself wrote. It round-trips exactly because the emitted form is the canonical one: parts
 * are split on `|`, trimmed, whitespace-collapsed, and re-joined with ` | ` on a single line,
 * so extracting from that line yields the identical array. Pinned by a multi-pass test in
 * `render-markdown.spec.ts` — a second pass that duplicated or dropped the block would only
 * surface in production, on the artifact the user downloads.
 *
 * Only lines that are plainly not structure are taken. A `#`/`##`/`###` heading, a `- `/`* `
 * bullet, or a `>` quote before the first section is markdown structure, not contact detail,
 * and swallowing one would put a CV bullet in the exported document's header. Everything else
 * is kept verbatim: a contact line legitimately contains em dashes and parentheses
 * ("Prague, CZ — open to relocation (EU)") and is never parsed as an entry heading, because
 * this position is read before any section exists.
 *
 * A master with no contact block yields an empty array, which emits nothing. That is a normal
 * input, not a failure.
 */
function extractContactLines(markdown: string): string[] {
  const parts: string[] = [];
  let seenH1 = false;

  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    // The first `## ` ends the contact region; everything after it belongs to a section.
    if (line.startsWith('## ')) break;

    if (H1.test(line)) {
      seenH1 = true;
      continue;
    }

    // Before the H1 there is nothing to attach contact detail to, and after a `#`, `-`, `*`,
    // or `>` marker the line is structure. Skipped rather than raised: `extractH1Name` above
    // already owns the "this document does not state a name" failure, and a stray marker line
    // is not a reason to refuse to export a CV that is otherwise complete.
    if (!seenH1 || line.startsWith('#') || LIST_OR_QUOTE.test(line)) continue;

    parts.push(
      ...line
        .split('|')
        .map((part) => part.replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    );
  }

  return parts;
}

/**
 * Makes a derived field safe to write inside a `### ` entry heading.
 *
 * A job title comes from the user's own master markdown, so it can contain anything they
 * typed — including the em dash `cv-document.ts` uses as the title/org separator, which would
 * make `### Lead — Deputy — Acme (2019)` re-parse as an ambiguous heading and silently
 * relabel the employer, and newlines, which would break the one-heading-per-line parse
 * outright. Both are neutralised rather than dropped: losing a real job title is a silent
 * loss, and mangling the employer is a fabrication. The em dash becomes a hyphen, which reads
 * naturally inside a title and is explicitly NOT a separator in `ENTRY_HEADING`.
 */
function normalizeHeadingField(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value.replace(/\s+/g, ' ').replace(new RegExp(EM_DASH, 'g'), '-').trim();
  return cleaned.length > 0 ? cleaned : null;
}
