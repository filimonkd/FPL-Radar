# FPL Radar

Monorepo for FPL Radar: an Express + Mongoose API (`server/`) and a React + Vite client (`client/`).

> Status: **Steps 0–1** (architecture v0.3 §15): tooling, local MongoDB, a health endpoint and a persistence-free FPL client. There is no sync, auth, analytics or dashboard yet.

## Prerequisites

- **Node.js 22** (`>=22 <23`). `.node-version` pins the major version for nvm, fnm, Render and CI.
- **npm 10** (ships with Node 22)
- **Docker** with Docker Compose v2 (for local MongoDB 8.0)

## Layout

```
.
├── .github/workflows/ CI: npm ci, npm test, npm run build (Node from .node-version)
├── client/            React 19 + Vite 8 + Tailwind 4 (health page only)
├── server/            Express 5 + Mongoose 9 + zod 4
│   ├── scripts/       dbPing.js
│   ├── src/analytics/ pure layer (placeholder; no db imports allowed)
│   ├── src/fpl/       FPL client
│   └── test/          unit/ (npm test), integration/ (npm run test:integration)
├── docker-compose.yml MongoDB 8.0, single-node replica set "rs0"
└── .env.example       Copy to .env
```

## Local setup

```bash
nvm use 22              # optional: switch to Node 22
cp .env.example .env    # never commit .env
npm install             # installs all workspaces
```

## Start MongoDB (Docker)

```bash
npm run db:up        # docker compose up -d --wait: returns once the container is healthy
npm run db:ping      # prints setName, isWritablePrimary, version; exits 1 unless rs0 and 8.0.x
npm run db:down      # stop (data is kept)
```

- On first start, the container healthcheck runs `rs.initiate` for the single-node replica set `rs0`. The check is idempotent. The container reports healthy only once the node is the writable primary.
- Data persists in the named volumes `mongo-data` and `mongo-config`. `docker compose down -v` wipes it.
- The port is bound to `127.0.0.1` only. The local instance has no authentication and must not be exposed.

## Run

```bash
npm run dev          # API on :4000 (node --watch) + client on :5173 (Vite, proxies /api)
npm start            # API without watch
npm run build        # client production build
```

Health check:

```bash
curl -s localhost:4000/api/health
```

The response is `200 {"status":"ok","version","env",...}` when the process, the MongoDB connection (live ping) and the environment are all healthy. Otherwise it is `503 {"status":"degraded",...}`, and `checks` shows which check failed. The client page at http://localhost:5173 shows the same status through the Vite proxy.

## FPL client (`server/src/fpl`)

A persistence-free client for the public, unauthenticated FPL endpoints. Nothing calls it yet. It gets wired into sync in a later step.

```js
import { createFplClient } from './fpl/index.js';

const fpl = createFplClient({ onEvent: (e) => console.log(e) });
const bootstrap = await fpl.getBootstrapStatic();
```

| Method | Path |
|---|---|
| `getBootstrapStatic()` | `/bootstrap-static/` |
| `getFixtures({ event? })` | `/fixtures/`, `/fixtures/?event=N` |
| `getEventStatus()` | `/event-status/` |
| `getEventLive(event)` | `/event/{event}/live/` |
| `getEntry(entryId)` | `/entry/{id}/` |
| `getEntryHistory(entryId)` | `/entry/{id}/history/` |
| `getEntryPicks(entryId, event)` | `/entry/{id}/event/{event}/picks/` |
| `getEntryTransfers(entryId)` | `/entry/{id}/transfers/` |
| `getClassicLeagueStandings(leagueId, { page? })` | `/leagues-classic/{id}/standings/?page_standings=N` |

Pipeline for each call: cache and single-flight (lru-cache), then retry, then circuit breaker, then rate limiter (bottleneck), then `fetch` with a timeout, then boundary validation (zod). All settings can be overridden through `createFplClient(options)`.

