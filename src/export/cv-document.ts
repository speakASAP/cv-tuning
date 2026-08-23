/**
 * The one document model both exporters render from (spec §6.1).
 *
 * Deliberately NOT a general Markdown implementation: renders are a known narrow shape, and
 * a generic Markdown->DOCX path produces output that parses worse in ATS. Input this cannot
 * parse raises — a CV silently missing a section is exactly the failure this codebase exists
 * to prevent.
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

/** `Senior Developer — Acme (2019-2024)` -> its three parts. Em dash or hyphen. */
const ENTRY_HEADING = /^(?<title>[^—-]+?)\s*[—-]\s*(?<org>.+?)\s*(?:\((?<period>[^)]+)\))?$/;

export function renderToDocument(markdown: string): CvDocument {
  const trimmed = markdown.trim();
  if (!trimmed) {
    throw new Error('cannot render an empty CV to a document');
  }

  const lines = trimmed.split('\n');
  let name: string | null = null;
  const contactParts: string[] = [];
  const sections: CvSection[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('# ')) {
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
        throw new Error(`entry heading "${line}" appears before any section heading`);
      }
      const text = line.slice(4).trim();
      const match = ENTRY_HEADING.exec(text);
      section.entries.push({
        title: match?.groups?.title?.trim() ?? text,
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
        throw new Error(`bullet "${bullet}" appears before any section heading`);
      }
      if (section.entries.length === 0) {
        // A section like "Skills" lists bullets with no entry heading above them.
        section.entries.push({ title: null, org: null, period: null, bullets: [] });
      }
      section.entries[section.entries.length - 1].bullets.push(bullet);
      continue;
    }

    // Any other non-empty line before the first section is contact detail.
    if (sections.length === 0 && name) {
      contactParts.push(...line.split('|').map((p) => p.trim()).filter(Boolean));
    }
  }

  if (!name) {
    throw new Error('CV markdown has no H1 name heading; refusing to render a nameless document');
  }

  return { contact: { name, parts: contactParts }, sections };
}
