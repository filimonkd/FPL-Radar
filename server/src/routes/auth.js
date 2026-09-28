import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ADMIN_COOKIE, TOKEN_TTL_SECONDS, signAdminToken, checkAdminPassword } from '../auth/tokens.js';
import { AppError, unauthorized } from '../errors.js';
import { loginBody } from '../validators/groups.js';

// POST /api/auth/login { password } → httpOnly cookie (API clients may send it as a Bearer token)
// POST /api/auth/logout            → clears the cookie
// GET  /api/auth/me                → the current principal, or 401
// Only the app's own admin password is accepted; no FPL credentials, ever.

export function authRouter({ config, loginLimit = { windowMs: 15 * 60_000, limit: 10 } }) {
  const router = Router();
  const secure = config.NODE_ENV === 'production';
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure, path: '/api' };

  const limiter = rateLimit({
    ...loginLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'too many login attempts; try again later')),
  });

  router.post('/login', limiter, async (req, res) => {
    const { password } = loginBody.parse(req.body ?? {});
    if (!config.ADMIN_PASSWORD_HASH) {
      await checkAdminPassword(password, null);
      throw new AppError(503, 'AUTH_NOT_CONFIGURED', 'admin login is not configured (ADMIN_PASSWORD_HASH)');
    }
    if (!(await checkAdminPassword(password, config.ADMIN_PASSWORD_HASH))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'invalid password');
    }
    const token = signAdminToken(config.JWT_SECRET);
    res.cookie(ADMIN_COOKIE, token, { ...cookieOptions, maxAge: TOKEN_TTL_SECONDS * 1000 });
    // The token travels only in the httpOnly cookie, never in a body scripts could read.
    res.json({ principal: { role: 'admin' }, expiresInSeconds: TOKEN_TTL_SECONDS });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(ADMIN_COOKIE, cookieOptions);
    res.status(204).end();
  });

  router.get('/me', (req, res) => {
    const p = req.principal;
    if (!p || p.role === 'anonymous') throw unauthorized();
    res.json({ principal: p.role === 'admin' ? { role: 'admin' } : { role: 'viewer', groupId: p.groupId } });
  });

  return router;
}