| Concern | Default |
|---|---|
| Timeout | 10 s per attempt (covers headers and body) |
| Retry | 3 attempts, exponential backoff with full jitter (500 ms base, 8 s cap), honours `Retry-After` on 429. Retries only timeout, network, 429 and 5xx. |
| Rate limit | bottleneck reservoir as a token bucket: burst 5, then 2 req/s, FIFO |
| Circuit breaker | Opens after 5 consecutive upstream failures (timeout/network/429/5xx), stays open 30 s, then allows a single half-open probe. 404 and validation errors do not count. |
| Cache | lru-cache: in-memory TTL + LRU (500 entries), single-flight via `fetch`. TTLs: 60 s for live and event status, 2 min for standings, 5 min for others. Failures are never cached. |
| Logging hook | `onEvent({ type })` with `request`, `response`, `retry`, `cache_hit`, `circuit_state`, `error`. Exceptions thrown by the hook are swallowed. |

Errors are `FplError` with a `kind` of `timeout`, `network`, `rate_limited`, `upstream_unavailable`, `not_found`, `http`, `invalid_response`, `validation` or `circuit_open`, plus `retryable`, `status`, `url` and `issues` (for validation errors).

Validation uses zod 4 loose objects and checks only the fields the app relies on. Unknown fields pass through, so additive upstream changes don't break the client.

**Unverified:** FPL publishes no API documentation. The endpoint paths and response shapes above come from community usage. They have not been checked against live responses from this repo's CI or dev environment. The rate-limit, retry and TTL defaults are app policy, not FPL guidance.

## FPL smoke test (Step 2)

Checks every FPL assumption against real responses before the engine is built (architecture v0.2 §11, inherited by v0.3). Run it from a machine that can reach `fantasy.premierleague.com`:

```bash
npm run fpl:smoke -- --league <leagueA> --league <leagueB> --entry <hitTaker> [--entry <id> ...] [--gw <n>] [--update-baseline]
```

- Pass both private leagues, and at least one entry that has taken a transfer hit (`event_transfers_cost > 0`) this season, so the points semantics can be proven.
- `--league-members <n>` also checks up to `n` members of each league (history, picks, transfers). Use it when you don't know who has taken a hit; it also exercises auto-subs and chips. Expect about 4 requests per member, one second apart.
- `--gw` defaults to the latest gameweek with `data_checked = true`.
- Writes `server/fpl-contract/<season>/smoke-report.md` every time. The anonymized `*.sample.json` and `*.shape.json` files are written on the first recording, or with `--update-baseline`. Samples are only ever written from real 2xx JSON responses, and the run refuses to write them if any real name or ID survived anonymization. The report only uses aliases (`E1`, `L1`, ...).
- Exit codes: `0` all pass · `1` schema break · `2` an assumption failed or is unverified · `3` network or blocked. BLOCKED needs a concrete denial indicator: an egress proxy's `x-deny-reason` or "host not in allowlist", Cloudflare's `cf-mitigated` header, or a recognized challenge page. Any other 401/403/429 is reported as FPL's actual HTTP answer.
- `V3` (sum of engine effective multipliers × points = gross) is reported as `DEFERRED_TO_STEP_3` and doesn't affect the exit code. `P5` records the same identity using FPL's own multipliers.
- Private league standings needing a login are classified `AUTH_REQUIRED`, and the group must use manual entry IDs. The smoke test never logs in to FPL.
- The base URL comes from `--base-url`, else `FPL_API_BASE_URL`, else `https://fantasy.premierleague.com/api`.

**From GitHub Actions** (no local network needed): run the **FPL smoke test** workflow (`.github/workflows/fpl-smoke.yml`) from the Actions tab, and enter `league_a`, `league_b`, `hit_entry` and an optional `gameweek`.
- Inputs must be positive integers. They're masked in the job logs but visible in the run's trigger details, so keep the repository private.
- It runs `npm ci` and `npm run fpl:smoke` against the real API. It uses the `FPL_API_BASE_URL` repository variable if one is set, otherwise the public URL.
- It adds the report to the job summary and uploads `server/fpl-contract/` as the artifact `fpl-contract-<run id>`, kept for 14 days.
- The job's result matches the smoke exit code (0/1/2/3).
- It has read-only permissions and **never commits**. Review the artifact, then commit samples deliberately in a normal PR.

