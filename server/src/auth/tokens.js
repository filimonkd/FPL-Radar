import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

// Application authentication (architecture v0.3 §11/§17: JWT_SECRET,
// ADMIN_PASSWORD_HASH; jsonwebtoken / bcryptjs / cookie-parser).
//
// Identities:
//   admin  — the single administrator; logs in with the admin password and gets
//            a signed JWT (HS256, fixed issuer/audience, short lifetime).
//   viewer — anyone holding a group's share token; read-only, that group only.
// FPL credentials are never accepted, stored or forwarded (v0.2 §10).

export const ADMIN_COOKIE = 'fpl_admin';
export const TOKEN_TTL_SECONDS = 12 * 60 * 60;
const ISSUER = 'fpl-radar';
const AUDIENCE = 'fpl-radar-admin';
const ALGORITHM = 'HS256';

export function signAdminToken(secret, { ttlSeconds = TOKEN_TTL_SECONDS, nowSeconds } = {}) {
  const payload = { role: 'admin' };
  if (nowSeconds !== undefined) payload.iat = nowSeconds;
  return jwt.sign(payload, secret, { algorithm: ALGORITHM, expiresIn: ttlSeconds, issuer: ISSUER, audience: AUDIENCE, subject: 'admin' });
}

/** Returns the admin principal for a valid token, else null (bad signature, expired, wrong alg/aud/iss). */
export function verifyAdminToken(secret, token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
  try {
    const claims = jwt.verify(token, secret, { algorithms: [ALGORITHM], issuer: ISSUER, audience: AUDIENCE, subject: 'admin' });
    return claims.role === 'admin' ? { role: 'admin', actor: 'admin' } : null;
  } catch {
    return null;
  }
}

// A dummy comparison keeps a "login disabled" or malformed-input response about
// as slow as a real one, so timing does not reveal which case it was.
let dummyHash;
const dummy = async (password) => {
  dummyHash ??= await bcrypt.hash(randomBytes(16).toString('hex'), 10);
  await bcrypt.compare(password, dummyHash);
  return false;
};

/** Compares a login password with ADMIN_PASSWORD_HASH (bcrypt). */
export async function checkAdminPassword(password, passwordHash) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) return dummy('x');
  if (!passwordHash) return dummy(password);
  return bcrypt.compare(password, passwordHash);
}

/** A new group share token: 32 random bytes, base64url (43 chars). */
export const newShareToken = () => randomBytes(32).toString('base64url');

export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
