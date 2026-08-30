import { createHmac, createSign } from 'crypto';

/**
 * `iss` must be exactly this regardless of which service calls: ai-microservice's
 * ServiceAuthGuard verifies the issuer, not the caller.
 */
const TOKEN_ISSUER = 'ai-microservice';
const TOKEN_TTL_SECONDS = 900;

export const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Mints the service token every ai-microservice endpoint requires.
 *
 * RS256 whenever a private key is configured: only the holder can mint, so a compromised
 * caller cannot forge tokens for another service. The HS256 branch exists solely for the
 * migration window, because a shared secret lets any holder impersonate any caller.
 */
export function mintServiceToken(serviceId: string, privateKey: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({ serviceId, iss: TOKEN_ISSUER, iat: now, exp: now + TOKEN_TTL_SECONDS }),
  );

  if (privateKey) {
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const signature = base64url(createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey));
    return `${header}.${payload}.${signature}`;
  }

  if (!secret) {
    throw new Error('JWT_SECRET or JWT_PRIVATE_KEY is not set; cannot authenticate to ai-microservice');
  }

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const signature = base64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}