## Analytics engine (Step 3, `server/src/analytics`)

Pure functions with no I/O, database, clock or `process.env` access; `test/unit/architecture.test.js` enforces this. The contracts follow architecture v0.2 §14:

| Module | Exports |
|---|---|
| `reconcile.js` | `reconcileSeason`: gross/net proof per row, statuses `RECONCILED`, `RECONCILED_NO_COST`, `MISMATCH`, `SEMANTICS_CONFLICT`, `SOURCE_DISAGREEMENT`, `INCOMPLETE` |
| `eventState.js` | `deriveEventState`, `canFinalize` (returns every failing reason) |
| `eligibility.js` | `selectEligible` (`EXCLUDED` > `JOINED_LATER` > `NO_TEAM`; unsynced members stay eligible and block) |
| `ranking.js`, `tieBreakers.js` | `competitionRanks`, `resolvePositions`, `TIE_BREAKERS` (entryId only orders the table, never picks a winner) |
| `winner.js` | `computeGwResult`: `PROVISIONAL`/`BLOCKED`, winners, trace, rows, `inputsHash`, `ENGINE_VERSION` |
| `effectiveSquad.js` | `deriveEffectiveSquad`: auto-subs, bench boost, triple captain, captain/vice failure, FPL multiplier cross-check |
| `ownership.js` | `computeOwnership`: picked vs effective EO, denominators, missing managers |
| `chips.js` | `chipAvailability`, `validateChipRules` |

Pure helpers used by later steps: `src/db/ids.js` (deterministic `_id`s), `src/utils/canonical.js` (canonical JSON + SHA-256; re-exported from `src/db/canonical.js`) and `src/audit/hashChain.js` (append-only chain build/verify). `test/contract/engineOnSamples.test.js` runs the engine on the real 2026-27 samples.

## Database (Step 4, `server/src/db`, `server/src/models`)

- **Connection** (`db/connection.js`): the v0.3 §11 options. Pool of 10, majority writes, `autoIndex`/`autoCreate`/`bufferCommands` off, `strictQuery`, `strict: 'throw'` on every schema, and a default 5 s `maxTimeMS` on queries.
- **Transactions** (`db/unitOfWork.js`): `withTransaction(fn)` is the only transaction opener. It uses snapshot reads, majority writes and primary reads, and the driver retries transient errors, so writes inside must be idempotent.
- **Migrations** (`db/migrations/`):
  - `001_collections_validators` creates the 15 collections with strict `$jsonSchema` validators.
  - `002_indexes` creates exactly the 23 §13 indexes.
  - They run on server boot and via `npm run db:migrate`. Each is recorded in `_migrations` with a checksum (line endings normalized). Applied migrations are skipped, and one that changed after it was applied is refused.
- **Models** (`models/`): the 15 v0.3 §12 schemas.
  - Deterministic `_id`s come from `db/ids.js`.
  - `resultSnapshots` and `gwResultActions` are append-only.
  - Points semantics default to `UNVERIFIED`; `CONFLICTED` is preserved.
  - `tieBreakRules` only accepts rules the architecture documents, with the default `FEWER_TRANSFER_COST → HIGHER_SEASON_TOTAL → SHARED`.
- Repositories arrived in Step 6 and the sync in Step 7 (below).

## Lease locks (Step 5, `server/src/locks`, `server/src/repositories/lockRepo.js`)

- **Lock ids** come from `lockKeys`: `sync:group:<groupId>`, `sync:bootstrap` and `migrate`. Each lease has a unique owner (an ObjectId, used for identity only) and a fencing token.
- **acquire** (`tryAcquireLease` / `acquireLease({ waitMs })`, which throws `LockBusyError`, code `SYNC_IN_PROGRESS`):
  1. An atomic takeover of a free or expired lease, judged by the server clock `$$NOW`.
  2. Otherwise, an atomic create-if-missing upsert. A held lease makes it collide on `_id`.
  - **Deviation from v0.3 §5:** MongoDB rejects `$expr` in an upsert filter, so §5's single "upsert if free or expired" statement is split into these two atomic steps.
