// Anonymizes FPL responses before they are committed as contract samples
// (architecture v0.2 §11): manager/team names become "Manager N"/"Team N",
// entry and league IDs are remapped to synthetic IDs, regions are blanked,
// and bootstrap is trimmed to 20 elements.

export function createIdMap() {
  const entries = new Map();
  const leagues = new Map();
  const map = {
    entry(id) {
      if (!entries.has(id)) entries.set(id, 100001 + entries.size);
      return entries.get(id);
    },
    league(id) {
      if (!leagues.has(id)) leagues.set(id, 900001 + leagues.size);
      return leagues.get(id);
    },
    // Report-safe aliases (E1, L1, ...) that never reveal real IDs.
    entryAlias: (id) => `E${map.entry(id) - 100000}`,
    leagueAlias: (id) => `L${map.league(id) - 900000}`,
  };
  return map;
}

const clone = (v) => structuredClone(v);

function anonymizeEntryProfile(body, ids) {
  const out = clone(body);
  const n = ids.entry(out.id) - 100000;
  out.id = ids.entry(out.id);
  if ('player_first_name' in out) out.player_first_name = 'Manager';
  if ('player_last_name' in out) out.player_last_name = String(n);
  if ('name' in out) out.name = `Team ${n}`;
  if ('player_region_name' in out) out.player_region_name = 'Region';
  if ('player_region_iso_code_short' in out) out.player_region_iso_code_short = 'XX';
  if ('player_region_iso_code_long' in out) out.player_region_iso_code_long = 'XXX';
  if (typeof out.player_region_id === 'number') out.player_region_id = 0;
  if (typeof out.name_change_blocked === 'boolean') out.name_change_blocked = false;
  // Other leagues the manager belongs to are personal: keep structure, trim and rename.
  for (const kind of ['classic', 'h2h']) {
    const list = out.leagues?.[kind];
    if (!Array.isArray(list)) continue;
    out.leagues[kind] = list.slice(0, 2).map((l, i) => ({
      ...l,
      id: typeof l.id === 'number' ? ids.league(l.id) : l.id,
      name: typeof l.name === 'string' ? `League ${kind}-${i + 1}` : l.name,
      ...(typeof l.admin_entry === 'number' ? { admin_entry: ids.entry(l.admin_entry) } : {}),
    }));
  }
  return out;
}

function anonymizeStandings(body, ids) {
  const out = clone(body);
  if (out.league) {
    if (typeof out.league.id === 'number') out.league.id = ids.league(out.league.id);
    if (typeof out.league.name === 'string') out.league.name = `League ${out.league.id - 900000}`;
    if (typeof out.league.admin_entry === 'number') out.league.admin_entry = ids.entry(out.league.admin_entry);
  }
  const rows = out.standings?.results;
  if (Array.isArray(rows)) {
    rows.forEach((r, i) => {
      if (typeof r.entry === 'number') r.entry = ids.entry(r.entry);
      const n = r.entry - 100000;
      if ('entry_name' in r) r.entry_name = `Team ${n}`;
      if ('player_name' in r) r.player_name = `Manager ${n}`;
      if (typeof r.id === 'number') r.id = i + 1;
    });
  }
  const joins = out.new_entries?.results;
  if (Array.isArray(joins)) {
    out.new_entries.results = joins.slice(0, 2).map((r) => ({
      ...r,
      ...(typeof r.entry === 'number' ? { entry: ids.entry(r.entry) } : {}),
      ...('entry_name' in r ? { entry_name: 'Team' } : {}),
      ...('player_first_name' in r ? { player_first_name: 'Manager' } : {}),
      ...('player_last_name' in r ? { player_last_name: 'N' } : {}),
    }));
  }
  return out;
}

function anonymizeTransfers(body, ids) {
  return clone(body).map((t) => (typeof t.entry === 'number' ? { ...t, entry: ids.entry(t.entry) } : t));
}

function trimBootstrap(body) {
  const out = clone(body);
  if (Array.isArray(out.elements)) out.elements = out.elements.slice(0, 20);
  return out;
}

function trimLive(body, keepIds) {
  const out = clone(body);
  if (Array.isArray(out.elements)) {
    out.elements = out.elements.filter((e, i) => i < 20 || keepIds.has(e.id));
  }
  return out;
}

export function anonymize(endpoint, body, ids, { liveKeepIds = new Set() } = {}) {
  switch (endpoint) {
    case 'bootstrap-static':
      return trimBootstrap(body);
    case 'entry':
      return anonymizeEntryProfile(body, ids);
    case 'leagues-classic-standings':
      return anonymizeStandings(body, ids);
    case 'entry-transfers':
      return anonymizeTransfers(body, ids);
    case 'event-live':
      return trimLive(body, liveKeepIds);
    default:
      // history, picks, fixtures, event-status carry no names or entry IDs.
      return clone(body);
  }
}

// Safety net: fails if any real identifying string or ID survived anonymization.
export function findLeaks(sample, secrets) {
  const text = JSON.stringify(sample);
  return secrets.filter((s) => {
    if (typeof s === 'number') return s >= 1000 && new RegExp(`(?<![0-9])${s}(?![0-9])`).test(text);
    return typeof s === 'string' && s.trim().length >= 3 && text.includes(s);
  });
}
