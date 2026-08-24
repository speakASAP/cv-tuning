import { getMetadataArgsStorage } from 'typeorm';
import { CvApplicationEntity } from './cv-application.entity';
import { CvArtifactEntity } from './cv-artifact.entity';
import { CvChatEntity } from './cv-chat.entity';

describe('phase 4 entities', () => {
  it('exposes a chat row that can point at the render it produced', () => {
    const chat = new CvChatEntity();
    chat.role = 'assistant';
    chat.inputMode = 'text';
    chat.renderId = 'render-1';
    expect(chat.renderId).toBe('render-1');
  });

  it('allows a user chat row with no render', () => {
    const chat = new CvChatEntity();
    chat.role = 'user';
    chat.renderId = null;
    expect(chat.renderId).toBeNull();
  });

  it('exposes an artifact row carrying the sha256 used for idempotency', () => {
    const artifact = new CvArtifactEntity();
    artifact.kind = 'pdf';
    artifact.sha256 = 'abc';
    artifact.byteSize = 12;
    expect(artifact.kind).toBe('pdf');
  });
});

describe('cv_application outcome-tracking columns', () => {
  const columnsFor = (target: Function): string[] =>
    getMetadataArgsStorage()
      .columns.filter((c) => c.target === target)
      .map((c) => c.propertyName);

  it('carries sentAt, outcomeAt and nudgedAt', () => {
    const columns = columnsFor(CvApplicationEntity);
    expect(columns).toContain('sentAt');
    expect(columns).toContain('outcomeAt');
    expect(columns).toContain('nudgedAt');
  });

  it('declares all three nullable, because they are absent for most of an application life', () => {
    const declared = getMetadataArgsStorage().columns.filter(
      (c) =>
        c.target === CvApplicationEntity &&
        ['sentAt', 'outcomeAt', 'nudgedAt'].includes(c.propertyName),
    );
    expect(declared).toHaveLength(3);
    for (const column of declared) {
      expect(column.options.nullable).toBe(true);
      expect(column.options.type).toBe('timestamptz');
    }
  });
});
