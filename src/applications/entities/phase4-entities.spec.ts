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
