FPL Rival Dashboard — v0.3 MongoDB Persistence Architecture
Sep 23, 2026 · @Filimon
1. Decision summary
Persistence moves to MongoDB Atlas M0 (free), accessed through Mongoose 9. The data is redesigned around documents: 15 collections, deterministic _ids for idempotent upserts, and embedding wherever data is always read together. PostgreSQL features with no MongoDB equivalent are replaced by the patterns in §2. Every v0.2 product and correctness requirement is preserved, and the analytics layer doesn't change.
Why Mongoose over the raw driver: it's already the default stack, and it gives schema casting, enum validation and immutable fields. Its session support covers transactions. The repositories call the native driver (Model.collection) only where Mongoose adds nothing, e.g. bulkWrite with pipeline updates.
Atlas M0 facts this design depends on (verify during setup)
Fact
Consequence
M0 is a 3-member replica set running MongoDB 8.x
Multi-document transactions are available
512 MB storage
Raw responses stored gzipped, bootstrap bodies never stored, TTL expiry (§9)
No automated backups on M0
Scheduled, encrypted export of configuration, snapshot and audit collections (§11)
Connection limit ~500
Pool size capped at 10
Custom database roles are available on M0 (changes take ~30 s to apply)
The append-only guarantee doesn't depend on DB roles (§7)
No static egress IPs on Render free
Atlas IP access list = Render's published outbound CIDR ranges for the service's region (never 0.0.0.0/0), plus a strong SCRAM user and TLS (§11)
Unchanged from v0.2: point reconciliation and season semantics, the event state machine and finalize gate, missing-member blocking, competition rank vs resolved position, effective squad derivation, picked vs effective ownership, chip rule provenance, the tie-break logic, contract tests against real FPL samples, archive-instead-of-delete, and every analytics function signature.
Replaced: everything in v0.2 §12 (data model), §13 (Prisma schema) and the persistence parts of §15 (sync flow) and §17 (implementation order). The integration tests from v0.2 §16 are re-targeted (§15 below).
2. PostgreSQL features that don't carry over
17 relational mechanisms from v0.2 have no direct MongoDB equivalent. Each one is replaced by an explicit application or document pattern. None of these replacements rely on the database alone to enforce correctness: the repository layer and tests enforce them too.
#
v0.2 PostgreSQL mechanism
Why it doesn't carry over
MongoDB replacement
1
pg_try_advisory_lock per group
No advisory locks
Lease lock in a locks collection, with a fencing token checked inside each write transaction (§5)
2
BEFORE UPDATE/DELETE triggers (append-only)
No triggers on the cluster (Atlas App Services triggers run after the write and can't veto)
Insert-only repository, Mongoose query middleware that throws, immutable fields, per-GW seq unique index and a SHA-256 hash chain (§7)
3
Foreign keys + ON DELETE RESTRICT
No FKs
No delete paths at all; references by ID validated in the repository inside the write transaction; npm run db:check orphan scan
4
Composite primary keys
_id is a single field
Deterministic string _id built from the natural key, e.g. 2026-27:123456:5 (§4)
5
ON CONFLICT DO UPDATE upserts
Different semantics
updateOne/replaceOne with upsert: true on deterministic _id, batched in bulkWrite
6
CHECK constraints
No row constraints
$jsonSchema collection validators (validationLevel: strict) + Mongoose validators, both installed by migration
7
UNIQUE on a nullable column (fpl_league_id)
A null counts as a value in a MongoDB unique index
Partial unique index with partialFilterExpression: { fplLeagueId: { $type: 'number' } }
8
Join tables (result_snapshot_sources, group_members)
No joins
Embedded arrays: resultSnapshots.sources[], groups.members[]
9
Child tables read with the parent (manager_picks, manager_auto_subs, sync_run_requests, fixtures, teams, chip_rules)
Joins needed
Embedded in their parent document (§3)
10
BIGSERIAL ordering
No sequences; ObjectId order isn't a strict sequence
Explicit seq per result stream, guarded by a unique index; createdAt for display only
11
NUMERIC(4,1) prices
Decimal128 is awkward and unnecessary
Integer tenths (FPL's native now_cost format); formatting happens in the client
12
Generated column net_gw_points
None
Written by the reconciler; the validator enforces netGwPoints null ⇔ not reconciled
13
retain_until + prune job
No scheduled SQL
TTL index on expireAt; permanent retention = the field is absent
14
Implicit single-statement atomicity across rows
Atomicity is per document
Explicit session.withTransaction for every multi-document write (§5); single-document writes preferred by design
15
SQL migrations (DDL)
Collections are schemaless
Versioned JS migrations recorded in _migrations: createIndexes, collMod validators
16
Postgres ENUM types
None
String enums in Mongoose + $jsonSchema enum
17
Transaction isolation (READ COMMITTED default)
Different model
Transactions use readConcern: snapshot, writeConcern: majority, readPreference: primary; everything outside transactions uses majority writes
3. Collections and document structure
There are 15 collections in five families: config, season reference data, manager snapshots, provenance, and results/audit. The embedding rule is to embed what is bounded and always read with the parent, and to reference what grows without bound, is shared, or must stay immutable on its own.
Collection
_id
One doc per
Embeds
References
groups
ObjectId
group
members[] (≤ 50)
members.entryId → managers
managers
entryId (int)
FPL entry
none
provenance.lastConfirmedByRunId
seasons
"2026-27"
season
teams[] (20), chipRules (+ source), pointsSemantics, unscheduledFixtures[]
provenance run IDs
events
"2026-27:5"
season + GW
fixtures[] (~10), derived state, dataCheckedObservedAt
provenance
players
"2026-27:351"
season + player
none
teamId → seasons.teams
managerGameweeks
"2026-27:123456:5"
entry + GW
normalized points, picks[15], autoSubs[], activeChip, provenance
none
managerSeasons
"2026-27:123456"
entry + season
chips[], transfers[] (full lists from FPL)
provenance
liveGameweeks
"2026-27:5"
season + GW
elements[] (~800: points, minutes, settled)
provenance
syncRuns
ObjectId
sync run
requests[] (≤ ~120 per run), failures[]
rawResponseIds
fplRawResponses
ObjectId
stored FPL response
gzipped body
syncRunId
resultSnapshots
ObjectId
frozen computation
standings, inputs, sources[] (run IDs + request hashes)
groupId
gwResults
"<groupId>:2026-27:5"
group + GW
head pointer + headSeq, headHash
currentSnapshotId
gwResultActions
ObjectId
audit event
prev/new winners, hashes
snapshot IDs, syncRunId
locks
"sync:group:<groupId>"
lease
owner, fencing token
owner = runId
_migrations
migration name
applied migration
none
none
Why these embeds
• picks and autoSubs inside managerGameweeks: they're always 15 picks, always read with the GW row by reconciliation, effective-squad derivation and ownership, and they're written by the same FPL fetch. One document write replaces both at once, so there's never a half-updated squad.
• fixtures inside events: ~10 per GW, and needed together for deriveEventState. Each bootstrap sync rebuilds every event's fixtures[] from the full fixtures list, so a postponed fixture moves out of its old GW in the same transaction.
• chipRules and pointsSemantics inside seasons: chip rules must be replaced as a whole set (v0.2 §8), which is one atomic single-document write. Semantics counters update with $inc, also atomic.
• requests[] inside syncRuns: bounded and append-only during the run ($push), and read together on the Status page.
• sources[] inside resultSnapshots: it's part of the immutable record and must never change separately.
Why these references
• managers is shared across groups, so it's referenced.
• resultSnapshots/gwResultActions grow per decision and must be immutable, so they're separate documents.
• fplRawResponses are large, with separate retention, so they're referenced.
• players (~800 per season) are updated independently of events.
Representative managerGameweeks document
{
  "_id": "2026-27:123456:5",
  "season": "2026-27", "entryId": 123456, "event": 5,
  "points": {
    "reportedGwPoints": 70, "transferCost": 4,
    "netGwPoints": 66, "grossGwPoints": 70,
    "totalPoints": 331, "previousTotalPoints": 265,
    "picksReportedPoints": 70,
    "pointsSemantics": "GROSS_BEFORE_HITS",
    "reconciliationStatus": "RECONCILED",
    "reconciliationDetail": { "delta": 66, "hypothesis": "GROSS", "picksPoints": 70 }
  },
  "eventTransfers": 2, "pointsOnBench": 6, "overallRank": 812345,
  "bankTenths": 5, "teamValueTenths": 1012,
  "activeChip": null,
  "hasPicks": true,
  "picks": [
    { "elementId": 351, "squadPosition": 1, "fplMultiplier": 1, "isCaptain": false, "isViceCaptain": false }
  ],
  "autoSubs": [ { "elementIn": 412, "elementOut": 88, "source": "FPL" } ],
  "provenance": {
    "lastConfirmedByRunId": "66f1...a1", "lastConfirmedAt": "2026-09-22T19:04:11Z",
    "lastChangedByRunId": "66f0...9c", "lastChangedAt": "2026-09-21T08:30:02Z",
    "contentHash": "sha256:4b1e...",
    "sourceRequests": { "history": "sha256:aa01...", "picks": "sha256:bb02..." },
    "settled": true
  }
}
Prices are integer tenths throughout (priceTenths, bankTenths), and all dates are BSON Date in UTC.
4. Uniqueness guarantees and deterministic _ids
Uniqueness is enforced by the database in two ways:
• Natural-key snapshot documents use a deterministic _id built from their key. Uniqueness is therefore guaranteed by the mandatory _id index, and every sync write is an idempotent upsert on that _id.
• Other constraints use explicit unique indexes, partial where the field is optional.
_id formats (built by one helper, ids.js, never inline)
Collection
_id
Example
seasons
<season>
2026-27
events, liveGameweeks
<season>:<gw>
2026-27:5
players
<season>:<elementId>
2026-27:351
managers
<entryId> (int)
123456
managerGameweeks
<season>:<entryId>:<gw>
2026-27:123456:5
managerSeasons
<season>:<entryId>
2026-27:123456
gwResults
<groupId>:<season>:<gw>
66f0c1…:2026-27:5
locks
<scope>:<key>
sync:group:66f0c1…, sync:bootstrap, migrate
The season key uses - rather than /, so it's safe in IDs and URLs. The component fields (season, entryId, event) are also stored as top-level fields for querying and validation. A Mongoose pre('validate') hook derives _id from them, and rejects a document whose _id doesn't match.
Other uniqueness rules
Rule
Mechanism
Group slug unique
groups { slug: 1 } unique
League ID unique across active + archived groups, optional for manual groups
groups { fplLeagueId: 1 } unique, partial { fplLeagueId: { $type: 'number' } }
Share token unique when set
groups { shareToken: 1 } unique, partial { shareToken: { $type: 'string' } }
No duplicate member within a group
Enforced in the repository: members are updated with $addToSet semantics keyed on entryId inside the group's single document (atomic); validator requires unique entryIds via app check before write
Audit history is a single linear chain per group + GW
gwResultActions { groupId: 1, season: 1, event: 1, seq: 1 } unique
One transfer per (time, in, out) within a manager season
Embedded list replaced wholesale from FPL each sync; de-duplicated by the mapper on time+in+out
One snapshot per decision
New ObjectId per insert; the action row references it; no uniqueness needed beyond _id
MongoDB has no unique constraint across array elements within one document. So members[].entryId uniqueness is guaranteed by the group repository, which is the only writer and uses a read-modify-write inside a transaction. A test covers it.
5. Transactions and locking
Most writes are designed to be single-document, and therefore atomic without a transaction. Multi-document transactions are used only where v0.2 correctness needs cross-document atomicity: four boundaries (T1–T4). A lease lock with a fencing token replaces the advisory lock.
Transaction boundaries
#
Operation
Documents touched
Mode
T1
Bootstrap: season + events
seasons (teams, chipRules), all events (state, fixtures), locks fence
Transaction
—
Players refresh
~800 players upserts
Unordered bulkWrite, no transaction (each doc is independent and idempotent)
T2
Group member sync
groups (members), N managers, locks fence
Transaction
T3
Per-member GW sync
≤ 38 managerGameweeks + 1 managerSeasons + 1 managers, locks fence
Transaction per member
—
Live points
1 liveGameweeks doc
Single-doc replace
—
Semantics evidence
1 seasons doc ($inc)
Single-doc update
—
Sync run progress
1 syncRuns doc ($push requests)
Single-doc update
T4
Finalize / override / recompute
insert resultSnapshots, insert gwResultActions, conditional update gwResults, $unset expireAt on evidence fplRawResponses + referenced syncRuns, locks fence
Transaction
T5
Archive / unarchive
1 groups doc
Single-doc update
T6
Migrations
_migrations + index/validator commands
Lock migrate, no transaction (DDL isn't transactional)
Transaction settings: session.withTransaction(fn, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 10000 }). withTransaction automatically retries TransientTransactionError and UnknownTransactionCommitResult. Every write inside a transaction is idempotent (upsert on deterministic _id, or insert guarded by seq), so retries are safe. Each transaction stays under 100 documents and 5 s, well inside the 60 s limit.
Lease lock (replaces pg_try_advisory_lock)
locks document: { _id: 'sync:group:<id>', owner: <runId|null>, fencingToken: <int>, expiresAt: Date, acquiredAt: Date, heartbeatAt: Date }
1. Acquire. Run one atomic findOneAndUpdate with filter { _id, $or: [ { owner: null }, { expiresAt: { $lt: $$NOW } } ] }. The update is a pipeline (sent with updatePipeline: true, since Mongoose 9 rejects update pipelines by default, and returnDocument: 'after') setting owner = runId, expiresAt = $$NOW + 120 s, fencingToken + 1, with upsert: true.
    ◦ Missing doc → inserted, and the lock is acquired.
    ◦ Doc exists but held → the filter misses, so the upsert attempts an insert with the same _id → E11000 duplicate key → locked, and the API returns 409 SYNC_IN_PROGRESS.
    ◦ $$NOW is server time, so clock skew between app instances doesn't matter.
2. Heartbeat. Every 30 s, updateOne({ _id, owner: runId, fencingToken }, { expiresAt: $$NOW + 120 s }). If it matches 0 documents, the lease is lost: the run aborts and is marked FAILED with LOCK_LOST.
3. Fence. The first statement in every T1–T3 transaction is updateOne({ _id: lockId, owner: runId, fencingToken }, { $set: { lastWriteAt: $$NOW } }). If it matches 0, the transaction aborts. Because it writes the lock document, a concurrent takeover produces a write conflict, so a stale holder can never commit data after losing its lease.
4. Release. updateOne({ _id, owner: runId }, { owner: null, expiresAt: $$NOW }) in a finally block.
5. Crash recovery. A crashed holder's lease simply expires after 120 s. Any syncRuns still RUNNING with an expired lock are marked ABANDONED by the next acquirer.
6. Cleanup. A TTL index on expiresAt (expireAfterSeconds: 86400) deletes long-dead lock documents. Correctness never depends on TTL timing.
Finalize acquires the same group lock, since it syncs first. Two tabs clicking finalize therefore get one success and one 409. The gwResults update in T4 additionally uses optimistic concurrency, so a second decision can't slip in: the filter is { _id, headSeq: expected }.
6. Idempotent sync strategy
Re-running any sync with the same FPL responses leaves the database byte-identical, apart from provenance "confirmed" stamps. Every snapshot write is an upsert on a deterministic _id, whole embedded lists are replaced rather than patched, and a content hash separates "confirmed" from "changed".
Write rules
1. Deterministic _id + upsert. updateOne({ _id }, update, { upsert: true }) inside a bulkWrite. A replay never inserts a duplicate.
2. Replace embedded lists wholesale. picks, autoSubs, fixtures, chips, transfers, teams, chipRules and elements are always $set as complete arrays built from the latest FPL response. There's never a $push into snapshot data, so a replay can't append twice.
3. Content hash. The mapper computes contentHash = sha256(canonicalJSON(snapshotFields)), excluding provenance. A conditional pipeline update then does the following:
    ◦ Always sets provenance.lastConfirmedByRunId/At.
    ◦ Sets the data fields plus provenance.lastChangedByRunId/At only when contentHash differs. It is sent through the native Model.collection.bulkWrite, which bypasses Mongoose's update-pipeline restriction by design, and the update uses $cond on $contentHash.
    ◦ If provenance.settled is true and the hash differs, it still writes (FPL is the source of truth), but records SETTLED_ROW_CHANGED in the run's warnings[] with the old and new hashes.
4. Settled flag. settled = true when the writing run started after events.dataCheckedObservedAt for that GW. It is computed in the repository from the run's startedAt.
5. Reconciliation before write. reconcileSeason() runs on the full fetched history before the T3 transaction. The whole season's managerGameweeks for that entry are written in the same transaction, so there's never a mix of old and new reconciliation results.
6. Failure isolation. If one member's fetch or T3 fails, that member's documents keep their previous lastConfirmedByRunId. The run becomes PARTIAL with failures[]. The finalize gate then sees the stale confirmation and returns STALE_SYNC, and the result is BLOCKED for NOT_SYNCED (the v0.2 missing-member blocking rule, preserved).
7. Run lifecycle. syncRuns is inserted RUNNING before any fetch, then progresses with single-document updates, and ends as SUCCESS | PARTIAL | FAILED | ABANDONED. The run document is the unit of provenance.
Freshness gate inputs (v0.2 §3 check 4, adapted): for each eligible member, the repository returns lastConfirmedByRunId plus that run's startedAt and status. canFinalize itself is unchanged.
Replay test: running the same recorded samples through a sync twice yields identical contentHash values and zero lastChangedByRunId updates on the second run (§15).
7. Immutable snapshots and append-only audit
Without triggers, immutability comes from five independent layers. Tampering that bypasses the first three is still detected by the fourth and fifth. resultSnapshots and gwResultActions are insert-only, and gwResults is the only mutable pointer, updated under optimistic concurrency.
Layers
#
Layer
Stops
Doesn't stop
1
Repository surface. resultRepo exposes only insertSnapshot, appendAction, movePointer and reads. No update/delete functions exist for these collections
App code mistakes
Direct DB access
2
Mongoose middleware. pre hooks on updateOne, updateMany, findOneAndUpdate, replaceOne, findOneAndReplace, deleteOne, deleteMany, findOneAndDelete for both models throw ImmutableCollectionError. Every field is immutable: true
Accidental Mongoose calls
Native driver, shell
3
DB role (if Atlas tier allows custom roles). The app user gets find + insert only on resultSnapshots, gwResultActions; readWrite elsewhere. Admin uses a separate user
Driver-level updates from the app
Admin user
4
Linear sequence. Each action has seq = previous headSeq + 1, and the unique index { groupId, season, event, seq } makes a fork impossible. The gwResults update filter { headSeq: expected } stops concurrent decisions
Forks, lost updates
Edits to an existing doc
5
Hash chain. action.hash = sha256(canonical({ …actionFields, prevHash, newSnapshotHash })), where prevHash is the previous action's hash ('GENESIS' for seq 1). snapshot.contentHash is the hash of the canonical snapshot
Nothing, but detects any edit or deletion
n/a
Verification: GET /groups/:id/gw/:gw/actions/verify walks the chain. It recomputes every action hash and every referenced snapshot's contentHash, and checks seq continuity and that gwResults.headHash equals the last hash. The result is { valid, brokenAtSeq?, reason? }, shown as a badge in the History drawer. A tampered chain also blocks further decisions on that GW until an admin investigates.
T4 decision transaction (finalize / override / recompute)
1. Fence write on the group lock document (abort if the lease was lost), then read gwResults (or none), to get headSeq, headHash and currentSnapshotId.
2. Insert a resultSnapshots document with contentHash and embedded sources[].
3. Insert gwResultActions with seq = headSeq + 1, prevHash = headHash, and the computed hash.
4. Upsert gwResults with filter { _id, headSeq: headSeq } (or { _id } with $setOnInsert when it's the first decision), setting status, currentSnapshotId, headSeq + 1 and the new headHash. If it matches 0 documents with no upsert → abort with 409 CONCURRENT_DECISION.
5. $unset: { expireAt } on the evidence fplRawResponses and on the referenced syncRuns, so their retention becomes permanent.
6. Commit.
Previous snapshots and actions are never touched, so an override adds history and never erases it.
8. Provenance and sync run relationships
Every snapshot document carries a provenance sub-document pointing at syncRuns. Every finalized result embeds the complete list of runs and request hashes behind its inputs. The v0.2 trace path is preserved without joins, as a chain of ID lookups:
gwResults.currentSnapshotId → resultSnapshots.sources[].syncRunId → syncRuns.requests[].bodySha256 / rawResponseId → fplRawResponses
provenance sub-document (on managers, events, players, managerGameweeks, managerSeasons, liveGameweeks, and on the season's chipRules/teams blocks)
Field
Meaning
lastConfirmedByRunId, lastConfirmedAt
Latest run that fetched this doc and found it valid (changed or not)
lastChangedByRunId, lastChangedAt
Latest run that changed its content
contentHash
sha256 of the canonical snapshot fields
sourceRequests
{ <role>: bodySha256 } for each FPL response that fed it (history, picks, live, bootstrap, fixtures)
settled
Written after DATA_CHECKED was observed (§6)
syncRuns document
• The document holds job, trigger, target (groupId or bootstrap), season, event, status, lockFencingToken, startedAt, finishedAt, warnings[] and failures[].
• It also holds requests[], one entry per FPL call: { path, httpStatus, bodySha256, bytes, durationMs, schemaOk, fromCache, rawResponseId? }.
• requests[] is capped at 300 entries. Past that, the run records REQUEST_LOG_TRUNCATED, which is unreachable at 19 managers (~70 calls).
resultSnapshots.sources[]: one entry per distinct run that last confirmed any input document: { syncRunId, startedAt, status, requestHashes: [bodySha256…] }. It's built by the repository while assembling the inputs. The snapshot also stores inputs (the exact normalized objects passed to computeGwResult), inputsHash and engineVersion, so verify can recompute without touching live collections.
Why embed the sources instead of referencing only: a snapshot must stay self-describing even if a run document were somehow altered. The embedded hashes make any later drift in syncRuns detectable.
9. Raw FPL response retention and storage budget
Raw bodies are stored gzipped in fplRawResponses only when they're evidence (finalize), a smoke-test sample, or a failure capture. Retention is controlled by a TTL index on expireAt: a document without expireAt is permanent. Bootstrap bodies (~1.5 MB each) are never stored, only their hash.
fplRawResponses document: { _id, syncRunId, path, httpStatus, contentType, bodyGzip: BinData, bodySha256, bytesRaw, bytesStored, reason, expireAt?, retainedBySnapshotIds[], capturedAt }
Reason
Stored when
expireAt
FINAL_EVIDENCE
history, picks, live, transfers fetched by a FINALIZE run
Set to +14 days at insert; $unset in T4 (permanent) once referenced by a snapshot
SCHEMA_FAIL
zod validation fails
+30 days
CHIP_RULES_INVALID
chips[] rejected
+30 days
SMOKE
smoke test run against the DB (optional; samples are committed to the repo anyway)
+7 days
Rules
• The body is gzipped before insert, and bodySha256 is computed on the raw bytes, so it matches syncRuns.requests[].bodySha256.
• Hard cap: bodies over 2 MB raw are not stored. Only hash and size are logged, with RAW_TOO_LARGE. This excludes bootstrap by design.
• syncRuns also get expireAt = +90 days, which is unset in T4 when a snapshot references them. A finalized result's runs are therefore never deleted.
• TTL runs roughly every 60 s and is only housekeeping. No read path assumes expired documents are gone.
Storage budget, per season (2 groups, 19 managers)
Collection
Estimate
managerGameweeks (19 × 38 × ~3 KB)
~2.2 MB
managerSeasons (19 × ~15 KB)
~0.3 MB
liveGameweeks (38 × ~60 KB)
~2.3 MB
players + events + seasons
~1 MB
syncRuns retained (~2 finalize runs × 38 GWs × ~20 KB, plus 90-day rolling window of others)
~5 MB
fplRawResponses permanent evidence (~25 gzipped bodies × ~6 KB × 2 groups × 38)
~11 MB
resultSnapshots (2 × 38 × ~40 KB, plus overrides)
~3.5 MB
Indexes
~5 MB
Total
~30 MB per season, about 6% of the 512 MB M0 limit
A storage gauge on the Status page reads dbStats, and warns at 60% of quota.
10. Repository layer
Repositories are the only code that imports Mongoose models. They return plain objects in exactly the shapes the analytics contracts (v0.2 §14) already take. reconcileSeason, deriveEventState, canFinalize, computeGwResult, deriveEffectiveSquad, computeOwnership and chipAvailability keep their signatures and don't change at all.
flowchart LR
  C[Controllers / services] --> R[Repositories]
  C --> A[Analytics<br/>pure, unchanged]
  R --> M[Mongoose models]
  M --> DB[(Atlas)]
  R -. plain objects .-> C
Rules
1. Every read uses .lean() and passes through a mapper (toDomain). _ids become strings, Date stays Date, and tenths stay integers. Internal fields (contentHash, provenance) are dropped unless requested.
2. Every method accepts an optional { session } as its last argument. Transactions are opened only by db/unitOfWork.js: withTransaction(async (session) => { … }). Repositories never open their own.
3. Input assemblers live in the repositories, not in analytics. For example:
    ◦ resultRepo.loadResultInputs(groupId, season, event) returns { group, event, eventState, members, gwRows, effectiveSquads, managers, freshness }. freshness is the per-member { syncRunStartedAt, syncRunStatus } needed by canFinalize.
    ◦ ownershipRepo.loadSquads(groupId, season, event) returns picks, chips, auto-subs and live data for deriveEffectiveSquad.
4. Services orchestrate: load via repositories → call pure analytics → persist via repositories.
5. Boundary test (test/unit/architecture.test.js, node:test): it scans src/analytics/** and fails if any file imports mongoose, mongodb, ../db, ../repositories or ../models, or reads process.env.
Repositories and their write surface
Repository
Collections
Writes allowed
groupRepo
groups
create, update config, set members (tx), archive/unarchive
managerRepo
managers
upsert profile
seasonRepo
seasons
replace teams + chipRules (tx T1), $inc semantics
eventRepo
events
bulk upsert with fixtures + state (tx T1)
playerRepo
players
bulk upsert
managerGameweekRepo
managerGameweeks
bulk upsert season rows (tx T3)
managerSeasonRepo
managerSeasons
upsert chips + transfers (tx T3)
liveRepo
liveGameweeks
replace one
syncRunRepo
syncRuns
insert, push request, finish, mark abandoned, unset expiry (T4)
rawResponseRepo
fplRawResponses
insert, unset expiry (T4)
resultRepo
resultSnapshots, gwResultActions, gwResults
insertSnapshot, appendAction, movePointer. No updates or deletes on the first two
lockRepo
locks
acquire, heartbeat, fence (in tx), release
No repository has a delete method for any collection. TTL is the only deletion mechanism, and it applies only to expiring provenance documents.
npm run db:check
db:check is a read-only scan that verifies eight invariants the database can't enforce by itself. It exits 1 on any ERROR and 0 otherwise, and prints a JSON report.
• Connection: it connects as backup-ro (read only) with readPreference: 'secondaryPreferred'. It never writes and never takes a lock.
• Where it runs: locally, in CI after integration tests, in the weekly backup workflow against the restored dump, and on demand from the Status page (summary only).
• Shared logic: every check reuses the same pure modules the app uses (ids.js, canonical.js, audit/hashChain.js, validation/picks.js), so the checker can't disagree with the writer.
#
Invariant
How it's checked
Severity
I1
No duplicate member entryId within a group
$unwind: '$members' → $group by { _id, entryId } → count > 1
ERROR
I2
Every deterministic _id is valid
For seasons, events, players, managerGameweeks, managerSeasons, liveGameweeks, gwResults, locks: format regex, plus rebuild from fields with ids.js and compare
ERROR
I3
No orphan manager references
Every groups.members.entryId, non-null groups.myEntryId, and entryId in managerGameweeks / managerSeasons exists in managers; myEntryId is also a member of its group
ERROR
I4
Result snapshot references are valid
See the I4 list below
ERROR
I5
Audit hash chain intact
See the I5 list below
ERROR
I6
Source run references valid
Every resultSnapshots.sources[].syncRunId and non-null gwResultActions.syncRunId exists; each sources[].requestHashes value appears in that run's requests[].bodySha256. A mutable snapshot doc whose provenance.lastConfirmedByRunId has legitimately TTL-expired → INFO
ERROR / INFO
I7
Finalized results keep their sources
See the I7 list below
ERROR
I8
Stored picks are valid (pick validation, §12)
pickViolations() over every managerGameweeks doc with hasPicks: true
ERROR
I4 checks:
• gwResults.currentSnapshotId exists, and that snapshot's groupId/season/event match the pointer.
• Every gwResultActions.prevSnapshotId / newSnapshotId exists.
• action.newSnapshotHash equals the snapshot's recomputed contentHash.
• The pointer's currentSnapshotId equals the last action's newSnapshotId.
I5 checks, per (groupId, season, event):
• seq runs 1..n without gaps.
• Every prevHash equals the previous action's hash ('GENESIS' for seq 1).
• Every hash recomputes.
• gwResults.headSeq / headHash equal the last action's values.
I7 checks, for every snapshot referenced by any action (not just the current one):
• Every source run exists.
• Every source run has no expireAt.
• Every evidence fplRawResponses doc referencing that run's hashes (if present) has no expireAt.
A source run that is missing or still expiring means provenance for a declared winner is at risk.
Report shape: { ok, checkedAt, dbName, counts: { error, info }, violations: [{ invariant, severity, collection, id, detail }] }. The weekly workflow names the artifact with the result (…-dbcheck-ok / …-dbcheck-FAIL), and fails the job on ERROR.
Scale: at ~30 MB per season, the full scan reads everything in a few seconds. There's no sampling, because every invariant is exhaustive.
11. Connection, local development and deployment
There's one Mongoose connection per process, created at boot before the HTTP server listens. Local development uses a single-node replica set in Docker, and tests use an in-memory replica set, because transactions require a replica set everywhere. Production is one Render free web service connecting to Atlas M0 in the nearest region.
Connection configuration (db/connection.js)
Option
Value
Why
URI
MONGODB_URI (mongodb+srv://…)
Atlas SRV
dbName
MONGODB_DB (fpl_rival, fpl_rival_dev, fpl_rival_test)
Explicit, never from URI default
maxPoolSize / minPoolSize
10 / 0
Well under the M0 connection cap
serverSelectionTimeoutMS
10000
Fail fast on boot
socketTimeoutMS
45000

retryWrites / retryReads
true / true
Safe with idempotent writes
w
'majority'
Durable writes outside transactions
appName
fpl-rival-dashboard
Visible in Atlas metrics
autoIndex / autoCreate
false / false
Indexes and validators come only from migrations
bufferCommands
false
Requests fail immediately if the DB is down, instead of hanging
mongoose.set('strictQuery', true), schema strict: 'throw'

Unknown fields are errors, not silently dropped
Default maxTimeMS on queries
5000
Via a query middleware
On SIGTERM, the process stops accepting requests, releases any held locks (their runs are marked ABANDONED) and calls mongoose.disconnect().
Migrations (db/migrations/): numbered JS files (001_collections_validators.js, 002_indexes.js, …), each with up(db). They run on boot under the migrate lease lock, and are recorded in _migrations with a checksum. createIndexes and collMod are idempotent, so re-running is safe. Render free has no pre-deploy hook, so boot-time migration is the mechanism, and it's short (~1 s).
Local development
# docker-compose.yml
services:
  mongo:
    image: mongo:8.0            # match the Atlas major; bump only when Atlas does
    command: ["--replSet", "rs0", "--bind_ip_all"]
    ports: ["27017:27017"]
    volumes: ["mongo-data:/data/db"]
    healthcheck:
      test: mongosh --quiet --eval "try { rs.status().ok } catch (e) { rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]}).ok }"
      interval: 5s
      retries: 10
volumes:
  mongo-data:
• .env.development: MONGODB_URI=mongodb://localhost:27017/?replicaSet=rs0&directConnection=true, MONGODB_DB=fpl_rival_dev.
• npm run dev starts the server (with migrations on boot) and Vite together.
• npm run db:seed loads the anonymized contract samples through the real sync path, using a fake FPL client that serves the committed samples. This gives a realistic local dataset without calling FPL.
• Alternative without Docker: a second free Atlas project. Only one M0 is allowed per project.
Tests: unit and contract tests need no database. Integration tests use mongodb-memory-server 11's MongoMemoryReplSet (1 node, storageEngine: 'wiredTiger'), started in a node:test before() hook, with migrations applied. The binary is pinned with MONGOMS_VERSION=8.0.x (matching Atlas and docker-compose) instead of the library default (8.2.x), so tests run against the same server minor line as production. The first run downloads a mongod binary (~100 MB, cached afterwards; CI caches ~/.cache/mongodb-binaries).
Render + Atlas production
flowchart LR
  U[Browser / phone] -->|HTTPS| R[Render free web service<br/>Node 22: Express + built client]
  P[cron-job.org] -->|POST /api/internal/tick| R
  R -->|TLS, SRV<br/>from region CIDRs| A[(Atlas M0<br/>MongoDB 8.x)]
  R -->|HTTPS| F[FPL API]
  G[GitHub Actions weekly] -->|temp access entry| A
  G -->|encrypted dump| B[Private artifact]
Concern
Setup
Region
Pair the regions, e.g. Render Frankfurt ↔ Atlas AWS eu-central-1 (Frankfurt). This keeps transaction round-trips short
Network access
The Atlas IP access list holds only the outbound CIDR ranges Render shows for this service (Service → Connect → Outbound). These ranges are fixed per region, but shared by all Render services in that region. Never add 0.0.0.0/0. Re-check the ranges if the service moves region
Residual risk
Other Render tenants in the same region share those egress ranges, so the network layer narrows exposure but doesn't isolate it. Authentication (a random 32+ char SCRAM password, a least-privilege user) and TLS remain the real boundary
Static IPs
Render dedicated outbound IPs are a paid (Pro+) feature. They're optional and not required for the MVP
Admin / CI access
No standing entries for laptops or CI. Use temporary Atlas access-list entries (Atlas UI "temporary" or atlas accessLists create --currentIp --deleteAfter <+1h>) created by the person or workflow that needs them
DB users
app: one custom role only, with no built-in readWrite. Atlas grants the union of a user's roles, so a database-wide readWrite would override the restriction. The role grants:
• find/insert/update/remove on every collection except resultSnapshots and gwResultActions, which get find + insert only.
• createCollection, createIndex, collMod, listCollections and listIndexes, for boot migrations.
Create the role in the Atlas UI or CLI (createRole from a client isn't allowed on M0), and allow ~30 s for changes to apply.
backup-ro: read on fpl_rival only. admin-ops: migrations and restores, kept only in a password manager.
Render env
MONGODB_URI, MONGODB_DB, JWT_SECRET, ADMIN_PASSWORD_HASH, TICK_SECRET, NODE_ENV=production
Build / start
npm ci && npm run build / npm start (migrations → connect → listen)
Health
GET /api/health → { db: ping ok, migrations: n, lockHeld: false }, used by Render
Cold start
Render free sleeps after ~15 min idle, so the first request takes ~30–60 s. The tick pinger every 10 min keeps it warm during GW windows
Backups
See Backups below
Monitoring
Atlas free metrics + alerts (connections, storage 60%) and Render logs (pino JSON)
Backups (M0 has no automated backups)
• Schedule: a GitHub Actions workflow (backup.yml) runs weekly on Monday at 06:00 UTC, after the weekend GW has normally been declared, and can also be triggered manually.
• Collections dumped: groups, managers, seasons, events, managerGameweeks, managerSeasons, resultSnapshots, gwResults, gwResultActions, syncRuns. That's everything needed to recover configuration, reconciled data, decisions and provenance.
• Excluded: fplRawResponses (large, and FPL can be re-queried; include it with a manual --include-raw run only when evidence recovery is needed), plus players, liveGameweeks, locks and _migrations, which are rebuilt by sync and boot.
• Steps:
    1. Create a temporary Atlas access entry for the runner IP (Atlas CLI, programmatic API key from secrets, --deleteAfter +1 h).
    2. mongodump --uri "$BACKUP_RO_URI" --db fpl_rival --collection <each> --gzip --archive=dump.gz, one run per collection. --oplog isn't available on M0, so the dump isn't point-in-time across collections.
    3. Delete the temporary access entry.
    4. Restore into a mongo:8.0 service container in the same job and run npm run db:check against it. This catches both backup corruption and inconsistencies from the non-point-in-time dump.
    5. Encrypt with age to a public key stored in the repo (the private key lives only in a password manager), then upload dump.gz.age as an artifact with 90-day retention.
• Privacy: the workflow runs in a private repository, artifacts are encrypted before upload, and no dump is ever committed. The artifact name carries the date and the db:check result.
12. Representative Mongoose schemas
These are the shapes of the key models, written as reference specification rather than final code. Every model uses strict: 'throw', autoIndex: false, autoCreate: false, versionKey: false and no timestamps plugin. Timestamps are explicit so that provenance stays meaningful. Each critical invariant is enforced twice: in Mongoose, and in a $jsonSchema collection validator installed by migration.
Mongoose 9 assumptions, verified against the migration guide and compatibility table
Mongoose 8 assumption in v0.3
Mongoose 9 status
Spec change
pre hooks use next()
Removed; next/done are no longer passed
All hooks are async functions that throw to reject (examples below)
Pipeline updates via updateOne / findOneAndUpdate
Throw by default
Lease lock calls pass { updatePipeline: true } per query (not globally); content-hash upserts use native Model.collection.bulkWrite
findOneAndUpdate(…, { new: true })
Deprecated (9.2+)
Use returnDocument: 'after'
MongoDB 8.x server support
Supported by ^9.0.0
None
Node.js runtime
Requires ≥ 20.19.0
Node 22 LTS stays
strict: 'throw', strictQuery, autoIndex, autoCreate, bufferCommands, immutable, session.withTransaction
Unchanged
None
Numbers accepted as ObjectIds
isValidObjectId(number) is now false
None; numeric IDs (entryId) are never ObjectIds here
Document.updateOne(cb) callbacks
Removed
Not used; repositories are promise-only
UUID getters
Now bson.UUID objects
Not used (IDs are ObjectId or strings)
The driver is taken from Mongoose's own dependency via mongoose.mongo, never installed separately, so the Mongoose and driver versions can't drift.
Shared pieces
// models/shared.js
const provenanceSchema = new Schema({
  lastConfirmedByRunId: { type: Schema.Types.ObjectId, required: true },
  lastConfirmedAt:      { type: Date, required: true },
  lastChangedByRunId:   { type: Schema.Types.ObjectId, required: true },
  lastChangedAt:        { type: Date, required: true },
  contentHash:          { type: String, required: true, match: /^sha256:[a-f0-9]{64}$/ },
  sourceRequests:       { type: Map, of: String, default: {} },   // role -> bodySha256
  settled:              { type: Boolean, default: false },
}, { _id: false });

const RECONCILED = ['RECONCILED', 'RECONCILED_NO_COST'];

// plugins/appendOnly.js — layer 2 of §7 (Mongoose 9: async hooks, throw to reject)
const BLOCKED = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne',
  'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'];

function appendOnly(schema) {
  for (const op of BLOCKED) {
    schema.pre(op, { document: true, query: true }, async function rejectMutation() {
      const model = this.model?.modelName ?? this.constructor.modelName;
      throw new ImmutableCollectionError(model, op);
    });
  }
  schema.pre('save', async function rejectResave() {
    if (!this.isNew) throw new ImmutableCollectionError(this.constructor.modelName, 'save');
  });
  schema.eachPath((path, type) => { if (path !== '_id') type.options.immutable = true; });
}

// plugins/deterministicId.js — shared by every natural-key collection
function deterministicId(schema, buildId) {
  schema.pre('validate', async function checkDeterministicId() {
    const expected = buildId(this);
    if (this._id == null) this._id = expected;
    if (this._id !== expected) throw new Error(`_id ${this._id} != ${expected}`);
  });
}
Group (members embedded)
const memberSchema = new Schema({
  entryId:       { type: Number, required: true, min: 1 },
  isExcluded:    { type: Boolean, default: false },
  joinedEvent:   { type: Number, min: 1, max: 38, default: null },
  leftLeague:    { type: Boolean, default: false },
  addedManually: { type: Boolean, default: false },
  addedAt:       { type: Date, required: true },
}, { _id: false });

const groupSchema = new Schema({
  name:          { type: String, required: true, trim: true, maxlength: 60 },
  slug:          { type: String, required: true },
  memberSource:  { type: String, enum: ['LEAGUE_STANDINGS', 'MANUAL'], required: true },
  fplLeagueId:   { type: Number, min: 1, default: null },
  myEntryId:     { type: Number, default: null },
  winnerRule:    { type: String, enum: ['NET_POINTS', 'GROSS_POINTS'], required: true },
  tieBreakRules: { type: [String], enum: TIE_BREAK_RULES, required: true },
  shareToken:    { type: String, default: null },
  isActive:      { type: Boolean, default: true },
  archivedAt:    { type: Date, default: null },
  members:       { type: [memberSchema], default: [] },
  createdAt:     { type: Date, required: true, immutable: true },
  updatedAt:     { type: Date, required: true },
}, { collection: 'groups', strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false });

groupSchema.path('fplLeagueId').validate(function (v) {
  return this.memberSource === 'MANUAL' || Number.isInteger(v);
}, 'fplLeagueId required for LEAGUE_STANDINGS');
groupSchema.path('members').validate(
  (ms) => new Set(ms.map((m) => m.entryId)).size === ms.length, 'duplicate member');
groupSchema.path('tieBreakRules').validate((r) => r.at(-1) === 'SHARED', 'SHARED must be last');
Season (teams, chip rules, semantics embedded)
const seasonSchema = new Schema({
  _id:   { type: String, match: /^\d{4}-\d{2}$/ },            // '2026-27'
  teams: [{ _id: false, id: Number, name: String, shortName: String }],
  chipRules: {
    source: { type: String, enum: ['FPL_BOOTSTRAP', 'CONFIG_FALLBACK'], required: true },
    rules: [{ _id: false, chipName: String, startEvent: Number, stopEvent: Number,
              number: Number, chipType: { type: String, default: null } }],
    provenance: provenanceSchema,
  },
  pointsSemantics: {
    value: { type: String, enum: ['GROSS_BEFORE_HITS', 'NET_AFTER_HITS', 'UNVERIFIED', 'CONFLICTED'],
             default: 'UNVERIFIED' },
    evidenceRows: { type: Number, default: 0 },
    conflictRows: { type: Number, default: 0 },
    firstVerifiedRunId: { type: Schema.Types.ObjectId, default: null },
  },
  unscheduledFixtures: [fixtureSchema],
  provenance: provenanceSchema,
}, { collection: 'seasons', strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false });
Event (fixtures embedded)
const fixtureSchema = new Schema({
  id: Number, teamH: Number, teamA: Number, teamHFdr: Number, teamAFdr: Number,
  kickoffTime: { type: Date, default: null },
  started: Boolean, finished: Boolean, finishedProvisional: Boolean,
  teamHScore: { type: Number, default: null }, teamAScore: { type: Number, default: null },
}, { _id: false });

const eventSchema = new Schema({
  _id:          String,                                   // '2026-27:5'
  season:       { type: String, required: true },
  gw:           { type: Number, required: true, min: 1, max: 38 },
  deadlineTime: { type: Date, required: true },
  isCurrent: Boolean, isNext: Boolean, finished: Boolean, dataChecked: Boolean,
  state: { type: String, required: true,
           enum: ['UPCOMING', 'LIVE', 'MATCHES_FINISHED', 'FPL_PROCESSING', 'DATA_CHECKED'] },
  dataCheckedObservedAt: { type: Date, default: null },
  fixtures:   { type: [fixtureSchema], default: [] },
  provenance: { type: provenanceSchema, required: true },
}, { collection: 'events', strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false });

eventSchema.plugin(deterministicId, (doc) => `${doc.season}:${doc.gw}`);
ManagerGameweek (normalized points + picks embedded)
const pickSchema = new Schema({
  elementId:     { type: Number, required: true, min: 1 },
  squadPosition: { type: Number, required: true, min: 1, max: 15 },
  fplMultiplier: { type: Number, required: true, min: 0, max: 3 },
  isCaptain:     { type: Boolean, required: true },
  isViceCaptain: { type: Boolean, required: true },
}, { _id: false });

// Pure, shared with the mapper and db:check so all three enforce identical rules
function pickViolations(picks) {
  const v = [];
  if (picks.length !== 15) v.push(`expected 15 picks, got ${picks.length}`);
  if (new Set(picks.map((p) => p.squadPosition)).size !== picks.length) v.push('duplicate squadPosition');
  if (new Set(picks.map((p) => p.elementId)).size !== picks.length) v.push('duplicate elementId');
  const captains = picks.filter((p) => p.isCaptain);
  const vices = picks.filter((p) => p.isViceCaptain);
  if (captains.length !== 1) v.push(`expected 1 captain, got ${captains.length}`);
  if (vices.length !== 1) v.push(`expected 1 vice-captain, got ${vices.length}`);
  if (captains.length === 1 && vices.length === 1 && captains[0].elementId === vices[0].elementId) {
    v.push('captain and vice-captain are the same player');
  }
  return v;
}

const pointsSchema = new Schema({
  reportedGwPoints:    { type: Number, required: true },
  transferCost:        { type: Number, required: true, min: 0 },
  netGwPoints:         { type: Number, default: null },
  grossGwPoints:       { type: Number, default: null },
  totalPoints:         { type: Number, required: true },
  previousTotalPoints: { type: Number, default: null },
  picksReportedPoints: { type: Number, default: null },
  pointsSemantics:     { type: String, required: true, enum: POINTS_SEMANTICS },
  reconciliationStatus:{ type: String, required: true, enum: RECONCILIATION_STATUSES },
  reconciliationDetail:{ delta: Number, hypothesis: String, picksPoints: Number },
}, { _id: false });

pointsSchema.pre('validate', async function checkReconciledNullability() {
  const ok = RECONCILED.includes(this.reconciliationStatus);
  const consistent = ok ? this.netGwPoints !== null && this.grossGwPoints !== null
                        : this.netGwPoints === null && this.grossGwPoints === null;
  if (!consistent) throw new Error('net/gross must be null unless reconciled');
});

const managerGameweekSchema = new Schema({
  _id:     String,                                        // '2026-27:123456:5'
  season:  { type: String, required: true },
  entryId: { type: Number, required: true },
  event:   { type: Number, required: true, min: 1, max: 38 },
  points:  { type: pointsSchema, required: true },
  eventTransfers: Number, pointsOnBench: Number,
  overallRank: { type: Number, default: null },
  bankTenths: Number, teamValueTenths: Number,
  activeChip: { type: String, default: null },
  hasPicks:   { type: Boolean, required: true },
  picks:      { type: [pickSchema], default: [] },
  autoSubs: [{ _id: false, elementIn: Number, elementOut: Number,
               source: { type: String, enum: ['FPL', 'SIMULATED'] } }],
  provenance: { type: provenanceSchema, required: true },
}, { collection: 'managerGameweeks', strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false });

managerGameweekSchema.plugin(deterministicId, (d) => `${d.season}:${d.entryId}:${d.event}`);

managerGameweekSchema.pre('validate', async function checkPicks() {
  if (!this.hasPicks) {
    if (this.picks.length !== 0) throw new Error('picks present but hasPicks=false');
    return;
  }
  const violations = pickViolations(this.picks);
  if (violations.length) throw new Error(`invalid picks: ${violations.join('; ')}`);
});
Pick validation layers: pickViolations() lives in models/validation/picks.js as a pure function, and runs in three places:
• The FPL mapper, which rejects the response and records SCHEMA_FAIL on that run.
• The Mongoose pre('validate') hook.
• db:check (§10).
$jsonSchema can only bound the array (minItems: 15, maxItems: 15 when hasPicks). It can't express uniqueness of a field across array elements, so the element-level rules deliberately live in shared code.
ResultSnapshot (immutable)
const resultSnapshotSchema = new Schema({
  groupId: { type: Schema.Types.ObjectId, required: true },
  season: { type: String, required: true }, event: { type: Number, required: true },
  kind: { type: String, enum: ['RULE_BASED', 'OVERRIDE'], required: true },
  winnerRule: { type: String, required: true }, tieBreakRules: { type: [String], required: true },
  computedWinnerEntryIds: { type: [Number], required: true },   // what the rules said
  declaredWinnerEntryIds: { type: [Number], required: true },   // = computed unless OVERRIDE
  winningScore: { type: Number, default: null },
  tieBreakApplied: { type: String, default: null },
  tieBreakTrace: { type: Schema.Types.Mixed, required: true },
  standings: { type: Schema.Types.Mixed, required: true },
  inputs: { type: Schema.Types.Mixed, required: true },
  inputsHash: { type: String, required: true },
  eventState: { type: String, required: true },
  engineVersion: { type: String, required: true },
  warnings: { type: [Schema.Types.Mixed], default: [] },
  sources: [{ _id: false, syncRunId: Schema.Types.ObjectId, startedAt: Date,
              status: String, requestHashes: [String] }],
  contentHash: { type: String, required: true },
  computedAt: { type: Date, required: true },
}, { collection: 'resultSnapshots', strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false });
resultSnapshotSchema.plugin(appendOnly);
GwResultAction (append-only, hash-chained)
const gwResultActionSchema = new Schema({
  groupId: { type: Schema.Types.ObjectId, required: true },
  season: { type: String, required: true }, event: { type: Number, required: true },
  seq: { type: Number, required: true, min: 1 },
  action: { type: String, enum: ['FINALIZE', 'OVERRIDE', 'RECOMPUTE'], required: true },
  prevStatus: { type: String, enum: ['PROVISIONAL', 'FINAL', 'OVERRIDDEN'], required: true },
  newStatus:  { type: String, enum: ['FINAL', 'OVERRIDDEN'], required: true },
  prevWinnerEntryIds: { type: [Number], required: true },
  newWinnerEntryIds:  { type: [Number], required: true },
  prevSnapshotId: { type: Schema.Types.ObjectId, default: null },
  newSnapshotId:  { type: Schema.Types.ObjectId, required: true },
  newSnapshotHash: { type: String, required: true },
  note: { type: String, default: null, maxlength: 280 },
  syncRunId: { type: Schema.Types.ObjectId, default: null },
  actor: { type: String, default: 'admin' },
  prevHash: { type: String, required: true },               // 'GENESIS' for seq 1
  hash: { type: String, required: true },
  createdAt: { type: Date, required: true },
}, { collection: 'gwResultActions', strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false });
gwResultActionSchema.path('note').validate(function (n) {
  return this.action !== 'OVERRIDE' || (typeof n === 'string' && n.trim().length >= 3);
}, 'override requires a note');
gwResultActionSchema.plugin(appendOnly);
GwResult (the mutable pointer), SyncRun, Lock, FplRawResponse
const gwResultSchema = new Schema({
  _id: String,                                  // `${groupId}:${season}:${event}`
  groupId: { type: Schema.Types.ObjectId, required: true },
  season: String, event: Number,
  status: { type: String, enum: ['FINAL', 'OVERRIDDEN'], required: true },
  currentSnapshotId: { type: Schema.Types.ObjectId, required: true },
  headSeq: { type: Number, required: true, min: 1 },
  headHash: { type: String, required: true },
  updatedAt: { type: Date, required: true },
}, { collection: 'gwResults', strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false });

const syncRunSchema = new Schema({
  job: { type: String, required: true }, target: String, season: String, event: Number,
  trigger: { type: String, enum: ['MANUAL', 'FINALIZE', 'SCHEDULER', 'SMOKE', 'STARTUP'], required: true },
  status: { type: String, enum: ['RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'ABANDONED'], required: true },
  lockId: String, lockFencingToken: Number,
  requests: [{ _id: false, path: String, httpStatus: Number, bodySha256: String, bytes: Number,
               durationMs: Number, schemaOk: Boolean, fromCache: Boolean,
               rawResponseId: { type: Schema.Types.ObjectId, default: null } }],
  failures: [{ _id: false, entryId: Number, code: String, message: String }],
  warnings: [{ _id: false, code: String, detail: Schema.Types.Mixed }],
  startedAt: { type: Date, required: true }, finishedAt: { type: Date, default: null },
  expireAt: { type: Date },                     // absent = retained permanently
}, { collection: 'syncRuns', strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false });

const lockSchema = new Schema({
  _id: String,                                  // 'sync:group:<id>'
  owner: { type: Schema.Types.ObjectId, default: null },
  fencingToken: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  acquiredAt: Date, heartbeatAt: Date, lastWriteAt: Date,
}, { collection: 'locks', strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false });

const fplRawResponseSchema = new Schema({
  syncRunId: { type: Schema.Types.ObjectId, default: null },
  path: { type: String, required: true }, httpStatus: Number, contentType: String,
  bodyGzip: { type: Buffer, required: true },
  bodySha256: { type: String, required: true }, bytesRaw: Number, bytesStored: Number,
  reason: { type: String, enum: ['FINAL_EVIDENCE', 'SCHEMA_FAIL', 'CHIP_RULES_INVALID', 'SMOKE'], required: true },
  retainedBySnapshotIds: { type: [Schema.Types.ObjectId], default: [] },
  expireAt: { type: Date },
  capturedAt: { type: Date, required: true },
}, { collection: 'fplRawResponses', strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false });
managers, players, managerSeasons and liveGameweeks follow the same pattern: deterministic _id plus a validate hook, a required provenance, and integer tenths for prices.
$jsonSchema validator example (migration 001, managerGameweeks)
await db.command({
  collMod: 'managerGameweeks',
  validationLevel: 'strict', validationAction: 'error',
  validator: { $jsonSchema: {
    bsonType: 'object',
    required: ['_id', 'season', 'entryId', 'event', 'points', 'hasPicks', 'picks', 'provenance'],
    properties: {
      event: { bsonType: 'int', minimum: 1, maximum: 38 },
      picks: { bsonType: 'array', maxItems: 15 },
      points: {
        bsonType: 'object',
        required: ['reportedGwPoints', 'transferCost', 'totalPoints', 'reconciliationStatus'],
        oneOf: [
          { properties: {
              reconciliationStatus: { enum: ['RECONCILED', 'RECONCILED_NO_COST'] },
              netGwPoints: { bsonType: 'int' }, grossGwPoints: { bsonType: 'int' } },
            required: ['netGwPoints', 'grossGwPoints'] },
          { properties: {
              reconciliationStatus: { enum: ['MISMATCH', 'SEMANTICS_CONFLICT', 'SOURCE_DISAGREEMENT', 'INCOMPLETE'] },
              netGwPoints: { bsonType: 'null' }, grossGwPoints: { bsonType: 'null' } } },
        ],
      },
    },
  } },
});
The same migration installs validators for groups (league ID required unless MANUAL), gwResultActions (note required for OVERRIDE) and events (state enum). It creates collections first with createCollection if they're missing.
Integer types: the Node driver serializes integral JS numbers within the int32 range as BSON int, and anything else as double. So the validators use bsonType: ['int', 'long'] for IDs and points, and the mappers reject non-integers before writing (Number.isInteger). A contract test round-trips one document of each validated collection through the real validators in the in-memory replica set.
13. Exact index list
There are 23 secondary indexes across 15 collections, created only by migration 002_indexes.js (autoIndex is off). Collections keyed by a deterministic _id rely on the built-in _id index for uniqueness, and add query indexes only where a real read path needs them.
// migration 002_indexes.js — exact definitions
groups.createIndexes([
  { key: { slug: 1 }, name: 'slug_unique', unique: true },
  { key: { fplLeagueId: 1 }, name: 'fplLeagueId_unique_when_set', unique: true,
    partialFilterExpression: { fplLeagueId: { $type: 'number' } } },
  { key: { shareToken: 1 }, name: 'shareToken_unique_when_set', unique: true,
    partialFilterExpression: { shareToken: { $type: 'string' } } },
  { key: { isActive: 1, name: 1 }, name: 'active_by_name' },
  { key: { 'members.entryId': 1 }, name: 'member_entry' },            // "which groups contain entry X"
]);

managers.createIndexes([]);                                            // _id = entryId only

seasons.createIndexes([]);                                             // _id only

events.createIndexes([
  { key: { season: 1, gw: 1 }, name: 'season_gw' },
  { key: { season: 1, isCurrent: 1 }, name: 'season_current' },
]);

players.createIndexes([
  { key: { season: 1, teamId: 1 }, name: 'season_team' },
]);

managerGameweeks.createIndexes([
  { key: { season: 1, event: 1, entryId: 1 }, name: 'season_event_entry' },   // load a GW for a group ($in entryIds)
  { key: { season: 1, entryId: 1, event: 1 }, name: 'season_entry_event' },   // a manager's season (trends, reconcile checks)
]);

managerSeasons.createIndexes([
  { key: { season: 1, entryId: 1 }, name: 'season_entry' },
]);

liveGameweeks.createIndexes([]);                                        // _id only

syncRuns.createIndexes([
  { key: { target: 1, startedAt: -1 }, name: 'target_recent' },
  { key: { status: 1, startedAt: -1 }, name: 'status_recent' },
  { key: { expireAt: 1 }, name: 'ttl_expireAt', expireAfterSeconds: 0 },
]);

fplRawResponses.createIndexes([
  { key: { syncRunId: 1 }, name: 'by_run' },
  { key: { bodySha256: 1 }, name: 'by_hash' },
  { key: { expireAt: 1 }, name: 'ttl_expireAt', expireAfterSeconds: 0 },
]);

resultSnapshots.createIndexes([
  { key: { groupId: 1, season: 1, event: 1, computedAt: -1 }, name: 'group_gw_recent' },
  { key: { inputsHash: 1 }, name: 'by_inputs_hash' },
]);

gwResults.createIndexes([
  { key: { groupId: 1, season: 1, event: -1 }, name: 'group_season_events' },  // season table, history lists
]);

gwResultActions.createIndexes([
  { key: { groupId: 1, season: 1, event: 1, seq: 1 }, name: 'linear_chain_unique', unique: true },
  { key: { groupId: 1, createdAt: -1 }, name: 'group_recent' },
]);

locks.createIndexes([
  { key: { expiresAt: 1 }, name: 'ttl_dead_leases', expireAfterSeconds: 86400 },
]);

_migrations.createIndexes([]);                                           // _id = migration name
Notes
• season_event_entry supports find({ season, event, entryId: { $in: memberIds } }), the hottest read (results, ownership). season_entry_event supports per-manager series. Both are small: ~700 documents per season.
• The fplLeagueId partial filter uses $type: 'number', not $exists. A field explicitly set to null must not collide.
• TTL indexes are single-field, as MongoDB requires. expireAfterSeconds: 0 with a per-document expireAt gives per-document retention. Documents without the field never expire.
• There's no index on picks.elementId: ownership is computed in memory from ≤ 50 squads. A multikey index would cost writes for no read benefit.
14. Revised folder structure
The server gains db/ (connection, unit of work, migrations), models/ and locks/, and loses prisma/. analytics/ is untouched, and repositories/ becomes the only Mongoose consumer.
fpl-rival-dashboard/
├── package.json                    # workspaces: server, client
├── docker-compose.yml              # mongo:7 single-node replica set
├── .github/workflows/
│   ├── ci.yml                      # npm test + integration (MongoMemoryReplSet)
│   └── backup.yml                  # weekly mongodump of audit collections + chain verify
├── server/
│   ├── config/chipRules.2026-27.json   # fallback only
│   ├── fpl-contract/2026-27/       # smoke samples + shapes (v0.2 §11)
│   ├── scripts/
│   │   ├── fplSmoke.js
│   │   ├── dbCheck.js              # npm run db:check — invariants I1–I8 (§10)
│   │   └── seedFromSamples.js
│   ├── src/
│   │   ├── app.js  server.js
│   │   ├── config/env.js
│   │   ├── db/
│   │   │   ├── connection.js       # mongoose.connect options (§11)
│   │   │   ├── unitOfWork.js       # withTransaction(fn) — the only tx opener
│   │   │   ├── ids.js              # deterministic _id builders/parsers
│   │   │   ├── canonical.js        # canonical JSON + sha256 helpers
│   │   │   └── migrations/
│   │   │       ├── index.js        # runner (lease lock 'migrate', _migrations)
│   │   │       ├── 001_collections_validators.js
│   │   │       └── 002_indexes.js
│   │   ├── models/                 # Mongoose schemas only, no logic beyond validation
│   │   │   ├── shared.js  plugins/appendOnly.js  plugins/deterministicId.js  validation/picks.js
│   │   │   ├── Group.js  Manager.js  Season.js  Event.js  Player.js
│   │   │   ├── ManagerGameweek.js  ManagerSeason.js  LiveGameweek.js
│   │   │   ├── SyncRun.js  FplRawResponse.js
│   │   │   ├── ResultSnapshot.js  GwResult.js  GwResultAction.js
│   │   │   └── Lock.js  Migration.js
│   │   ├── repositories/           # the only importers of models/; return plain objects
│   │   │   ├── mappers/            # toDomain / toDocument per aggregate
│   │   │   ├── groupRepo.js  managerRepo.js  seasonRepo.js  eventRepo.js  playerRepo.js
│   │   │   ├── managerGameweekRepo.js  managerSeasonRepo.js  liveRepo.js
│   │   │   ├── syncRunRepo.js  rawResponseRepo.js  resultRepo.js  ownershipRepo.js
│   │   │   └── lockRepo.js
│   │   ├── locks/leaseLock.js      # acquire / heartbeat / fence / release built on lockRepo
│   │   ├── audit/hashChain.js      # action hash, snapshot contentHash, chain verify (pure)
│   │   ├── fpl/                    # unchanged from v0.2
│   │   ├── sync/                   # syncService + jobs, now using leaseLock + unitOfWork
│   │   ├── analytics/              # UNCHANGED: pure functions, no db imports
│   │   ├── services/               # resultService (T4), snapshotService, ownershipService
│   │   ├── controllers/  routes/  middleware/  validators/  utils/
│   └── test/
│       ├── helpers/builders.js  helpers/memoryReplSet.js
│       ├── unit/                   # analytics, hashChain, ids, canonical, architecture.test.js
│       ├── contract/               # FPL samples vs zod; doc round-trip vs validators
│       └── integration/            # needs MongoMemoryReplSet
└── client/                         # unchanged from v0.1/v0.2
audit/hashChain.js and db/canonical.js are pure, so they're unit-tested without a database. Only resultRepo calls them at write time.
15. Revised implementation order
The order keeps v0.2's engine-first sequence, and puts the MongoDB-specific guarantees (transactions, lease lock, append-only, idempotent upserts) behind integration tests before any UI. The weekly declaration is still usable at M3.
Step
Work
Gate to move on
0
Scaffold, Node 22, env validation, docker-compose mongo:8.0 replica set, npm test wired
rs.status().ok locally; trivial test green
1
fplClient (cache, limiter, retries, breaker, request log hook)
Unit tests for retry/breaker
2
FPL smoke test against real leagues; commit anonymized samples + shapes
Exit 0, or documented decisions per failed assumption
3
Pure engine, test-first (v0.2 order): reconcile → eventState → eligibility → ranking → tieBreakers → winner → effectiveSquad → ownership → chips; plus hashChain, canonical, ids, architecture.test.js
All unit cases green; the boundary test proves analytics has no db imports
4
db/connection, unitOfWork, migrations 001–002 (validators + indexes), all models
Migrations idempotent (run twice → no diff); validator round-trip contract tests green
5
lockRepo + leaseLock
Integration: concurrent acquire → one wins; expired lease takeover; fence aborts a stale holder's transaction
6
Repositories + mappers; resultRepo with T4
Integration: finalize/override/recompute write the expected docs; mutation attempts on snapshots/actions throw; seq fork rejected; chain verifies; tampered doc detected
7
Sync service on T1–T3 with provenance + content hashes
Integration: replay test (second run changes nothing but confirmations); member failure → PARTIAL + BLOCKED; settled-row change → warning
8
Auth, groups (archive/unarchive, manual members, league access classification)
Archived group → 409 on writes, reads OK
9
Results API + client shell, Results page, History drawer with chain badge
M3: real finished GW finalized from a phone; trace path opens
10
Ownership / captaincy / differentials (picked vs effective)
Hand count matches for one GW in Group B
11
Chips page, Status page (runs, requests, storage gauge, semantics, smoke verdicts)
MVP complete
12
Deploy: Atlas M0 (region-paired), users, Render service, cron-job.org tick, GitHub backup workflow
Health green on Render; encrypted backup artifact produced with db:check clean; Atlas access list holds only Render CIDRs
Milestones: M1 = steps 0–2, M2 = 3–7, M3 = 8–9, M4 = 10–12.
Integration tests (re-targeted from v0.2 §16):
• finalize.test.js, override.test.js and recompute.test.js are unchanged in intent.
• appendOnly.test.js now asserts Mongoose middleware errors, the seq unique-index rejection and hash-chain tamper detection, instead of trigger errors.
• archive.test.js and traceability.test.js are unchanged in intent. Traceability now checks that sources[] covers every input document's lastConfirmedByRunId.
• New: lock.test.js, idempotency.test.js, validators.test.js and transactionRetry.test.js. The last one injects a TransientTransactionError once, and asserts a single net write.
16. Final architecture and consistency check
The final architecture has pure analytics at the centre, repositories as the only MongoDB boundary, four transaction boundaries fenced by a lease lock, and five-layer immutability for decisions. A line-by-line pass over v0.2 found 14 relational assumptions. All are replaced, and three needed small contract-adjacent clarifications (items 9, 11 and 13 below).
flowchart TD
  API[Routes / controllers] --> SVC[Services<br/>sync, results, ownership]
  SVC --> AN[Analytics<br/>pure, db-agnostic]
  SVC --> REPO[Repositories + mappers]
  SVC --> LOCK[Lease lock<br/>fencing token]
  REPO --> UOW[unitOfWork<br/>T1–T4 transactions]
  UOW --> ATLAS[(Atlas M0<br/>15 collections)]
  LOCK --> ATLAS
  SVC --> FPL[FPL client]
Collection list: groups, managers, seasons, events, players, managerGameweeks, managerSeasons, liveGameweeks, syncRuns, fplRawResponses, resultSnapshots, gwResults, gwResultActions, locks, _migrations.
Transaction and locking strategy in one line: acquire a group lease with $$NOW, then run each multi-document write in withTransaction (snapshot/majority), starting with a fence write on the lock document. Decisions additionally use an optimistic headSeq guard and a unique seq index.
Consistency check: v0.2 relational assumptions
#
Assumption found in v0.2
Resolution in v0.3
1
Joins to assemble results inputs (members ⋈ gameweeks ⋈ picks ⋈ runs)
Embedded picks; repository does 3 indexed lookups (group, managerGameweeks by $in, syncRuns by $in) and assembles in memory
2
FK group_members → managers
Managers upserted in the same T2 transaction as the members array; db:check scans for orphans
3
FK gw_results → result_snapshots
Snapshot inserted in the same T4 transaction that moves the pointer
4
ON DELETE RESTRICT
No delete code paths exist; only TTL deletes expiring provenance docs, and T4 removes expireAt from anything a snapshot references
5
Triggers for append-only
§7 five layers; tests assert each
6
BIGSERIAL action order
seq + unique index; ObjectId order never used for logic
7
CHECK (net null ⇔ not reconciled)
Mongoose sub-schema hook + $jsonSchema oneOf
8
Nullable unique fpl_league_id
Partial unique index on $type: 'number'
9
Advisory lock also protecting the finalize read → commit window
Finalize holds the group lease from sync through T4, and T4's first statement is the fence write, so inputs can't change between gate and commit
10
result_snapshot_sources join table
Embedded sources[] with request hashes
11
SyncStatus enum used by canFinalize
Enum gains ABANDONED; canFinalize already treats any non-SUCCESS status as stale, so its code and signature are unchanged
12
NUMERIC prices
Integer tenths in storage
13
Numeric bigint IDs in the API (runId, snapshotId)
Become 24-char hex strings; groupId too. API types change from number to string, and analytics never sees these IDs except as opaque strings in sources
14
One DDL migration applied before deploy
Idempotent boot-time JS migrations under the migrate lease
Prices are converted to £m (/10) only in the API response mappers. Analytics uses prices only for display pass-through, so no analytics code changes.
Requirements traceability (v0.2 → v0.3)
v0.2 requirement
Where it lives now
Point reconciliation + season semantics
Unchanged reconcileSeason; stored in managerGameweeks.points, seasons.pointsSemantics
Event state machine
Unchanged deriveEventState; events.state, dataCheckedObservedAt
Finalization gate
Unchanged canFinalize; freshness from provenance.lastConfirmedByRunId → syncRuns
Immutable snapshots / append-only audit
resultSnapshots, gwResultActions, §7
Source/run traceability
provenance, syncRuns.requests[], sources[], §8
Effective squad, picked vs effective ownership
Unchanged analytics; inputs from embedded picks/autoSubs + liveGameweeks
Chip rule provenance
seasons.chipRules.source + provenance; replaced atomically
Idempotent sync
Deterministic _id upserts, wholesale list replacement, content hashes, §6
Missing-member blocking
Stale lastConfirmedByRunId → NOT_SYNCED → BLOCKED
Archive instead of delete
isActive/archivedAt; no delete paths
Deterministic winner/tie-break
Unchanged computeGwResult, resolvePositions
Contract tests against real samples
Unchanged, plus validator round-trip tests
No remaining section of this document depends on joins, cascades, triggers, sequences or row-level constraints.
17. Implementation readiness
The spec is frozen for implementation as of Sep 23, 2026. What follows is the final list of assumptions, the dependency baseline, the deployment checklist, and the exact scope of Step 0.
17.1 Final implementation assumptions
#
Assumption
Status
If wrong
A1
Atlas M0 runs MongoDB 8.x as a 3-node replica set; transactions available
Given; confirm the version in the Atlas UI at cluster creation
Pin local/test to the Atlas version shown
A2
collMod, createIndexes, createCollection and TTL indexes work on M0
collMod and index commands aren't on Atlas's M0 unsupported list (source); confirm on the first boot migration
Run migrations with admin-ops from a laptop via a temporary access entry
A3
Custom roles work on M0, but only via the Atlas UI/CLI/API (createRole from a client isn't allowed)
Verified in Atlas docs (source)
Layers 1, 2, 4 and 5 of §7 still hold
A4
mongodump works on M0, except the admin DB and --oplog
Verified (source)
None; the dump isn't point-in-time, and db:check on restore covers that
A5
Render outbound ranges are fixed per region and shared by all services in it; dedicated IPs are Pro+
Verified (source)
Workspaces created before Jan 23, 2022 in Oregon have no fixed ranges: use a new workspace or another region
A6
Mongoose 9: async hooks only, update pipelines opt-in, returnDocument replaces new, Node ≥ 20.19
Verified (source)
n/a
A7
One Render instance (free tier); locks still required (finalize vs sync, two tabs, restarts overlapping)
Design choice
n/a
A8
Season key format 2026-27; FPL IDs are season-scoped
From v0.2
n/a
A9
All FPL API behaviour (points semantics, league access, picks visibility, multipliers) is unverified until the Step 2 smoke test
Open
v0.2 fallbacks (manual members, reconciliation blocking)
A10
~30 MB per season fits in 512 MB
Estimate
Storage gauge warns at 60%
17.2 Final dependency baseline
Major versions are fixed here. Exact versions are resolved once at Step 0, committed in package-lock.json, and only changed deliberately. Rows marked "verified" were checked against the upstream release notes for this document. The others are the current majors as far as I know, confirmed by npm view <pkg> version during Step 0.
Package / tool
Range
Where
Status
Node.js
22 LTS (>=22 <23)
runtime
Mongoose 9 needs ≥ 20.19 (verified)
MongoDB server
8.0.x
Atlas, mongo:8.0, tests
per spec
mongoose
^9.10.0
server
verified current (9.10.x)
MongoDB Node driver
via mongoose.mongo (no separate install)
server
follows Mongoose
mongodb-memory-server
^11 + MONGOMS_VERSION=8.0.x
server dev
verified (v11 defaults to 8.2.x, so pin)
express
^5
server
confirm at Step 0
zod
^4
server
confirm at Step 0
lru-cache
^11
server
confirm at Step 0
bottleneck
^2.19
server
confirm at Step 0
jsonwebtoken / bcryptjs / cookie-parser
^9 / ^3 / ^1.4
server
confirm at Step 0
helmet / express-rate-limit / pino + pino-http
current majors
server
resolve at Step 0
dotenv, nodemon
dropped
n/a
Node 22 --env-file and --watch replace them
node-cron
deferred to V1
server
resolve then
vite
^8
client
verified current (8.x)
react / react-dom
^19
client
confirm at Step 0
react-router
^7 (package react-router)
client
confirm at Step 0
@tanstack/react-query
^5
client
confirm at Step 0
tailwindcss + @tailwindcss/vite
^4
client
confirm at Step 0
@vitejs/plugin-react
the major matching Vite 8
client
resolve at Step 0
lucide-react, clsx, date-fns
current / ^2 / ^4
client
confirm at Step 0
recharts
current major
client (V1)
resolve then
MongoDB Database Tools, Atlas CLI, age
latest
CI
install in workflow
17.3 MongoDB + Render deployment checklist
Atlas
[ ] Create project fpl-rival and an M0 cluster in the region paired with the chosen Render region; record the MongoDB version shown (expect 8.x)
[ ] Create the custom role fplAppRole (see §11 DB users); create user app with only that role
[ ] Create user backup-ro with built-in read on fpl_rival; create admin-ops (atlasAdmin on the project is not needed; readWriteAnyDatabase is enough) and store it only in a password manager
[ ] Generate random 32+ character passwords; no password appears in any repo
[ ] Access list: empty for now (no 0.0.0.0/0, no standing personal IPs)
[ ] Create a programmatic API key (Project Owner is not needed; Project Network Access Manager is enough) for the backup workflow
[ ] Enable alerts: connections > 400, storage > 60%
Render
[ ] Create the web service from the private GitHub repo in the paired region; Node 22 via .node-version
[ ] Build npm ci && npm run build, start npm start, health check path /api/health
[ ] Env vars: MONGODB_URI (app user, SRV, retryWrites=true&w=majority), MONGODB_DB=fpl_rival, JWT_SECRET, ADMIN_PASSWORD_HASH, TICK_SECRET, NODE_ENV=production
[ ] Open Service → Connect → Outbound, copy every CIDR range, and add each to the Atlas access list with comment render-<region>
[ ] Redeploy; confirm /api/health shows db: ok and the expected migration count
[ ] Confirm the custom role blocks audit mutations: connect as app from a laptop through a temporary access entry, attempt an updateOne on gwResultActions, and expect "not authorized"
GitHub
[ ] The repo is private
[ ] Secrets: ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY, ATLAS_PROJECT_ID, BACKUP_RO_URI; the age recipient public key is committed at ops/backup.pub
[ ] ci.yml green on the default branch
[ ] Run backup.yml manually once: temporary access entry created and removed, dump restored, db:check clean, encrypted artifact uploaded
[ ] Test-decrypt the artifact locally with the private key and restore it into local mongo:8.0
External
[ ] cron-job.org job: POST https://<service>/api/internal/tick every 10 min with header X-Tick-Secret
[ ] Smoke test (Step 2) passed against both real leagues before creating groups in production
Go-live verification
[ ] Create Group A and Group B; run a sync; check the Status page request log and storage gauge
[ ] Finalize one finished GW, open the History drawer, confirm the chain badge is valid
[ ] Run npm run db:check against production through a temporary access entry: 0 errors
17.4 Step 0: exact implementation task
Goal: a runnable, tested monorepo skeleton with a local MongoDB 8.0 replica set. There are no models, no FPL code and no Atlas yet. Every later step starts from a green npm test and a healthy replica set.
Deliverables
Path
Content
package.json
npm workspaces server, client; engines.node: ">=22 <23"; scripts dev (server + client concurrently via npm run dev --workspaces --if-present in parallel), build, start, test, test:integration, db:up (docker compose up -d --wait), db:down, db:ping
.node-version, .gitignore, .editorconfig
22; ignore node_modules, .env* (except .env.example), dist, dumps
docker-compose.yml
The §11 mongo:8.0 single-node replica set with auto rs.initiate healthcheck
.env.example
PORT=4000, MONGODB_URI=mongodb://localhost:27017/?replicaSet=rs0&directConnection=true, MONGODB_DB=fpl_rival_dev, NODE_ENV=development, JWT_SECRET=change-me
server/package.json
"type": "module"; deps express, mongoose, zod only; scripts dev: node --watch --env-file=../.env src/server.js, test, test:integration, db:ping
server/src/config/env.js
zod schema for the env vars above; parses process.env once, exports a frozen object, and exits with a readable list of missing/invalid vars
server/src/app.js
Express 5 app, JSON body limit 100 kB, GET /api/health → { status: 'ok', version, env } (DB ping arrives in Step 4)
server/src/server.js
Load env, listen on PORT, graceful SIGTERM/SIGINT shutdown
server/src/analytics/index.js
Empty placeholder export, so the boundary test has a target
server/scripts/dbPing.js
Connects with mongoose.mongo.MongoClient; prints setName, isWritablePrimary and server version; exits non-zero unless setName === 'rs0' and version starts with 8.0.
server/test/unit/env.test.js
node:test: valid env parses; missing MONGODB_URI fails with its name in the message
server/test/unit/health.test.js
Starts the app on port 0 and asserts GET /api/health returns 200 and status: 'ok'
server/test/unit/architecture.test.js
Fails if any file under src/analytics/ imports mongoose, mongodb, ../db, ../models, ../repositories, or reads process.env
client/
Vite 8 + React 19 + Tailwind 4 scaffold: one page calling /api/health and showing the status; vite.config.js proxies /api → http://localhost:4000
.github/workflows/ci.yml
Node 22, npm ci, npm test, npm run build
Acceptance criteria
1. A fresh clone runs npm ci with no errors, and package-lock.json is committed.
2. npm run db:up reports the container healthy, and npm run db:ping prints rs0 and 8.0.x.
3. npm run dev serves the API on :4000 and the client on :5173, and the client page shows "ok" through the proxy.
4. npm test passes the 3 test files, and the architecture test fails if a mongoose import is added to src/analytics/. This is checked once by hand and not committed.
5. The CI workflow is green on the first push.
6. npm ls mongoose shows 9.x, and nothing depends on a separately installed mongodb package.
Out of scope for Step 0: Mongoose connection code, models, migrations, FPL client, auth, Atlas, Render.
Commit message: Set up project skeleton with local MongoDB 8 replica set, env validation and test runner
