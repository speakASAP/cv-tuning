import { ScreeningQuestion } from '../jobs/job.types';

/**
 * Normalised form for COMPARISON ONLY — never for display.
 *
 * Case, internal whitespace, and a trailing `?` are all insignificant when deciding whether
 * two strings are the same question. None of them may reach the returned text: the user pastes
 * that text into a real employer's form, so it must come back exactly as they wrote it.
 */
function comparisonKey(question: string): string {
  return question
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\?+$/, '')
    .toLowerCase();
}

function display(question: string): string {
  return question.replace(/\s+/g, ' ').trim();
}

/**
 * Merges the questions the user pasted from a real application portal with the ones this
 * service parsed out of the posting.
 *
 * USER WINS EVERY TIE, and the tie is resolved in favour of the label as much as the text: a
 * question the user actually saw on the portal is evidence, while a parsed one is an
 * inference, and labelling the survivor `parsed` would understate what is known about it.
 * That distinction is the whole reason `source` exists on the row — a guessed question shown
 * as one the employer asked would have the user answer a question nobody posed, under their
 * own name.
 *
 * Order is the user's list first, in their given order, then parsed questions not already
 * present. The user's list is the one they will paste answers back into, so it leads.
 */
export function mergeQuestions(user: string[], parsed: string[]): ScreeningQuestion[] {
  const merged: ScreeningQuestion[] = [];
  const seen = new Set<string>();

  const add = (question: string, source: ScreeningQuestion['source']): void => {
    const text = display(question);
    if (!text) {
      return;
    }

    const key = comparisonKey(text);
    if (!key || seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push({ text, source });
  };

  for (const question of user) {
    add(question, 'user');
  }
  for (const question of parsed) {
    add(question, 'parsed');
  }

  return merged;
}
