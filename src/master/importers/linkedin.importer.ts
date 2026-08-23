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

function parseCsv(body: string): Record<string, string>[] {
  const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
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

    const sections: string[] = ['# Experience', ''];
    for (const row of positions) {
      const title = row['Title'] || 'Role';
      const company = row['Company Name'] || 'Unknown company';
      const from = row['Started On'] || '';
      const to = row['Finished On'] || 'Present';
      const period = from ? ` (${from} – ${to})` : '';

      sections.push(`## ${title} — ${company}${period}`);
      if (row['Description']) sections.push('', row['Description']);
      sections.push('');
    }

    const skillsEntry = find('Skills.csv');
    if (skillsEntry) {
      const skills = parseCsv(skillsEntry.getData().toString('utf8'))
        .map((row) => row['Name'])
        .filter((name) => name && name.length > 0);

      if (skills.length > 0) {
        sections.push('# Skills', '', skills.map((skill) => `- ${skill}`).join('\n'), '');
      }
    }

    this.logger.log(`converted LinkedIn export: ${positions.length} positions`);
    return sections.join('\n').trim();
  }
}
