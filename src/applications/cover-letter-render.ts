/**
 * The code-built prose of a cover letter.
 *
 * This module is what keeps the "every model-authored sentence binds to exactly one fact"
 * invariant ABSOLUTE rather than approximate. A letter needs connective sentences — a
 * salutation, a line naming the role, a sign-off — that no CV fact supports. The alternative
 * designs both fail: letting the model write them puts unbindable sentences into the
 * validator, forcing a "not a claim" verdict that becomes the hole every fabrication
 * eventually fits through; and exempting them by rule means the rule has a carve-out that has
 * to be re-argued at every future prompt change.
 *
 * Building them in code from the PARSED JOB instead means the model's output is 100% claims,
 * the validator needs no exception, and the only names on the page came from the job posting
 * the user themselves supplied.
 */

export interface LetterParts {
  /** From the master CV's own H1 — the same source `render-markdown.ts` reads. */
  candidateName: string;
  /** The master's contact block, already joined. Null when the CV states none. */
  contactLine: string | null;
  /** From the job parser. Null when the posting did not state one. */
  jobTitle: string | null;
  company: string | null;
  /** Validated, grounded body paragraphs, in the order they should read. */
  paragraphs: string[];
  language: string;
}

/**
 * Builds the letter.
 *
 * DETERMINISTIC BY CONTRACT: paragraphs in array order, fixed separators, no date, no
 * `Intl`-dependent formatting. The letter is exported as a PDF whose sha256 is reused as
 * artifact identity (spec §6.3), so a wall-clock or locale-dependent string here would break
 * idempotency exactly as an unpinned `CreationDate` once did — a recorded trap, not a
 * hypothetical.
 *
 * Nulls follow the house rule: a null prints nothing and is never filled from a neighbouring
 * value. The opening degrades to name only what is known, and names nothing when nothing is.
 */
export function buildCoverLetterMarkdown(parts: LetterParts): string {
  const blocks: string[] = [`# ${parts.candidateName}`];

  // Omitted rather than emitted empty: a blank contact line renders as a stray gap in the
  // letter's header.
  if (parts.contactLine) {
    blocks.push(parts.contactLine);
  }

  blocks.push(salutation(parts.company));
  blocks.push(opening(parts.jobTitle, parts.company));

  // A letter whose every paragraph was dropped still renders — that is a real outcome of the
  // source constraint, not a crash, and the caller surfaces the drop count separately.
  blocks.push(...parts.paragraphs);

  blocks.push('Sincerely,');
  blocks.push(parts.candidateName);

  return blocks.join('\n\n');
}

/**
 * `Dear Globex Hiring Team,` when the company is known, `Dear Hiring Manager,` when it is not.
 *
 * Never invents a named addressee. A letter opening "Dear Ms. Smith," when nobody supplied a
 * name is a fabrication the reader notices immediately, and it is addressed to the one person
 * positioned to notice.
 */
function salutation(company: string | null): string {
  return company ? `Dear ${company} Hiring Team,` : 'Dear Hiring Manager,';
}

/**
 * The line naming what the letter is about, degrading through every combination of known and
 * unknown rather than substituting one for the other.
 */
function opening(jobTitle: string | null, company: string | null): string {
  if (jobTitle && company) {
    return `I'm writing about the ${jobTitle} role at ${company}.`;
  }
  if (jobTitle) {
    return `I'm writing about the ${jobTitle} role.`;
  }
  if (company) {
    return `I'm writing about the role you advertised at ${company}.`;
  }
  return "I'm writing about the role you advertised.";
}