- **heartbeat** and **fence** only succeed for the current owner + token *and* an unexpired lease. An expired lease counts as lost even if nobody took it yet.
  - `fence(session)` must be the first write in a guarded transaction. It writes the lock document, so a concurrent takeover waits for the transaction instead of interleaving. A lost lease throws `LockLostError` (code `LOCK_LOST`), which aborts the transaction.
- **release** is owner-only and idempotent.
- **`withLease(id, fn)`** heartbeats every 30 s by default and always releases.
- **Fencing tokens** strictly increase per scope: `max(previous + 1, server epoch ms)`. They keep increasing even after the TTL index removes a long-dead lock document.
- **Migrations** run under the `migrate` lease (`db/migrations/locked.js`), on boot and via `npm run db:migrate`.

## Repositories (Step 6, `server/src/repositories`)

- **Only importers of `models/`.** Every read is `.lean()` + a `toDomain` mapper (`repositories/mappers/`). ObjectIds become hex strings, Dates stay Dates, and prices stay integer tenths. `provenance` is dropped unless a read passes `{ withProvenance: true }`.
- **Sessions.** Every method takes an optional `{ session }` last. The T1–T4 writes refuse to run outside a `db/unitOfWork` transaction, and no repository opens one itself.
- **Write surface** (v0.3 §10). There is no delete method anywhere; TTL on `expireAt` is the only deletion.

  | Repository | Writes |
  |---|---|
  | `groupRepo` | `create`, `updateConfig`, `setMembers` (T2), `archive`, `unarchive` |
  | `managerRepo` | `upsertProfiles` (T2/T3) |
  | `seasonRepo` | `replaceTeamsAndChipRules` (T1), `applySemanticsEvidence` |
  | `eventRepo` | `bulkUpsert` (T1) |
  | `playerRepo` | `bulkUpsert` (unordered, no transaction) |
  | `managerGameweekRepo` | `bulkUpsertSeasonRows` (T3) |
  | `managerSeasonRepo` | `upsert` (T3) |
  | `liveRepo` | `replace` |
  | `syncRunRepo` | `insert`, `pushRequest`, `finish`, `markAbandoned`, `unsetExpiry` (T4) |
  | `rawResponseRepo` | `insert`, `unsetEvidenceExpiry` (T4) |
  | `resultRepo` | `insertSnapshot`, `appendAction`, `movePointer` (T4) |
  | `ownershipRepo` | none |
  | `lockRepo` | `acquire`, `heartbeat`, `fence`, `release` |

- **Idempotent snapshot writes** (§6):
  - Each write is a deterministic `_id` upsert with a content-hash `$cond` pipeline, sent via the native `bulkWrite` after Mongoose validation.
  - A replay only restamps `lastConfirmedByRunId/At`.
  - `settled` is derived from the run's `startedAt` vs `dataCheckedObservedAt`. A settled row that changes is reported back so the run can record `SETTLED_ROW_CHANGED`.
- **Group members.** They are unique by `entryId`: duplicates are rejected, and `setMembers` is a read-modify-write inside the T2 transaction.
- **Results** (§7, §8):
  - `resultRepo` hashes snapshots and actions over their canonical domain form.
  - `appendAction` chains `seq`/`prevHash`; `movePointer` guards on `headSeq`. A lost race throws `ConcurrentDecisionError` (409 `CONCURRENT_DECISION`).
  - `verifyChain` walks the audit chain, and `loadTrace` follows gwResults → snapshot `sources[]` → syncRuns `requests[]` → fplRawResponses.
  - `loadResultInputs` / `ownershipRepo.loadSquads` assemble the analytics inputs. The T4 orchestration itself (a result service) is Step 9.

## Sync (Step 7, `server/src/sync`)

