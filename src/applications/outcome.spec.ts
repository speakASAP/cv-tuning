import { APPLICATION_STATES } from './application.types';
import { assertCanMarkSent, assertCanRecordOutcome, MARK_SENT_FROM } from './outcome';

describe('assertCanMarkSent', () => {
  it('allows the transition only from downloaded', () => {
    expect(MARK_SENT_FROM).toEqual(['downloaded']);
    expect(() => assertCanMarkSent('downloaded')).not.toThrow();
  });

  it('rejects every other state, naming the actual state so the failure is diagnosable', () => {
    const illegal = APPLICATION_STATES.filter((s) => s !== 'downloaded');
    for (const state of illegal) {
      expect(() => assertCanMarkSent(state)).toThrow(new RegExp(state));
    }
  });

  // A user who never downloaded cannot have sent anything. Allowing `approved` here would let
  // the funnel report a send with no artifact behind it.
  it('rejects approved, which has artifacts but no evidence the user took them', () => {
    expect(() => assertCanMarkSent('approved')).toThrow(/approved/);
  });
});

describe('assertCanRecordOutcome', () => {
  it('accepts each known outcome from marked_sent', () => {
    for (const outcome of ['interview', 'rejected', 'offer', 'ghosted']) {
      expect(() => assertCanRecordOutcome('marked_sent', outcome)).not.toThrow();
    }
  });

  it('rejects an outcome from downloaded, because sending is a prerequisite for a reply', () => {
    expect(() => assertCanRecordOutcome('downloaded', 'interview')).toThrow(/marked_sent/);
  });

  it('rejects an unknown outcome value rather than persisting free text', () => {
    expect(() => assertCanRecordOutcome('marked_sent', 'maybe')).toThrow(/maybe/);
  });

  it('names the legal outcomes in the error so the caller can correct the request', () => {
    expect(() => assertCanRecordOutcome('marked_sent', 'maybe')).toThrow(/interview/);
  });
});
