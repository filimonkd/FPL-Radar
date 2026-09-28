// Migration 001 (architecture v0.3 §2 #6, §12): create the 15 collections and
// install $jsonSchema validators (validationLevel strict, validationAction error).
// Idempotent: createCollection when missing, collMod when present.
// Frozen once applied: the runner stores this file's checksum.

const INT = ['int', 'long'];
const NINT = ['int', 'long', 'null'];
const SHA = '^sha256:[a-f0-9]{64}$';
const SEASON = '^\\d{4}-\\d{2}$';
const GW = { bsonType: INT, minimum: 1, maximum: 38 };

const POINTS_SEMANTICS = ['GROSS_BEFORE_HITS', 'NET_AFTER_HITS', 'UNVERIFIED', 'CONFLICTED'];
const RECONCILED = ['RECONCILED', 'RECONCILED_NO_COST'];
const UNRECONCILED = ['MISMATCH', 'SEMANTICS_CONFLICT', 'SOURCE_DISAGREEMENT', 'INCOMPLETE'];
const EVENT_STATES = ['UPCOMING', 'LIVE', 'MATCHES_FINISHED', 'FPL_PROCESSING', 'DATA_CHECKED'];
const TIE_BREAK_RULES = ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'HIGHER_CAPTAIN_POINTS', 'NO_CHIP_PLAYED', 'SHARED'];

const provenance = {
  bsonType: 'object',
  required: ['lastConfirmedByRunId', 'lastConfirmedAt', 'lastChangedByRunId', 'lastChangedAt', 'contentHash'],
  properties: {
    lastConfirmedByRunId: { bsonType: 'objectId' },
    lastConfirmedAt: { bsonType: 'date' },
    lastChangedByRunId: { bsonType: 'objectId' },
    lastChangedAt: { bsonType: 'date' },
    contentHash: { bsonType: 'string', pattern: SHA },
    settled: { bsonType: 'bool' },
  },
};

const fixture = {
  bsonType: 'object',
  required: ['id', 'teamH', 'teamA', 'started', 'finished', 'finishedProvisional'],
  properties: {
    id: { bsonType: INT }, teamH: { bsonType: INT }, teamA: { bsonType: INT },
    kickoffTime: { bsonType: ['date', 'null'] },
    started: { bsonType: 'bool' }, finished: { bsonType: 'bool' }, finishedProvisional: { bsonType: 'bool' },
  },
};

const schema = (required, properties, extra = {}) => ({ $jsonSchema: { bsonType: 'object', required, properties, ...extra } });

