/**
 * Renders the same "# Name / ## Section / ### Title — Org (Period) / - bullet" markdown
 * shape that `cv-document.ts` parses for PDF/DOCX export (see that file's heading
 * convention), but leniently: this is a read-only preview, not an export path, so a line it
 * does not recognize is shown as a plain paragraph instead of raising. A person reviewing a
 * revision should always see *something* here, never a blank panel because one line was
 * slightly off the expected shape.
 */
const ENTRY_HEADING = /^(?<title>[^—]+?)?\s*—\s*(?<org>[^(].*?)?\s*(?:\((?<period>[^)]+)\))?$/;

interface PreviewEntry {
  title: string | null;
  org: string | null;
  period: string | null;
  bullets: string[];
}

interface PreviewSection {
  heading: string;
  entries: PreviewEntry[];
  /** Bullets or paragraphs that appeared directly under the section, before any `###`. */
  leadingBullets: string[];
}

interface Preview {
  name: string | null;
  contactParts: string[];
  sections: PreviewSection[];
}

function parse(markdown: string): Preview {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let name: string | null = null;
  const contactParts: string[] = [];
  const sections: PreviewSection[] = [];
  let currentSection: PreviewSection | null = null;
  let currentEntry: PreviewEntry | null = null;
  let sawH2 = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (!name && line.startsWith('# ')) {
      name = line.slice(2).trim();
      continue;
    }
    if (line.startsWith('## ')) {
      sawH2 = true;
      currentSection = { heading: line.slice(3).trim(), entries: [], leadingBullets: [] };
      currentEntry = null;
      sections.push(currentSection);
      continue;
    }
    if (line.startsWith('### ') && currentSection) {
      const heading = line.slice(4).trim();
      const match = heading.match(ENTRY_HEADING);
      currentEntry = {
        title: match?.groups?.title?.trim() || null,
        org: match?.groups?.org?.trim() || null,
        period: match?.groups?.period?.trim() || null,
        bullets: [],
      };
      if (!match) currentEntry.title = heading;
      currentSection.entries.push(currentEntry);
      continue;
    }
    if (line.startsWith('- ')) {
      const bullet = line.slice(2).trim();
      if (currentEntry) currentEntry.bullets.push(bullet);
      else if (currentSection) currentSection.leadingBullets.push(bullet);
      continue;
    }
    if (!sawH2) {
      // A plain line before the first section is a contact detail (email, phone, links).
      contactParts.push(...line.split('|').map((part) => part.trim()).filter(Boolean));
    } else if (currentEntry) {
      currentEntry.bullets.push(line);
    } else if (currentSection) {
      currentSection.leadingBullets.push(line);
    }
  }

  return { name, contactParts, sections };
}

export function CvPreview({ markdown }: { markdown: string }) {
  if (!markdown.trim()) {
    return <p className="muted">Nothing to preview yet.</p>;
  }
  const { name, contactParts, sections } = parse(markdown);

  return (
    <div className="cv-preview">
      {name && <h1 className="cv-preview-name">{name}</h1>}
      {contactParts.length > 0 && <p className="cv-preview-contact">{contactParts.join('  ·  ')}</p>}
      {sections.map((section, sectionIndex) => (
        <section key={sectionIndex} className="cv-preview-section">
          <h2>{section.heading}</h2>
          {section.leadingBullets.length > 0 && (
            <ul>
              {section.leadingBullets.map((bullet, index) => (
                <li key={index}>{bullet}</li>
              ))}
            </ul>
          )}
          {section.entries.map((entry, entryIndex) => (
            <div key={entryIndex} className="cv-preview-entry">
              {(entry.title || entry.org || entry.period) && (
                <p className="cv-preview-entry-heading">
                  {[entry.title, entry.org].filter(Boolean).join(' — ')}
                  {entry.period && <span className="cv-preview-entry-period"> ({entry.period})</span>}
                </p>
              )}
              {entry.bullets.length > 0 && (
                <ul>
                  {entry.bullets.map((bullet, index) => (
                    <li key={index}>{bullet}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
