import { pseudonymizePrompt } from './pseudonymize';

describe('pseudonymizePrompt', () => {
  it('redacts email addresses and phone numbers', () => {
    expect(pseudonymizePrompt('Email jane@example.com or call +420 777 123 456.')).toBe(
      'Email [EMAIL] or call [PHONE].',
    );
  });

  it('redacts labelled contact and address lines', () => {
    expect(
      pseudonymizePrompt('Name: Jane Doe\nAddress: 1 Main Street\nRole: Engineer'),
    ).toBe('Name: [REDACTED]\nAddress: [REDACTED]\nRole: Engineer');
  });

  it('does not alter professional facts without direct identifiers', () => {
    const facts = 'Reduced API latency by 40% using PostgreSQL.';
    expect(pseudonymizePrompt(facts)).toBe(facts);
  });
});
