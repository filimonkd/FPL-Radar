// Classification of raw HTTP outcomes for the smoke test.

const CHALLENGE = /(cf-chl|challenge-platform|Just a moment|Attention Required! \| Cloudflare)/i;
const UPDATING = /The game is being updated/i;
const LOGIN = /(login|sign in|signin|users\.premierleague\.com)/i;
// Egress proxies/firewalls between us and FPL (e.g. "Host not in allowlist").
const EGRESS_DENIED = /(host not in allowlist|host_not_allowed|egress)/i;

// Returns one of: OK, NETWORK, BLOCKED, UPDATING, HTTP, INVALID_JSON.
// BLOCKED requires a concrete denial indicator: an egress proxy's
// x-deny-reason header or "host not in allowlist" body, a Cloudflare
// `cf-mitigated` header, or a recognized challenge page. Any other upstream
// 401/403/429 stays HTTP so it is reported as FPL's actual answer.
export function classifyResponse({ error, status, contentType = '', text = '', json, denyReason, cfMitigated }) {
  if (error) return 'NETWORK';
  if (denyReason || ((status === 403 || status === 407) && EGRESS_DENIED.test(text))) return 'BLOCKED';
  if (cfMitigated) return 'BLOCKED';
  if ((status === 403 || status === 429 || status === 503) && CHALLENGE.test(text)) return 'BLOCKED';
  if (UPDATING.test(text)) return 'UPDATING';
  if (status < 200 || status >= 300) return 'HTTP';
  if (json === undefined || !/json/i.test(contentType)) return 'INVALID_JSON';
  return 'OK';
}

export const isUnreachable = (classification) => ['NETWORK', 'BLOCKED', 'UPDATING'].includes(classification);

// League standings access classes (architecture v0.2 §10).
export function classifyLeagueAccess(res) {
  if (isUnreachable(res.classification)) return res.classification;
  if (res.status === 404) return 'NOT_FOUND';
  if (res.status === 401 || res.status === 403) return 'AUTH_REQUIRED';
  if (res.status >= 300 && res.status < 400 && LOGIN.test(res.location ?? '')) return 'AUTH_REQUIRED';
  if (res.status === 200 && !/json/i.test(res.contentType ?? '') && LOGIN.test(res.text ?? '')) return 'AUTH_REQUIRED';
  if (res.classification !== 'OK') return 'UNEXPECTED';
  const results = res.json?.standings?.results;
  if (!Array.isArray(results)) return 'UNEXPECTED';
  return results.length > 0 ? 'OK' : 'EMPTY';
}