export const VALIDATORS = {
  groups: schema(
    ['_id', 'name', 'slug', 'memberSource', 'winnerRule', 'tieBreakRules', 'isActive', 'members', 'createdAt', 'updatedAt'],
    {
      name: { bsonType: 'string', minLength: 1, maxLength: 60 },
      slug: { bsonType: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
      memberSource: { enum: ['LEAGUE_STANDINGS', 'MANUAL'] },
      fplLeagueId: { bsonType: NINT, minimum: 1 },
      myEntryId: { bsonType: NINT },
      winnerRule: { enum: ['NET_POINTS', 'GROSS_POINTS'] },
      tieBreakRules: { bsonType: 'array', minItems: 1, uniqueItems: true, items: { enum: TIE_BREAK_RULES } },
      shareToken: { bsonType: ['string', 'null'] },
      isActive: { bsonType: 'bool' },
      archivedAt: { bsonType: ['date', 'null'] },
      members: {
        bsonType: 'array', maxItems: 50,
        items: {
          bsonType: 'object', required: ['entryId', 'addedAt'],
          properties: { entryId: { bsonType: INT, minimum: 1 }, joinedEvent: { bsonType: NINT, minimum: 1, maximum: 38 }, addedAt: { bsonType: 'date' } },
        },
      },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
    // League ID required unless the group's members are entered manually.
    { anyOf: [{ properties: { memberSource: { enum: ['MANUAL'] } } }, { required: ['fplLeagueId'], properties: { fplLeagueId: { bsonType: INT } } }] },
  ),
  managers: schema(['_id', 'entryId', 'playerName', 'teamName', 'provenance'], {
    _id: { bsonType: INT, minimum: 1 }, entryId: { bsonType: INT, minimum: 1 },
    playerName: { bsonType: 'string' }, teamName: { bsonType: 'string' }, provenance,
  }),
  seasons: schema(['_id', 'season', 'chipRules', 'pointsSemantics', 'provenance'], {
    _id: { bsonType: 'string', pattern: SEASON },
    season: { bsonType: 'string', pattern: SEASON },
    chipRules: {
      bsonType: 'object', required: ['source', 'rules', 'provenance'],
      properties: {
        source: { enum: ['FPL_BOOTSTRAP', 'CONFIG_FALLBACK'] },
        rules: {
          bsonType: 'array',
          items: {
            bsonType: 'object', required: ['chipName', 'startEvent', 'stopEvent', 'number'],
            properties: { chipName: { bsonType: 'string' }, startEvent: GW, stopEvent: GW, number: { bsonType: INT, minimum: 1 } },
          },
        },
        provenance,
      },
    },
    pointsSemantics: {
      bsonType: 'object', required: ['value', 'evidenceRows', 'conflictRows'],
      properties: {
        value: { enum: POINTS_SEMANTICS },
        evidenceRows: { bsonType: INT, minimum: 0 }, conflictRows: { bsonType: INT, minimum: 0 },
        firstVerifiedRunId: { bsonType: ['objectId', 'null'] },
      },
    },
    unscheduledFixtures: { bsonType: 'array', items: fixture },
    provenance,
  }),
  events: schema(['_id', 'season', 'gw', 'deadlineTime', 'finished', 'dataChecked', 'state', 'fixtures', 'provenance'], {
    _id: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}:\\d{1,2}$' },
    season: { bsonType: 'string', pattern: SEASON }, gw: GW, deadlineTime: { bsonType: 'date' },
    finished: { bsonType: 'bool' }, dataChecked: { bsonType: 'bool' },
    state: { enum: EVENT_STATES }, dataCheckedObservedAt: { bsonType: ['date', 'null'] },
    fixtures: { bsonType: 'array', items: fixture }, provenance,
  }),
  players: schema(['_id', 'season', 'elementId', 'webName', 'teamId', 'elementType', 'priceTenths', 'provenance'], {
    _id: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}:\\d+$' },
    season: { bsonType: 'string', pattern: SEASON }, elementId: { bsonType: INT, minimum: 1 },
    webName: { bsonType: 'string' }, teamId: { bsonType: INT, minimum: 1 },
    elementType: { bsonType: INT, minimum: 1, maximum: 4 }, priceTenths: { bsonType: INT, minimum: 0 }, provenance,
  }),
  managerGameweeks: schema(['_id', 'season', 'entryId', 'event', 'points', 'hasPicks', 'picks', 'provenance'], {
    _id: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}:\\d+:\\d{1,2}$' },
    season: { bsonType: 'string', pattern: SEASON }, entryId: { bsonType: INT, minimum: 1 }, event: GW,
    points: {
      bsonType: 'object',
      required: ['reportedGwPoints', 'transferCost', 'totalPoints', 'pointsSemantics', 'reconciliationStatus', 'netGwPoints', 'grossGwPoints'],
      properties: {
        reportedGwPoints: { bsonType: INT }, transferCost: { bsonType: INT, minimum: 0 }, totalPoints: { bsonType: INT },
        pointsSemantics: { enum: POINTS_SEMANTICS },
      },
      // net/gross are integers exactly when the row is reconciled (v0.2 §2).
      oneOf: [
        { properties: { reconciliationStatus: { enum: RECONCILED }, netGwPoints: { bsonType: INT }, grossGwPoints: { bsonType: INT } } },
        { properties: { reconciliationStatus: { enum: UNRECONCILED }, netGwPoints: { bsonType: 'null' }, grossGwPoints: { bsonType: 'null' } } },
      ],
    },
    hasPicks: { bsonType: 'bool' },
    picks: {
      bsonType: 'array', maxItems: 15,
      items: {
        bsonType: 'object', required: ['elementId', 'squadPosition', 'fplMultiplier', 'isCaptain', 'isViceCaptain'],
        properties: {
          elementId: { bsonType: INT, minimum: 1 }, squadPosition: { bsonType: INT, minimum: 1, maximum: 15 },
          fplMultiplier: { bsonType: INT, minimum: 0, maximum: 3 }, isCaptain: { bsonType: 'bool' }, isViceCaptain: { bsonType: 'bool' },
        },
      },
    },
    provenance,
  }, {
    // Exactly 15 picks when hasPicks, none otherwise; element-level rules live in shared code.
    oneOf: [
      { properties: { hasPicks: { enum: [true] }, picks: { minItems: 15 } } },
      { properties: { hasPicks: { enum: [false] }, picks: { maxItems: 0 } } },
    ],
  }),
  managerSeasons: schema(['_id', 'season', 'entryId', 'chips', 'transfers', 'provenance'], {
    _id: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}:\\d+$' },
    season: { bsonType: 'string', pattern: SEASON }, entryId: { bsonType: INT, minimum: 1 },
    chips: { bsonType: 'array', items: { bsonType: 'object', required: ['name', 'event'], properties: { name: { bsonType: 'string' }, event: GW } } },
    transfers: {
      bsonType: 'array',
      items: {
        bsonType: 'object', required: ['elementIn', 'elementInCostTenths', 'elementOut', 'elementOutCostTenths', 'event', 'time'],
        properties: { elementInCostTenths: { bsonType: INT, minimum: 0 }, elementOutCostTenths: { bsonType: INT, minimum: 0 }, event: GW, time: { bsonType: 'date' } },
      },
    },
    provenance,
  }),
  liveGameweeks: schema(['_id', 'season', 'gw', 'elements', 'provenance'], {
    _id: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}:\\d{1,2}$' },
    season: { bsonType: 'string', pattern: SEASON }, gw: GW,
    elements: {
      bsonType: 'array',
      items: {
        bsonType: 'object', required: ['elementId', 'totalPoints', 'minutes', 'settled'],
        properties: { elementId: { bsonType: INT }, totalPoints: { bsonType: INT }, minutes: { bsonType: INT, minimum: 0 }, settled: { bsonType: 'bool' } },
      },
    },
    provenance,
  }),
  syncRuns: schema(['job', 'trigger', 'status', 'requests', 'startedAt'], {
    job: { bsonType: 'string' },
    trigger: { enum: ['MANUAL', 'FINALIZE', 'SCHEDULER', 'SMOKE', 'STARTUP'] },
    status: { enum: ['RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'ABANDONED'] },
    requests: { bsonType: 'array', maxItems: 300 },
    startedAt: { bsonType: 'date' }, finishedAt: { bsonType: ['date', 'null'] }, expireAt: { bsonType: 'date' },
  }),
  fplRawResponses: schema(['path', 'bodyGzip', 'bodySha256', 'bytesRaw', 'bytesStored', 'reason', 'capturedAt'], {
    path: { bsonType: 'string' }, bodyGzip: { bsonType: 'binData' },
    bodySha256: { bsonType: 'string', pattern: SHA },
    bytesRaw: { bsonType: INT, minimum: 0, maximum: 2097152 }, bytesStored: { bsonType: INT, minimum: 0 },
    reason: { enum: ['FINAL_EVIDENCE', 'SCHEMA_FAIL', 'CHIP_RULES_INVALID', 'SMOKE'] },
    expireAt: { bsonType: 'date' }, capturedAt: { bsonType: 'date' },
  }),
  resultSnapshots: schema(
    ['groupId', 'season', 'event', 'kind', 'winnerRule', 'tieBreakRules', 'computedWinnerEntryIds', 'declaredWinnerEntryIds',
      'tieBreakTrace', 'standings', 'inputs', 'inputsHash', 'eventState', 'engineVersion', 'sources', 'contentHash', 'computedAt'],
    {
      groupId: { bsonType: 'objectId' }, season: { bsonType: 'string', pattern: SEASON }, event: GW,
      kind: { enum: ['RULE_BASED', 'OVERRIDE'] }, winnerRule: { enum: ['NET_POINTS', 'GROSS_POINTS'] },
      inputsHash: { bsonType: 'string', pattern: SHA }, contentHash: { bsonType: 'string', pattern: SHA },
      eventState: { enum: EVENT_STATES }, computedAt: { bsonType: 'date' },
    },
  ),
  gwResults: schema(['_id', 'groupId', 'season', 'event', 'status', 'currentSnapshotId', 'headSeq', 'headHash', 'updatedAt'], {
    _id: { bsonType: 'string', pattern: '^[a-f0-9]{24}:\\d{4}-\\d{2}:\\d{1,2}$' },
    groupId: { bsonType: 'objectId' }, season: { bsonType: 'string', pattern: SEASON }, event: GW,
    status: { enum: ['FINAL', 'OVERRIDDEN'] }, currentSnapshotId: { bsonType: 'objectId' },
    headSeq: { bsonType: INT, minimum: 1 }, headHash: { bsonType: 'string', pattern: SHA }, updatedAt: { bsonType: 'date' },
  }),
  gwResultActions: schema(
    ['groupId', 'season', 'event', 'seq', 'action', 'prevStatus', 'newStatus', 'prevWinnerEntryIds', 'newWinnerEntryIds',
      'newSnapshotId', 'newSnapshotHash', 'prevHash', 'hash', 'createdAt'],
    {
      groupId: { bsonType: 'objectId' }, season: { bsonType: 'string', pattern: SEASON }, event: GW,
      seq: { bsonType: INT, minimum: 1 },
      action: { enum: ['FINALIZE', 'OVERRIDE', 'RECOMPUTE'] },
      prevStatus: { enum: ['PROVISIONAL', 'FINAL', 'OVERRIDDEN'] }, newStatus: { enum: ['FINAL', 'OVERRIDDEN'] },
      newSnapshotId: { bsonType: 'objectId' }, newSnapshotHash: { bsonType: 'string', pattern: SHA },
      note: { bsonType: ['string', 'null'], maxLength: 280 },
      prevHash: { bsonType: 'string' }, hash: { bsonType: 'string', pattern: SHA }, createdAt: { bsonType: 'date' },
    },
    // An OVERRIDE must carry a note of at least 3 characters.
    { anyOf: [{ properties: { action: { enum: ['FINALIZE', 'RECOMPUTE'] } } }, { required: ['note'], properties: { note: { bsonType: 'string', minLength: 3 } } }] },
  ),
  locks: schema(['_id', 'fencingToken', 'expiresAt'], {
    _id: { bsonType: 'string' }, owner: { bsonType: ['objectId', 'null'] },
    fencingToken: { bsonType: INT, minimum: 0 }, expiresAt: { bsonType: 'date' },
  }),
  _migrations: schema(['_id', 'checksum', 'appliedAt'], {
    _id: { bsonType: 'string', pattern: '^\\d{3}_[a-z0-9_]+$' },
    checksum: { bsonType: 'string', pattern: SHA }, appliedAt: { bsonType: 'date' },
  }),
};

const NAMESPACE_EXISTS = 48;

export async function up(db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const [name, validator] of Object.entries(VALIDATORS)) {
    const options = { validator, validationLevel: 'strict', validationAction: 'error' };
    if (!existing.has(name)) {
      try {
        await db.createCollection(name, options);
        continue;
      } catch (err) {
        if (err.code !== NAMESPACE_EXISTS) throw err; // created concurrently: fall through to collMod
      }
    }
    await db.command({ collMod: name, ...options });
  }
}
