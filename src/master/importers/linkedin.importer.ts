import { Injectable, Logger } from '@nestjs/common';

interface ZipEntry {
  entryName: string;
  isDirectory: boolean;
  getData(): Buffer;
}

export interface ZipArchive {
  getEntries(): ZipEntry[];
}

/**
 * Parses one CSV line honouring quoted fields. LinkedIn exports routinely contain commas
 * inside titles and descriptions, so a naive split loses data silently.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current);
  return fields.map((f) => f.trim());
}

/**
 * Splits a CSV body into records, honouring newlines inside quoted fields. Splitting on
 * `\n` first is wrong for LinkedIn: a multi-line `Description` then becomes extra rows, and
 * a row whose first field is a fragment of prose renders as `### Role — <fragment>` — a job
 * the candidate never held, invented by the parser and invisible downstream.
 */
export function splitCsvRecords(body: string): string[] {
  const records: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (char === '"') {
      // A doubled quote is an escaped literal, not a state change (mirrors parseCsvLine).
      if (inQuotes && body[i + 1] === '"') {
        current += '""';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && body[i + 1] === '\n') i += 1;
      records.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  records.push(current);
  return records;
}

function parseCsv(body: string): Record<string, string>[] {
  const records = splitCsvRecords(body).filter((record) => record.trim().length > 0);
  if (records.length === 0) return [];

  const headers = parseCsvLine(records[0]);
  return records.slice(1).map((record) => {
    const values = parseCsvLine(record);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

/**
 * Sentence terminators that do NOT end a sentence. Splitting naively on `.` shatters
 * "12.5%", "e.g.", and "J. R. Smith" into fragments; a fragment grounds nothing, so the
 * entailment validator (spec §6) can never match it back to a real claim.
 */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'cf', 'al', 'inc', 'ltd', 'llc', 'co', 'corp',
  'dept', 'est', 'no', 'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'ph.d', 'u.s',
  'u.k', 'a.m', 'p.m',
]);

const BULLET_MARKER = /^\s*(?:[•·▪◦‣∙*+]|[-–—](?=\s))\s*/;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * True when the `.` at `index` is part of a token rather than a sentence end: a decimal
 * (`12.5`), a single-letter initial (`J.`), or a known abbreviation (`e.g.`).
 */
function isNonTerminalPeriod(text: string, index: number): boolean {
  const next = text[index + 1];
  const prev = text[index - 1];

  // Decimal point: digit on both sides.
  if (prev && next && /\d/.test(prev) && /\d/.test(next)) return true;

  // Trailing word before the dot, lowercased, with any interior dots kept ("e.g", "ph.d").
  const before = text.slice(0, index);
  const token = (/[\p{L}\p{N}.]+$/u.exec(before)?.[0] ?? '').toLowerCase();
  if (token.length === 0) return false;

  // A single letter is an initial ("J. R. Smith"), never a sentence on its own.
  if (token.replace(/\./g, '').length === 1) return true;

  return ABBREVIATIONS.has(token.replace(/\.+$/, ''));
}

/**
 * Splits one sentence-per-claim out of a prose paragraph. Deterministic and
 * dependency-free on purpose, in the house style of `ai-tell.ts` and `diff.ts`: this runs
 * on the import path, where an LLM call would be both a cost and a fabrication surface.
 */
function splitSentences(paragraph: string): string[] {
  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < paragraph.length; i += 1) {
    const char = paragraph[i];
    if (char !== '.' && char !== '!' && char !== '?') continue;
    if (char === '.' && isNonTerminalPeriod(paragraph, i)) continue;

    // Absorb a run of terminators ("...", "?!") and any closing quote/bracket.
    let end = i;
    while (end + 1 < paragraph.length && '.!?'.includes(paragraph[end + 1])) end += 1;
    while (end + 1 < paragraph.length && '"”’)]'.includes(paragraph[end + 1])) end += 1;

    const next = paragraph[end + 1];
    // Only a boundary if whitespace (or nothing) follows; otherwise it is inside a token
    // such as a URL or a version number.
    if (next !== undefined && !/\s/.test(next)) {
      i = end;
      continue;
    }

    sentences.push(paragraph.slice(start, end + 1));
    start = end + 1;
    i = end;
  }

  sentences.push(paragraph.slice(start));
  return sentences;
}

/**
 * Turns a LinkedIn `Description` blob into one string per discrete claim (spec §6).
 *
 * LinkedIn's Description is free prose. Emitted as a single Markdown paragraph it extracts
 * as ONE giant fact for the whole role, so every tailored bullet binds to the same
 * `sourceFactId` (`tailor.service.ts`) and `entail.service.ts` is reduced to checking one
 * sentence against a whole paragraph — the two-layer grounding guarantee degrades to noise.
 *
 * Where the author already imposed a structure — bullet characters, or just line breaks —
 * that structure IS the claim boundary and is preserved verbatim; re-splitting it would
 * break apart a claim the candidate deliberately wrote as one unit. Only a genuinely
 * unstructured paragraph is split by sentence.
 */
export function splitDescription(description: string): string[] {
  if (description.trim().length === 0) return [];

  const lines = description
    .split(/\r?\n/)
    .map((line) => line.replace(BULLET_MARKER, '').trim())
    .filter((line) => line.length > 0);

  const units = lines.length > 1 ? lines : splitSentences(lines[0] ?? '');

  return units
    .map((unit) => unit.trim())
    // A fragment of only punctuation or whitespace states nothing and must never become a
    // fact: it would be an unfalsifiable claim sitting in the grounding snapshot.
    .filter((unit) => unit.length > 0 && HAS_LETTER_OR_DIGIT.test(unit));
}

@Injectable()
export class LinkedinImporter {
  private readonly logger = new Logger(LinkedinImporter.name);

  toMarkdown(archive: ZipArchive): string {
    const entries = archive.getEntries().filter((entry) => !entry.isDirectory);
    const find = (name: string): ZipEntry | undefined =>
      entries.find((entry) => entry.entryName.split('/').pop()?.toLowerCase() === name.toLowerCase());

    const positionsEntry = find('Positions.csv');
    if (!positionsEntry) {
      // Naming the file tells the user their export is the wrong one, not that we broke.
      throw new Error(
        'the archive does not contain Positions.csv. Request the full "Download your data" ' +
          'export from LinkedIn rather than a partial one.',
      );
    }

    const positions = parseCsv(positionsEntry.getData().toString('utf8'));
    if (positions.length === 0) {
      throw new Error('the LinkedIn export contains no positions');
    }

    // The H1 must be the candidate's name and there must be exactly one of them
    // (`render-markdown.ts#extractH1Name`). Emitting `# Experience` as the first heading
    // produced a nameless master CV that only failed much later, at generate(), with an
    // error naming neither LinkedIn nor this importer.
    const name = this.extractName(find('Profile.csv'));

    const sections: string[] = [`# ${name}`, '', '## Experience', ''];
    for (const row of positions) {
      const title = row['Title'] || 'Role';
      const company = row['Company Name'] || 'Unknown company';
      const from = row['Started On'] || '';
      const to = row['Finished On'] || 'Present';
      const period = from ? ` (${from} – ${to})` : '';

      sections.push(`### ${title} — ${company}${period}`);

      // One list item per claim, so fact extraction yields one fact per claim rather than
      // one paragraph-sized fact for the whole role (spec §6).
      const claims = splitDescription(row['Description'] ?? '');
      if (claims.length > 0) {
        // The `- ` prefix is itself the escape: inside a list item a leading `#`, `>` or
        // `1.` is literal text, so a description like "#1 seller" can no longer open a
        // second H1 and make `render-markdown.ts#extractH1Name` reject the CV as nameless.
        // Adding backslashes on top would leak `\#1 seller` into the fact text and from
        // there onto a CV an employer reads.
        sections.push('', ...claims.map((claim) => `- ${claim}`));
      }
      sections.push('');
    }

    const skillsEntry = find('Skills.csv');
    if (skillsEntry) {
      const skills = parseCsv(skillsEntry.getData().toString('utf8'))
        .map((row) => row['Name'])
        .filter((name) => name && name.length > 0);

      if (skills.length > 0) {
        sections.push('## Skills', '', skills.map((skill) => `- ${skill}`).join('\n'), '');
      }
    }

    this.logger.log(`converted LinkedIn export for ${name}: ${positions.length} positions`);
    return sections.join('\n').trim();
  }

  /**
   * Reads the candidate's name from Profile.csv. Raises rather than falling back to a
   * placeholder: a fabricated name on an exported CV is exactly what the H1-name
   * convention exists to prevent, and the archive genuinely carries the real one.
   */
  private extractName(profileEntry: ZipEntry | undefined): string {
    if (!profileEntry) {
      throw new Error(
        'the archive does not contain Profile.csv, so the CV would have no name. Request the ' +
          'full "Download your data" export from LinkedIn rather than a partial one.',
      );
    }

    const rows = parseCsv(profileEntry.getData().toString('utf8'));
    const first = rows[0]?.['First Name']?.trim() ?? '';
    const last = rows[0]?.['Last Name']?.trim() ?? '';
    const name = [first, last].filter((part) => part.length > 0).join(' ');

    if (name.length === 0) {
      throw new Error(
        'Profile.csv carries no First Name or Last Name, so the CV would have no name. ' +
          'Check the LinkedIn export is complete.',
      );
    }

    return name;
  }
}
