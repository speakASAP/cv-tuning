/**
 * Renders a revision diff.
 *
 * The shapes below mirror `DiffHunk`/`DiffPart` in src/applications/diff.ts, which is what
 * the API returns. An earlier version of this view declared fields the API never sent
 * (`value`, `lines`), so every hunk read as an empty string and the whole diff collapsed
 * into a single blank line. Keep these definitions in step with the server.
 */
export type DiffPart = { type: 'equal' | 'added' | 'removed'; value: string };

export type DiffHunk = {
  type: 'added' | 'removed' | 'changed';
  beforeLine: number | null;
  afterLine: number | null;
  before: string | null;
  after: string | null;
  /** Word-level breakdown, present only for a `changed` hunk. */
  words?: DiffPart[];
};

const gutter = (hunk: DiffHunk): string =>
  hunk.type === 'removed' ? `-${hunk.beforeLine}` : hunk.type === 'added' ? `+${hunk.afterLine}` : `~${hunk.afterLine}`;

export function DiffView({ hunks }: { hunks?: DiffHunk[] }) {
  if (!hunks?.length) {
    return <p className="muted">No differences from this baseline.</p>;
  }

  return (
    <div className="diff">
      {hunks.map((hunk, index) => (
        // One block element per hunk. The previous version separated hunks with a "\n"
        // written in JSX text, which renders as those two literal characters, never a break.
        <div className="hunk" key={index}>
          <span className="hunk-gutter">{gutter(hunk)}</span>
          <span className={`hunk-text ${hunk.type}`}>
            {hunk.type === 'changed' && hunk.words?.length
              ? hunk.words.map((part, partIndex) => (
                  <span key={partIndex} className={part.type === 'equal' ? '' : part.type}>
                    {part.value}
                  </span>
                ))
              : hunk.type === 'removed'
                ? hunk.before
                : hunk.after}
          </span>
        </div>
      ))}
    </div>
  );
}
