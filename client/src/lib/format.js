// Pure display helpers (no DOM, no fetch): unit-tested with node:test.
// Codes come from the API verbatim; these only translate them for people and
// never reinterpret them (UNVERIFIED / CONFLICTED stay what they are).

/** Default FPL season key for a date: seasons start in August (e.g. 2026-27). */
export function seasonForDate(date = new Date()) {
  const y = date.getUTCFullYear();
  const start = date.getUTCMonth() >= 6 ? y : y - 1; // July onwards belongs to the new season
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const isSeasonKey = (s) => {
  const m = /^(\d{4})-(\d{2})$/.exec(s ?? '');
  return Boolean(m) && (Number(m[1]) + 1) % 100 === Number(m[2]);
};

/** "Rank" column: competitionRank with "=" when tied (v0.2 §6), "–" when ineligible. */
export function rankLabel(row) {
  if (row.competitionRank == null) return '–';
  return row.tiedWith?.length ? `=${row.competitionRank}` : String(row.competitionRank);
}

export const pct = (share) => (share && share.of ? `${Math.round(share.pct * 10) / 10}%` : '–');
export const points = (v) => (v == null ? '–' : String(v));

export function bytes(n) {
  if (n == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

export function dateTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const shortHash = (h) => (h ? `${h.replace(/^sha256:/, '').slice(0, 10)}…` : '–');

const TEXT = {
  // finalize gate (analytics/eventState.canFinalize + resultModel semantics guard)
  GROUP_ARCHIVED: 'The group is archived.',
  NOT_DATA_CHECKED: 'FPL has not marked this gameweek as data-checked yet.',
  ALREADY_FINAL: 'This gameweek already has a final result.',
  STALE_SYNC: 'The data predates FPL\'s data check: finalizing runs a fresh sync first; if it still shows, try again.',
  RECONCILIATION_FAILED: 'Some managers\' points do not reconcile.',
  NO_ELIGIBLE_MANAGERS: 'No eligible managers.',
  SEMANTICS_CONFLICTED: 'FPL points semantics are CONFLICTED this season; transfer-hit rows cannot be scored.',
  SEMANTICS_UNVERIFIED: 'FPL points semantics are still UNVERIFIED; transfer-hit rows cannot be scored.',
  SEMANTICS_MISMATCH: 'A transfer-hit row disagrees with the season\'s points semantics.',
  // reconciliation
  RECONCILED: 'Reconciled',
  RECONCILED_NO_COST: 'Reconciled (no hit)',
  MISMATCH: 'Mismatch',
  SEMANTICS_CONFLICT: 'Semantics conflict',
  SOURCE_DISAGREEMENT: 'Sources disagree',
  INCOMPLETE: 'Incomplete',
  NOT_SYNCED: 'Not synced',
  // eligibility
  EXCLUDED: 'Excluded',
  JOINED_LATER: 'Joined later',
  NO_TEAM: 'No team',
  // tie-break rules
  FEWER_TRANSFER_COST: 'Fewer transfer-hit points',
  HIGHER_SEASON_TOTAL: 'Higher season total',
  HIGHER_CAPTAIN_POINTS: 'Higher captain points',
  NO_CHIP_PLAYED: 'No chip played',
  SHARED: 'Shared',
  ENTRY_ID_FALLBACK: 'Table order only (never decides a winner)',
  // warnings
  PROVISIONAL_EVENT_STATE: 'Provisional: the gameweek is not data-checked.',
  TIE_BREAK_DATA_MISSING: 'Tie-break data missing for a rule.',
  SOURCE_STATE_REGRESSED: 'FPL reported an earlier state than before.',
  CHIP_RULES_UNAVAILABLE: 'Chip rules are not available.',
  CONFIG_FALLBACK: 'Chip rules come from the fallback config, not FPL.',
  NO_CURRENT_EVENT: 'FPL reports no current gameweek.',
};

/** Human text for an API code; unknown codes are shown verbatim. */
export const explain = (code) => TEXT[code] ?? code;

export function statusTone(status) {
  switch (status) {
    case 'FINAL': case 'SUCCESS': case 'OK': case 'PLAYED': case 'PASS': return 'good';
    case 'OVERRIDDEN': case 'PROVISIONAL': case 'PARTIAL': case 'RUNNING': case 'ACTIVE_UNCONFIRMED': case 'UNVERIFIED': return 'warn';
    case 'BLOCKED': case 'FAILED': case 'ABANDONED': case 'SOURCE_DISAGREEMENT': case 'CONFLICTED': case 'FAIL': return 'bad';
    default: return 'neutral';
  }
}

/** Name for an entryId from result standings (falls back to the id). */
export function managerName(standings, entryId) {
  const r = standings?.find((s) => s.entryId === entryId);
  return r ? `${r.teamName} (${r.playerName})` : `#${entryId}`;
}

/**
 * The announcement text for a decided gameweek (v0.2 §17 step 8 "announcement copy").
 * Only FINAL / OVERRIDDEN results are announced; anything else returns null.
 */
export function announcement(result, groupName) {
  if (!result || (result.status !== 'FINAL' && result.status !== 'OVERRIDDEN')) return null;
  const names = result.winners.map((id) => managerName(result.standings, id));
  const shared = names.length > 1;
  const who = shared ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} share the win` : `${names[0]} wins`;
  const score = result.winningScore != null && result.status === 'FINAL' ? ` with ${result.winningScore} pts` : '';
  const note = result.status === 'OVERRIDDEN' ? ' (declared by the admin)' : '';
  return `${groupName} · GW${result.event} ${result.season}: ${who}${score}${note}.`;
}

/** Override / recompute notes: 3–280 characters after trimming (validators/results.js). */
export const validNote = (note) => {
  const n = (note ?? '').trim();
  return n.length >= 3 && n.length <= 280;
};

/** Parses "1, 2 3\n4" into unique positive integer entry IDs; returns { ids, bad }. */
export function parseEntryIds(text) {
  const ids = [];
  const bad = [];
  for (const tok of (text ?? '').split(/[\s,;]+/).filter(Boolean)) {
    if (/^[1-9]\d{0,9}$/.test(tok)) { const n = Number(tok); if (!ids.includes(n)) ids.push(n); } else bad.push(tok);
  }
  return { ids, bad };
}

/** Tie-break chain as configured: chosen confirmed rules in order, SHARED always last. */
export function tieBreakChain(selected) {
  return [...selected.filter((r) => r !== 'SHARED'), 'SHARED'];
}
