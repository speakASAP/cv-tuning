import { buildRenderMarkdown } from './render-markdown';
import { withBulletIds } from './bullet-identity';
import { CvDocxService } from '../export/cv-docx.service';
import { CvPdfService } from '../export/cv-pdf.service';

/**
 * `TailoredBullet.bulletId` must be INVISIBLE to the exported document.
 *
 * Spec §6.3 reuses the artifact sha256 as the artifact's identity, and `cv-pdf.service.ts`
 * pins `info.CreationDate` to `new Date(0)` for exactly that reason. Leaking an internal id
 * into the rendered bytes would change the sha256 for content that is logically identical —
 * the same class of defect as an unpinned timestamp, just sourced from a field a reader would
 * not think to check.
 *
 * Asserted through the real writers rather than by string-matching the markdown, so the test
 * fails if the id reaches the page by any route, not only the obvious one.
 */
const FACTS = [
  { factId: 'f1', section: 'Experience', title: 'Senior Developer', org: 'Acme', period: '2019-2024' },
  // Same entry, different fact: the identical-text case bulletId exists for.
  { factId: 'f2', section: 'Experience', title: 'Senior Developer', org: 'Acme', period: '2019-2024' },
];

const MASTER =
  '# Jane Doe\n\njane@example.com | +420 111\n\n## Experience\n\n### Senior Developer — Acme (2019-2024)\n\n- a\n';

const UNSTAMPED = [
  { text: 'ran postgres in production', sourceFactId: 'f1' },
  { text: 'improved system reliability', sourceFactId: 'f2' },
];

const STAMPED = withBulletIds(
  UNSTAMPED.map((b) => ({ ...b, targetRequirement: null, verdict: 'supported' as const, span: null })),
);

describe('bulletId is invisible to the export path', () => {
  it('produces byte-identical markdown with and without bulletId', () => {
    expect(buildRenderMarkdown(MASTER, STAMPED, FACTS)).toEqual(
      buildRenderMarkdown(MASTER, UNSTAMPED, FACTS),
    );
  });

  it('leaves the PDF sha256 unchanged for the same logical content', async () => {
    const pdf = new CvPdfService();
    const before = await pdf.render(buildRenderMarkdown(MASTER, UNSTAMPED, FACTS), 'cv-r1');
    const after = await pdf.render(buildRenderMarkdown(MASTER, STAMPED, FACTS), 'cv-r1');
    expect(after.sha256).toEqual(before.sha256);
  });

  it('leaves the DOCX sha256 unchanged for the same logical content', async () => {
    const docx = new CvDocxService();
    const before = await docx.render(buildRenderMarkdown(MASTER, UNSTAMPED, FACTS), 'cv-r1');
    const after = await docx.render(buildRenderMarkdown(MASTER, STAMPED, FACTS), 'cv-r1');
    expect(after.sha256).toEqual(before.sha256);
  });

  it('never writes the id into the markdown, even for two identical-text bullets', () => {
    // The duplicate-text render is the one where ids are most load-bearing internally, so it
    // is the one most at risk of leaking them into the document a person reads.
    const twins = withBulletIds([
      { text: 'improved system reliability', sourceFactId: 'f1', targetRequirement: null, verdict: 'overreach' as const, span: 'improved' },
      { text: 'improved system reliability', sourceFactId: 'f2', targetRequirement: null, verdict: 'overreach' as const, span: 'improved' },
    ]);
    const markdown = buildRenderMarkdown(MASTER, twins, FACTS);
    for (const bullet of twins) {
      expect(markdown).not.toContain(bullet.bulletId as string);
    }
    // Both bullets still reach the page — deduplicating them would silently lose content.
    expect(markdown.match(/improved system reliability/g)).toHaveLength(2);
  });
});
