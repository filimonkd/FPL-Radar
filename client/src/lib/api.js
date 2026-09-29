// The only place the client talks to the server. Same origin: every call goes
// to /api relative to the page (no CORS, no base URL). The admin session is the
// HttpOnly cookie (never readable here); a viewer's share token is kept in
// localStorage and sent as X-Share-Token.

const SHARE_KEY = 'fpl_share_token';

function storage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
export const getShareToken = () => { try { return storage()?.getItem(SHARE_KEY) ?? null; } catch { return null; } };
export const setShareToken = (t) => { try { if (t) storage()?.setItem(SHARE_KEY, t); else storage()?.removeItem(SHARE_KEY); } catch { /* private mode */ } };

/** Share link format: <origin>/share#<token>. The fragment never reaches the server or its logs. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const shareLink = (origin, token) => `${origin}/share#${token}`;
export function tokenFromHash(hash) {
  const t = (hash ?? '').replace(/^#/, '');
  return SHARE_TOKEN_RE.test(t) ? t : null;
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code ?? 'HTTP_ERROR';
    this.details = body?.error?.details;
  }
}

export async function api(path, { method = 'GET', body, fetchImpl = globalThis.fetch } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const share = getShareToken();
  if (share) headers['x-share-token'] = share;
  const res = await fetchImpl(`/api${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const q = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

// Endpoint map (server/src/routes/*). Keep in one place so the UI never builds URLs ad hoc.
export const endpoints = {
  me: () => api('/auth/me'),
  login: (password) => api('/auth/login', { method: 'POST', body: { password } }),
  logout: () => api('/auth/logout', { method: 'POST' }),
  groups: (includeArchived) => api(`/groups?${q({ includeArchived: includeArchived ? 'true' : undefined })}`),
  group: (id) => api(`/groups/${id}`),
  createGroup: (body) => api('/groups', { method: 'POST', body }),
  updateGroup: (id, body) => api(`/groups/${id}`, { method: 'PATCH', body }),
  archive: (id) => api(`/groups/${id}/archive`, { method: 'POST' }),
  unarchive: (id) => api(`/groups/${id}/unarchive`, { method: 'POST' }),
  addMembers: (id, entryIds) => api(`/groups/${id}/members`, { method: 'POST', body: { entryIds } }),
  updateMember: (id, entryId, body) => api(`/groups/${id}/members/${entryId}`, { method: 'PATCH', body }),
  rotateShare: (id) => api(`/groups/${id}/share-token`, { method: 'POST' }),
  revokeShare: (id) => api(`/groups/${id}/share-token/revoke`, { method: 'POST' }),
  sync: (id, season, event) => api(`/groups/${id}/sync`, { method: 'POST', body: { season, event } }),
  leaguePreview: (leagueId) => api(`/leagues/${leagueId}/preview`),
  validateEntries: (entryIds) => api('/entries/validate', { method: 'POST', body: { entryIds } }),
  events: (season) => api(`/seasons/${season}/events`),
  result: (id, gw, season) => api(`/groups/${id}/gw/${gw}/result?${q({ season })}`),
  finalize: (id, gw, season) => api(`/groups/${id}/gw/${gw}/finalize`, { method: 'POST', body: { season } }),
  override: (id, gw, season, winners, note) => api(`/groups/${id}/gw/${gw}/override`, { method: 'POST', body: { season, winners, note } }),
  recompute: (id, gw, season, { dryRun, note }) => api(`/groups/${id}/gw/${gw}/recompute`, { method: 'POST', body: { season, dryRun, ...(note ? { note } : {}) } }),
  actions: (id, gw, season) => api(`/groups/${id}/gw/${gw}/actions?${q({ season })}`),
  verifyChain: (id, gw, season) => api(`/groups/${id}/gw/${gw}/actions/verify?${q({ season })}`),
  snapshot: (snapshotId) => api(`/result-snapshots/${snapshotId}`),
  verifySnapshot: (snapshotId) => api(`/result-snapshots/${snapshotId}/verify`),
  trace: (snapshotId) => api(`/result-snapshots/${snapshotId}/trace`),
  ownership: (id, gw, season, view) => api(`/groups/${id}/gw/${gw}/ownership?${q({ season, view })}`),
  transfers: (id, gw, season) => api(`/groups/${id}/gw/${gw}/transfers?${q({ season })}`),
  rivals: (id, gw, season) => api(`/groups/${id}/gw/${gw}/rivals?${q({ season })}`),
  news: (id, gw, season) => api(`/groups/${id}/gw/${gw}/news?${q({ season })}`),
  refreshPlayers: (season) => api(`/seasons/${season}/players/refresh`, { method: 'POST' }),
  finder: (id, gw, season, params) => api(`/groups/${id}/gw/${gw}/finder?${q({ season, ...params })}`),
  players: (season) => api(`/seasons/${season}/players`),
  transferPlan: (id, season) => api(`/groups/${id}/transfer-plan?${q({ season })}`),
  transferSim: (id, season, out, inId, hit) => api(`/groups/${id}/transfer-sim?${q({ season, out, in: inId, hit: hit ? 'true' : 'false' })}`),
  chips: (id, season, event) => api(`/groups/${id}/chips?${q({ season, event })}`),
  status: (season) => api(`/status?${q({ season })}`),
  run: (runId) => api(`/status/runs/${runId}`),
};
