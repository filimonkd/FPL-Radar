// Deterministic _id builders and parsers (architecture v0.3 §4). Every
// natural-key document id is built here, never inline.

const SEASON = /^\d{4}-\d{2}$/;

function season(value) {
  if (typeof value !== 'string' || !SEASON.test(value)) throw new TypeError(`invalid season "${value}" (expected e.g. 2026-27)`);
  const [start, end] = value.split('-');
  if ((Number(start) + 1) % 100 !== Number(end)) throw new TypeError(`invalid season "${value}" (years must be consecutive)`);
  return value;
}

function positiveInt(name, value) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer, got ${value}`);
  return value;
}

function gw(value) {
  positiveInt('gw', value);
  if (value > 38) throw new TypeError(`gw must be 1–38, got ${value}`);
  return value;
}

function objectIdHex(name, value) {
  const s = String(value);
  if (!/^[a-f0-9]{24}$/.test(s)) throw new TypeError(`${name} must be a 24-char hex ObjectId, got "${s}"`);
  return s;
}

export const ids = Object.freeze({
  season: (s) => season(s),
  event: (s, g) => `${season(s)}:${gw(g)}`,
  liveGameweek: (s, g) => `${season(s)}:${gw(g)}`,
  player: (s, elementId) => `${season(s)}:${positiveInt('elementId', elementId)}`,
  manager: (entryId) => positiveInt('entryId', entryId),
  managerGameweek: (s, entryId, g) => `${season(s)}:${positiveInt('entryId', entryId)}:${gw(g)}`,
  managerSeason: (s, entryId) => `${season(s)}:${positiveInt('entryId', entryId)}`,
  gwResult: (groupId, s, g) => `${objectIdHex('groupId', groupId)}:${season(s)}:${gw(g)}`,
  lock: (scope, key) => {
    if (!/^[a-z]+(:[a-z]+)*$/.test(scope)) throw new TypeError(`invalid lock scope "${scope}"`);
    return key === undefined ? scope : `${scope}:${String(key)}`;
  },
});

const int = (s) => (/^[1-9]\d*$/.test(s) ? Number(s) : NaN);

// Parsers return the component fields, or throw on a malformed id.
export const parseIds = Object.freeze({
  event(id) {
    const m = /^(\d{4}-\d{2}):(\d{1,2})$/.exec(id);
    if (!m) throw new TypeError(`invalid event id "${id}"`);
    const out = { season: m[1], gw: int(m[2]) };
    if (ids.event(out.season, out.gw) !== id) throw new TypeError(`invalid event id "${id}"`);
    return out;
  },
  managerGameweek(id) {
    const m = /^(\d{4}-\d{2}):(\d+):(\d{1,2})$/.exec(id);
    if (!m) throw new TypeError(`invalid managerGameweek id "${id}"`);
    const out = { season: m[1], entryId: int(m[2]), event: int(m[3]) };
    if (ids.managerGameweek(out.season, out.entryId, out.event) !== id) throw new TypeError(`invalid managerGameweek id "${id}"`);
    return out;
  },
  managerSeason(id) {
    const m = /^(\d{4}-\d{2}):(\d+)$/.exec(id);
    if (!m) throw new TypeError(`invalid managerSeason id "${id}"`);
    const out = { season: m[1], entryId: int(m[2]) };
    if (ids.managerSeason(out.season, out.entryId) !== id) throw new TypeError(`invalid managerSeason id "${id}"`);
    return out;
  },
  gwResult(id) {
    const m = /^([a-f0-9]{24}):(\d{4}-\d{2}):(\d{1,2})$/.exec(id);
    if (!m) throw new TypeError(`invalid gwResult id "${id}"`);
    const out = { groupId: m[1], season: m[2], gw: int(m[3]) };
    if (ids.gwResult(out.groupId, out.season, out.gw) !== id) throw new TypeError(`invalid gwResult id "${id}"`);
    return out;
  },
});