`createSyncService({ client })` provides `syncGroupGameweek({ groupId, season, event, trigger })` and `syncBootstrap({ season })`. It uses the FPL client, the repositories, `db/unitOfWork` and the lease lock, and never touches Mongoose directly.

- **Run lifecycle:**
  1. Take the lease. If it's held, throw `LockBusyError` (`SYNC_IN_PROGRESS`) and create no run.
  2. Mark runs left RUNNING under older fencing tokens as `ABANDONED`.
  3. Insert the `syncRuns` document as RUNNING, then run the stages below.
  4. Finish as `SUCCESS`, `PARTIAL` or `FAILED` (`ABANDONED` if another instance took the lease over).
- **Stages:**
  - **Bootstrap:** T1 (season + events, fenced on `sync:bootstrap`), then players.
  - **League members:** T2, fenced on the group lease. Members missing from the standings are marked `leftLeague` and never removed. `AUTH_REQUIRED` freezes the member list and makes the run PARTIAL.
  - **Per member:** fetched concurrently, then one fenced T3 that reconciles the whole season. Picks of other GWs are carried forward. A failed member keeps its previous confirmations, and the run becomes PARTIAL.
  - **Live** points, once the deadline has passed.
  - **Semantics evidence.**
- **Idempotency.** Every write is a content-hash upsert, so a replay only restamps confirmations.
  - `dataCheckedObservedAt` is the first observation, and is kept while DATA_CHECKED holds.
  - Semantics evidence comes only from hit rows whose points inputs are new to the database, so replays never double-count.
- **Provenance:**
  - Each FPL call is one `syncRuns.requests[]` entry (from the client's `withRequestLog` hook), holding the hash of the exact response bytes. Documents record those hashes in `provenance.sourceRequests`.
  - `FINALIZE` runs store the history, picks, transfers and live bodies as `FINAL_EVIDENCE`.
  - A validation failure stores the body as `SCHEMA_FAIL`.
  - Bootstrap bodies are never stored.
- **Failure codes:** `BLOCKED` (only with a concrete denial indicator), `AUTH_REQUIRED`, `NOT_FOUND`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `UPDATING`, `TIMEOUT`, `NETWORK`, `SCHEMA_FAIL`, `LOCK_LOST`, and others. Blocked and auth decisions reuse the Step 2 smoke classifiers.

## Test

```bash
npm test                 # unit + contract tests (server/test/unit, server/test/contract); no database or network needed
npm run test:integration # server/test/integration: migrations, models, validators, unique indexes, transactions, locks, repositories, T4 results, sync
```

Integration tests start a 1-node `MongoMemoryReplSet` (MongoDB 8.0.32, set in `server/package.json` → `config.mongodbMemoryServer`). The first run downloads about 100 MB. To use an existing replica set instead, for example the docker one, set `MONGODB_TEST_URI`:

```bash
MONGODB_TEST_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true' npm run test:integration
```

## Environment

| Variable      | Default       | Notes                                                     |
|---------------|---------------|-----------------------------------------------------------|
| `NODE_ENV`    | `development` | `development` \| `test` \| `production`                   |
| `PORT`        | `4000`        | API port                                                  |
| `MONGODB_URI` | required      | `mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true` (use `127.0.0.1`, not `localhost`: on Windows `localhost` resolves to IPv6 `::1`, where the container isn't published) |
| `MONGODB_DB`  | required      | `fpl_rival_dev` locally                                   |
| `JWT_SECRET`  | required      | any non-empty value locally                               |
| `FPL_API_BASE_URL` | `https://fantasy.premierleague.com/api` | http(s) URL; trailing slash trimmed |

The server loads `.env` from the repo root via Node's `--env-file` (`npm run dev`) or `--env-file-if-exists` (`npm start`, where the host provides the variables). `server/src/config/env.js` validates them with zod; if anything is missing or invalid, the server prints every problem and exits.

## Never commit

Secrets, `.env` files, MongoDB credentials, database dumps or backups, or real FPL data. `.gitignore` covers the common paths.
