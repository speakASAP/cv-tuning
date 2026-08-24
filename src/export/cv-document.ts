/**
 * The one document model both exporters render from (Phase 4 spec §6.1).
 *
 * Deliberately NOT a general Markdown implementation: renders are a known narrow shape, and
 * a generic Markdown->DOCX path produces output that parses worse in ATS. Input this cannot
 * parse raises — a CV silently missing a section is exactly the failure this codebase exists
 * to prevent. This is enforced for every line, not just the top-level empty/no-H1 cases: a
 * stray prose line, a malformed `###` heading (e.g. missing the space), a `*` bullet marker,
 * or a second `# ` heading all raise rather than being dropped or silently overwriting data.
 *
 * Heading convention (established here — this is the ONLY canonical CV-markdown heading
 * scheme in the repo; the rest of the codebase does not have one, and neither
 * `linkedin.importer.ts#toMarkdown` nor `ApplicationsService#generate`'s current bullet-only
 * output follow it. Task 7 and Task 8 must build markdown to this shape rather than inventing
 * their own):
 *   H1  `# Name`                          -> contact.name (exactly one, required)
 *   —   plain line(s) before the first H2 -> contact.parts (split on `|`)
 *   H2  `## Heading`                      -> a CvSection
 *   H3  `### Title — Org (Period)`        -> a CvEntry under the current section
 *   `-` bullet                            -> appended to the entry above it (or a headless
 *                                            entry, for sections like "Skills" with no H3s)
 */

export interface CvContact {
  name: string;
  /** Email, phone, links — rendered as one line, in the order the user wrote them. */
  parts: string[];
}

export interface CvEntry {
  title: string | null;
  org: string | null;
  period: string | null;
  bullets: string[];
}

export interface CvSection {
  heading: string;
  entries: CvEntry[];
}

export interface CvDocument {
  contact: CvContact;
  sections: CvSection[];
}

/**
 * `Senior Developer — Acme (2019-2024)` -> its three parts. Split strictly on the em dash:
 * a plain hyphen is common inside titles ("Full-Stack Developer") and company names
 * ("Acme-Corp"), so treating it as a separator too mis-splits those (Phase 4 review).
 *
 * Title, org, and period are each independently optional AFTER the em dash, which stays
 * mandatory as the separator. That admits four further forms, all of which
 * `render-markdown.ts#buildRenderMarkdown` emits, because a fact carries a derived
 * `org`/`period` (either of which may be null) but nothing in the fact graph carries a job
 * title:
 *   `— Acme (2019-2024)` -> {null, 'Acme', '2019-2024'}
 *   `— Acme`             -> {null, 'Acme', null}
 *   `— (2019-2024)`      -> {null, null, '2019-2024'}
 *   `—`                  -> {null, null, null}  (an entry that resets attribution and no more)
 * Inventing a title would put a fabrication on the fields an employer judges a CV by; dropping
 * the org to dodge the missing title would lose real information; and the bare `—` form exists
 * so a fully unattributed group of bullets cannot silently attach to the entry above it and
 * inherit somebody else's employer.
 *
 * `org` may not begin with `(` so that `— (2019-2024)` reads as a period rather than as an org
 * literally named "(2019-2024)". An un-dashed heading (`### Acme`) does not match at all and is
 * still read wholly as a title, so the master-CV shape is untouched.
 */
const ENTRY_HEADING = /^(?<title>[^—]+?)?\s*—\s*(?<org>[^(].*?)?\s*(?:\((?<period>[^)]+)\))?$/;

export function renderToDocument(markdown: string): CvDocument {
  const trimmed = markdown.trim();
  if (!trimmed) {
    throw new Error('cannot render an empty CV to a document');
  }

  const lines = trimmed.split('\n');
  let name: string | null = null;
  const contactParts: string[] = [];
  const sections: CvSection[] = [];

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const lineNo = index + 1;

    if (line.startsWith('# ')) {
      if (name !== null) {
        // A second H1 silently overwriting the first would replace the candidate's name
        // with no trace — same failure class as a dropped section, just smaller blast radius.
        throw new Error(
          `line ${lineNo}: duplicate H1 name heading "${line}" (already have "${name}"); ` +
            'a CV markdown document must have exactly one H1',
        );
      }
      name = line.slice(2).trim();
      continue;
    }

    if (line.startsWith('## ')) {
      sections.push({ heading: line.slice(3).trim(), entries: [] });
      continue;
    }

    if (line.startsWith('### ')) {
      const section = sections[sections.length - 1];
      if (!section) {
        throw new Error(`line ${lineNo}: entry heading "${line}" appears before any section heading`);
      }
      const text = line.slice(4).trim();
      const match = ENTRY_HEADING.exec(text);
      section.entries.push({
        // No match at all -> the whole heading is the title (an un-dashed `### Acme`). A match
        // with an empty title group is the deliberate title-less form and must stay null: a
        // heading falling back to `text` there would print a stray leading em dash on the CV.
        title: match ? (match.groups?.title?.trim() || null) : text,
        org: match?.groups?.org?.trim() ?? null,
        period: match?.groups?.period?.trim() ?? null,
        bullets: [],
      });
      continue;
    }

    if (line.startsWith('- ')) {
      const bullet = line.slice(2).trim();
      const section = sections[sections.length - 1];
      if (!section) {
        throw new Error(`line ${lineNo}: bullet "${bullet}" appears before any section heading`);
      }
      if (section.entries.length === 0) {
        // A section like "Skills" lists bullets with no entry heading above them.
        section.entries.push({ title: null, org: null, period: null, bullets: [] });
      }
      section.entries[section.entries.length - 1].bullets.push(bullet);
      continue;
    }

    // Any other non-empty line before the first section is contact detail — deliberately
    // permissive, since a contact block has no fixed shape (name, email, phone, links...).
    if (sections.length === 0) {
      if (!name) {
        // Unreachable in practice (the H1 branch above always sets `name` first for any
        // line that could reach here), kept only so this carve-out never silently accepts
        // a line before the H1 is seen.
        throw new Error(`line ${lineNo}: content "${line}" appears before the H1 name heading`);
      }
      contactParts.push(...line.split('|').map((p) => p.trim()).filter(Boolean));
      continue;
    }

    // Once inside a section, every line must be a recognised marker (##, ###, -). Anything
    // else — stray prose, a malformed "###Heading" missing its space, a "*" bullet — must
    // raise rather than vanish: a missing space is an easy typo, and silently dropping the
    // entry it was meant to start is exactly the failure class this parser exists to prevent.
    throw new Error(
      `line ${lineNo}: unrecognised content "${line}" inside section "${sections[sections.length - 1].heading}" ` +
        '(expected a "## " section, "### " entry, or "- " bullet line)',
    );
  }

  if (!name) {
    throw new Error('CV markdown has no H1 name heading; refusing to render a nameless document');
  }

  return { contact: { name, parts: contactParts }, sections };
}
