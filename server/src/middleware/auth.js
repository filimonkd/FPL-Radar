import { ADMIN_COOKIE, verifyAdminToken, SHARE_TOKEN } from '../auth/tokens.js';
import { unauthorized, forbidden, notFound } from '../errors.js';

// Principal resolution and route guards. Authorization lives here and in the
// services, never in analytics.
//
//   req.principal = { role: 'admin' } | { role: 'viewer', groupId } | { role: 'anonymous' }
//
// The admin token comes from the httpOnly cookie or an `Authorization: Bearer`
// header; a share token from `X-Share-Token`. An invalid credential is treated as
// none (401 on protected routes) rather than as an error with details.

const bearer = (req) => {
  const h = req.get('authorization');
  return h && /^Bearer /i.test(h) ? h.slice(7).trim() : null;
};

export function authenticate({ jwtSecret, groups }) {
  return async (req, _res, next) => {
    const admin = verifyAdminToken(jwtSecret, req.cookies?.[ADMIN_COOKIE] ?? bearer(req));
    if (admin) {
      req.principal = admin;
      return next();
    }
    const share = req.get('x-share-token');
    if (share && SHARE_TOKEN.test(share)) {
      const group = await groups.getByShareToken(share);
      if (group) {
        req.principal = { role: 'viewer', groupId: group.id };
        return next();
      }
    }
    req.principal = { role: 'anonymous' };
    return next();
  };
}

export function requireAdmin(req, _res, next) {
  const p = req.principal;
  if (!p || p.role === 'anonymous') return next(unauthorized());
  if (p.role !== 'admin') return next(forbidden('admin only'));
  return next();
}

/**
 * Read access to one group: the admin, or a viewer of exactly that group. A
 * viewer asking for another group gets 404, so group ids are not confirmed.
 */
export function requireGroupRead(param = 'groupId') {
  return (req, _res, next) => {
    const p = req.principal;
    if (!p || p.role === 'anonymous') return next(unauthorized());
    if (p.role === 'admin') return next();
    if (p.role === 'viewer' && p.groupId === req.params[param]) return next();
    return next(notFound('group'));
  };
}
