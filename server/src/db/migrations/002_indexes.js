// Migration 002 (architecture v0.3 §13): the exact 23 secondary indexes.
// createIndexes is idempotent for identical specs. autoIndex is off, so this
// is the only place indexes are created. Frozen once applied.

export const INDEXES = {
  groups: [
    { key: { slug: 1 }, name: 'slug_unique', unique: true },
    { key: { fplLeagueId: 1 }, name: 'fplLeagueId_unique_when_set', unique: true, partialFilterExpression: { fplLeagueId: { $type: 'number' } } },
    { key: { shareToken: 1 }, name: 'shareToken_unique_when_set', unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } },
    { key: { isActive: 1, name: 1 }, name: 'active_by_name' },
    { key: { 'members.entryId': 1 }, name: 'member_entry' },
  ],
  managers: [], // _id = entryId only
  seasons: [], // _id only
  events: [
    { key: { season: 1, gw: 1 }, name: 'season_gw' },
    { key: { season: 1, isCurrent: 1 }, name: 'season_current' },
  ],
  players: [{ key: { season: 1, teamId: 1 }, name: 'season_team' }],
  managerGameweeks: [
    { key: { season: 1, event: 1, entryId: 1 }, name: 'season_event_entry' },
    { key: { season: 1, entryId: 1, event: 1 }, name: 'season_entry_event' },
  ],
  managerSeasons: [{ key: { season: 1, entryId: 1 }, name: 'season_entry' }],
  liveGameweeks: [], // _id only
  syncRuns: [
    { key: { target: 1, startedAt: -1 }, name: 'target_recent' },
    { key: { status: 1, startedAt: -1 }, name: 'status_recent' },
    { key: { expireAt: 1 }, name: 'ttl_expireAt', expireAfterSeconds: 0 },
  ],
  fplRawResponses: [
    { key: { syncRunId: 1 }, name: 'by_run' },
    { key: { bodySha256: 1 }, name: 'by_hash' },
    { key: { expireAt: 1 }, name: 'ttl_expireAt', expireAfterSeconds: 0 },
  ],
  resultSnapshots: [
    { key: { groupId: 1, season: 1, event: 1, computedAt: -1 }, name: 'group_gw_recent' },
    { key: { inputsHash: 1 }, name: 'by_inputs_hash' },
  ],
  gwResults: [{ key: { groupId: 1, season: 1, event: -1 }, name: 'group_season_events' }],
  gwResultActions: [
    { key: { groupId: 1, season: 1, event: 1, seq: 1 }, name: 'linear_chain_unique', unique: true },
    { key: { groupId: 1, createdAt: -1 }, name: 'group_recent' },
  ],
  locks: [{ key: { expiresAt: 1 }, name: 'ttl_dead_leases', expireAfterSeconds: 86400 }],
  _migrations: [], // _id = migration name
};

export async function up(db) {
  for (const [collection, specs] of Object.entries(INDEXES)) {
    if (specs.length) await db.collection(collection).createIndexes(specs);
  }
}
