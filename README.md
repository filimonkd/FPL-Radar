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
├── client/            React 19 + Vite 8 + Tailwind 4 + React Router 7 + TanStack Query 5 (Step 13 UI)
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
npm run dev          # API on :4000 (node --watch-path=./src) + client on :5173 (Vite, proxies /api)
npm start            # API without watch
npm run build        # client production build
npm run db:seed      # load the committed FPL samples into your local DB (add -- --finalize to decide the GW)
```

- **Watching:** the API restarts only when a file under `server/src` changes. Changes in `node_modules`, `.env`, or files touched by sync tools (OneDrive, Dropbox) or antivirus don't restart it. Restart `npm run dev` yourself after editing `.env`.
- **Signing in:** there's no default password. Run `npm run auth:hash`, put the printed hash in `.env` as `ADMIN_PASSWORD_HASH='…'`, restart, and sign in at http://localhost:5173/login with the password itself.
- **Sample data** (`npm run db:seed`):
  - It creates a "Sample league" group from the committed, anonymized contract samples (`server/fpl-contract/2026-27`) and syncs it through the real sync path with a sample-only FPL client. It never calls FPL, so the UI has data offline.
  - Only one team was fully sampled, so every member reuses that team's sampled data under its own anonymized name. They tie, and GW5 is a shared win.
  - Re-running is a replay.
  - It refuses `NODE_ENV=production`, and refuses `mongodb+srv://` targets unless you pass `--allow-remote`.

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

## Auth and groups (Step 8)

- **Identities** (v0.3 §11/§17: one admin, no user accounts):
  - **admin:** `POST /api/auth/login { password }` checks `ADMIN_PASSWORD_HASH` (bcrypt) and sets an HS256 JWT in an httpOnly, `SameSite=Strict` cookie (`Secure` in production). The same token is accepted as a `Bearer` header. Login is rate limited.
  - **viewer:** a group's share token, sent as the `X-Share-Token` header. It gives read-only access to that one group. Any other group returns 404, and any write returns 403.
  - **anonymous:** gets 401 on everything except `/api/health`.
- **Credentials.** FPL credentials are never accepted or stored. Generate the admin hash with `npm run auth:hash` (the password is read from stdin). In production `JWT_SECRET` must be at least 32 random characters and `ADMIN_PASSWORD_HASH` is required.
- **Group routes** (`/api/groups`). There are no DELETE routes; groups are archived instead.
  - Create, list, get, patch config, archive and unarchive.
  - Members: `POST …/members { entryIds }` adds manual members; `PATCH …/members/:entryId` sets exclusion or `joinedEvent`.
  - Share token: issue/rotate and revoke.
  - Sync: `POST …/sync { season, event }`.
  - `GET /api/leagues/:id/preview` reports `OK | AUTH_REQUIRED | EMPTY | NOT_FOUND`. An FPL outage or block is a 502 `FPL_UNAVAILABLE`, never an empty league.
  - `POST /api/entries/validate` checks entry IDs for manual mode.
- **Creating a group and adding members** both call FPL, so they run as logged sync runs under the group lease. The group, its members and their `managers` documents are written in one fenced T2 transaction.
  - A league without anonymous access is refused (422 `LEAGUE_NOT_ACCESSIBLE`); manual entry IDs are the fallback.
  - A league already used by any group, even an archived one, returns 409 `LEAGUE_ALREADY_CONFIGURED`.
  - Adding an entry that is already a member returns 409 `DUPLICATE_MEMBER`.
  - Archived groups are read-only (409 `GROUP_ARCHIVED`).
- **Shutdown.** On SIGTERM/SIGINT the server stops accepting requests. It marks each running sync run `ABANDONED` before releasing that run's lease, so no in-flight work can commit or finish as a success. Then it disconnects. Shutdown is idempotent, and new runs are refused with 503 `SHUTTING_DOWN`.

## Results and finalization (Step 9, `server/src/services/resultService.js`)

- **Reading a result:** `GET /api/groups/:id/gw/:gw/result?season=` returns the current FINAL or OVERRIDDEN snapshot. Before a decision, it computes a PROVISIONAL or BLOCKED preview from stored data instead. It never writes anything, and returns `finalizeGate: { allowed, reasons }` to the admin.
- **Finalizing:** `POST …/finalize { season }` runs a FINALIZE sync (which stores evidence bodies), then checks the gate, then runs T4. All of this happens under one group lease, and the gate and the writes read the same transaction snapshot.
  - **The gate** is the unchanged `canFinalize` plus two service rules:
    - Every eligible member must be confirmed by *this finalize run*. An older SUCCESS run does not count, so a member that failed in the finalize sync blocks it.
    - Reconciled hit rows (C > 0) need verified season semantics that match the row: a CONFLICTED season blocks with `SEMANTICS_CONFLICTED`, and an UNVERIFIED one with `SEMANTICS_UNVERIFIED`. Rows with C = 0 don't depend on semantics.
  - **A blocked finalize** returns 409 `FINALIZE_BLOCKED` with the reasons and the members involved, and writes no decision.
  - **Repeating a finalize** with identical inputs returns the existing result (200, `replayed: true`) without writing a second decision.
- **T4:** fence → read the current result → verify the decision chain → gate → `insertSnapshot` → `appendAction` → `movePointer` → retain the source runs and evidence bodies. It is one `db/unitOfWork` transaction, so any failure rolls it all back.
  - Two simultaneous finalizes give one decision and one 409 `SYNC_IN_PROGRESS`.
  - A stale lease holder fails the fence and commits nothing.
- **Override and recompute:**
  - `POST …/override { season, winners, note }` declares winners with a mandatory note.
  - `POST …/recompute { season, dryRun, note? }` re-runs the rules. A dry run returns the diff and writes nothing; a commit that changes the winners needs a note.
- **History, verification and provenance:**
  - `GET …/actions` lists the decision history; `GET …/actions/verify` checks the hash chain.
  - `GET /api/result-snapshots/:id` returns the immutable snapshot, including the engine inputs, standings, decision trace, warnings and sources.
  - `…/verify` re-runs the engine on the stored inputs and compares.
  - `…/trace` follows the snapshot to its runs, request log and raw bodies.
- **Access:** share-token viewers can read their own group's results, history and snapshots; every decision is admin-only.

## Ownership, captaincy and transfers (Step 10)

Everything here is computed when requested and never stored, and it only reads (v0.2 §7, §9). Group admins and that group's share-token viewers can read both endpoints.

- **`GET /api/groups/:id/gw/:gw/ownership?season=&view=picked|effective`**
  - **Multipliers:** each manager's effective squad comes from `deriveEffectiveSquad`, which covers base multipliers, bench boost, FPL auto-subs, and captain → vice → none, or pending while the captain's fixtures aren't finished.
  - **Ownership:** picked vs effective ownership and captaincy come from `computeOwnership`, for all members and for rivals (everyone except Me). That includes squad/XI/captain/triple-captain shares, picked and effective ownership, and Me's exposure against rivals.
  - **Denominators:** each response reports its denominators. Members without picks are listed in `missingEntryIds`; invalid 15-pick squads are listed in `invalidPicks` and never guessed.
  - **Default view:** picked before MATCHES_FINISHED, effective after. Rows are sorted by the chosen ownership measure, then by element ID.
  - **Reproducibility:** each response carries `inputsHash`, a hash of exactly the persisted inputs used, and `sources`, the sync runs that last confirmed those inputs.
- **`GET /api/groups/:id/gw/:gw/transfers?season=`** gives a factual summary:
  - each eligible manager's transfers in this GW, with their transfer count, hit cost and chip;
  - players brought in and sold, counted across managers;
  - totals.

  Managers without a synced transfer list are reported as missing, not counted as zero.

## Chips and status (Step 11)

Everything here only reads data (v0.2 §8, v0.3 §9, §15).

- **`GET /api/groups/:id/chips?season=&event=`** (admin or the group's viewer; `event` defaults to the current gameweek):
  - **Rules:** the season's validated chip rules (FPL bootstrap, or CONFIG_FALLBACK flagged), with display labels that fall back to the raw name.
  - **Availability:** per manager, from `chipAvailability`: used, allowed and available per window, whether the window is current, and UNMAPPED names.
  - **Gameweek chip state:** per manager, comparing FPL history with the stored gameweek squad:
    - `PLAYED`: history lists the chip.
    - `NONE`: neither source shows a chip.
    - `ACTIVE_UNCONFIRMED`: the squad shows a chip that history doesn't list yet.
    - `SOURCE_DISAGREEMENT`: the two sources name different chips.
    - `UNKNOWN`: not synced, or no gameweek row. Missing data is never read as "no chip".
  - **Applied effect:** the scoring effect `deriveEffectiveSquad` actually applies (bench boost, triple captain, or none for wildcard and free hit).
  - Results for a gameweek that isn't DATA_CHECKED are marked provisional.
  - Each response carries `inputsHash` and the source runs.
- **`GET /api/seasons/:season/events`** (signed in): gameweek states, first-observed DATA_CHECKED time, fixture progress, and the current gameweek's live state.
- **`GET /api/status?season=`** (admin): recent runs, the season's points semantics exactly as stored, the chip-rule source, the storage gauge (dbStats against the 512 MB quota, warning at 60%), and smoke verdicts parsed from `fpl-contract/<season>/smoke-report.md`. `GET /api/status/runs/:id` shows a run's full request log.

## Deployment and operations (Step 12)

Production is one Render free web service (Frankfurt) serving the API and the built client from the same origin, backed by Atlas M0 (MongoDB 8.0). `render.yaml` is the Blueprint; **`docs/DEPLOYMENT.md`** is the staged runbook:

1. Validate the config.
2. Set up Atlas (custom role, users, access list of Render's outbound CIDRs only; never `0.0.0.0/0`).
3. Deploy on Render.
4. Verify the database and migrations through `/api/health`.
5. Verify end to end with `npm run smoke:deploy`.
6. Set up backups.
7. Rollback and restart.

- **Build / start:** `npm ci --include=dev && npm run build`, then `npm start`. On start the server validates env, connects, runs the boot migrations under the `migrate` lease, then listens.
- **`GET /api/health`:** 200 only when the DB answers, every migration is applied, env is valid and the process isn't shutting down. Otherwise 503 `degraded`; it recovers automatically.
- **`POST /api/internal/tick`:** the keep-warm pinger, checked against the `X-Tick-Secret` header with a constant-time compare. It returns 204 and starts nothing.
- **`npm run db:check`:** the read-only I1–I8 invariant scan (`ARCHITECTURE.md` §10). It prints a JSON report and exits 1 on any ERROR.
- **`npm run smoke:deploy -- <url> [season]`:** read-only checks against a running instance. `TICK_SECRET` and `SMOKE_ADMIN_PASSWORD` in the environment enable the tick and login checks.
- **`npm run check:bundle`:** fails if `client/dist` contains server env names, connection strings, hashes, JWTs, keys or direct FPL URLs. CI runs it after the build.
- **`.github/workflows/backup.yml`:** weekly on Monday at 06:00 UTC, plus manual runs. It needs repository secrets and `ops/backup.pub`; see the runbook §5.

## Client UI (Step 13, `client/src`)

The browser app for the APIs above, served by Express from the same origin in production (Vite proxies `/api` in development). It is mobile-first, since results are meant to be finalized from a phone. There are no new API features: every screen reads or calls an existing endpoint through `client/src/lib/api.js`.

- **Sign-in** (`/login`): the admin password only, never an FPL login. The session is the server's HttpOnly cookie, which scripts can't read.
- **Viewers** (`/share#<token>`): the share token stays in the URL fragment, so it never reaches the server or its logs. It is kept in `localStorage`, sent as `X-Share-Token`, and removed from the address bar. Viewers get read-only Results, Ownership and Chips for their group only.
- **Groups** (`/`): active groups, plus a collapsed Archived section with Unarchive.
- **New group** (`/groups/new`):
  - from a classic league, with a Preview that shows the server's access classification (OK / AUTH_REQUIRED / EMPTY / NOT_FOUND) and points AUTH_REQUIRED leagues to manual mode;
  - or from manual entry IDs, checked against FPL;
  - winner rule, "me", and the tie-break chain (documented rules only; SHARED is always last).
- **Results** (`/groups/:id/results?season=&gw=`):
  - status, event state, and the winners, with a "shared" badge for shared wins;
  - standings with "=" ranks, a tap-to-explain tie-break icon and reconciliation badges;
  - warnings and blocked-by rows;
  - the finalize gate's reasons in plain words;
  - admin actions: sync, finalize, override (winners + a 3–280 character note), and recompute (preview diff, then commit; a note is required if the winners change);
  - a **History drawer**, newest first, with the **chain badge** from `/actions/verify`, notes, and snapshot and run links;
  - **Copy announcement**, and the **trace path** (`/snapshots/:id`): content-hash and reproduction checks, source runs, request hashes and retained evidence.
- **Ownership:**
  - picked/effective toggle, and rivals/everyone when "me" is set;
  - denominators and managers not counted are always shown;
  - captaincy (picked vs effective) and transfers.
- **Chips:** the rule-source badge, this GW's chip state per manager (never "no chip" from missing data), and availability per window.
- **Settings** (admin):
  - name, winner rule, "me" and tie-breaks;
  - exclude/include members (members are never removed) and add entry IDs;
  - switch a league group to manual members;
  - create, rotate or revoke the share link;
  - archive or unarchive.
- **Status** (admin): points semantics exactly as stored, chip-rule source, the storage gauge, recent runs with each run's request log, and smoke verdicts.

Season and gameweek live in the URL. The default season comes from the date (seasons start in July/August) and the default gameweek is FPL's current one.

## Rivals, strategy and commissioner tools (Step 16)

**`GET /api/groups/:id/gw/:gw/rivals?season=`** (admin or the group's viewer) is computed on read from synced data by the pure `server/src/analytics/rivals.js`. Nothing is stored and finalized results are untouched. The rules below are also returned in the response (`rules`).

- **GW score:** the one the group's winner rule uses (net or gross after reconciliation). An unreconciled row is `null` and is skipped, never guessed; H3 stays unresolved.
- **Overall standings:** FPL's reported season total.
- **Unknown values:** returned as `null` and shown as "–", never 0.

| Feature | Where | Rule |
|---|---|---|
| Leaderboard + podium | Results tab, **Boards** page (every group side by side) | Rank by FPL season total ("=" ties); podium = ranks 1–3; GW winner from the result (or the top GW score while not final) |
| WhatsApp summary | Results tab, Boards | Emoji text from API facts only: winner(s), top 3, biggest hit, most-captained player, top bandwagon buy, form leader. Copy it or open WhatsApp prefilled; big ties shortened |
| Point differentials | Rivals tab | This GW and overall, from your side ("+5" = you're ahead) |
| Squad overlap | Rivals tab | Shared starters between your latest XI and theirs, "x/11"; their differentials listed |
| Financial intel | Rivals tab | Bank and squad value from their GW row |
| Captaincy spy | Rivals tab | Captain in their latest known squad (Triple Captain flagged) |
| Closest rivals | Rivals tab | The managers directly above and below you overall, with the gap |
| Form | Rivals tab | Average of the last 3 scored GWs |
| Hit tracker | Rivals tab | Transfer-hit points this season |
| Chip inventory | Rivals tab | Chips still available in the current window (from the chip rules; unknown if rules aren't synced) |
| Head to head | Rivals tab | Your weekly wins, losses and draws against them, over GWs where both scores are known |
| Threat level | Rivals tab | 🔥 HIGH / ⚠️ MEDIUM / 🧊 LOW, with the reasons shown. See the rule below the table |
| Bandwagon | Strategy tab | Players bought this GW by group members, how many own them, and whether you do |
| Expected points | Strategy tab | FPL `ep_next` summed over each latest known XI, captain counted twice; players without an estimate are reported, not zeroed |
| Fixture difficulty | Strategy tab | Mean FPL difficulty (1–5) of the XI's fixtures in the next 3 GWs; lower is easier |

**Threat level rule:**

1. Form: +2 if their 3-GW average beats the baseline by 5 or more; +1 if it beats it by less.
2. Chips: +1 for Triple Captain left, +1 for Bench Boost left, +1 if Free Hit or Wildcard is left.
3. A total of 3 or more is HIGH, 2 is MEDIUM, otherwise LOW.

The baseline is your form, or the group average if "me" isn't set.

"Me" (group Settings) turns on the differentials, overlap, head-to-head and closest-rival views. Players are identified by FPL's own data: `ep_next` is stored on players (`epNextTenths`) from each bootstrap sync.

## Player data (Step 17)

Groundwork for the news tracker, differential finder, transfer simulator and wildcard planner. No page uses it yet, and nothing existing changes.

- **More player data.** Each bootstrap sync now also stores FPL's status, news and its timestamp, chance of playing, global ownership %, form, points per game, season points and minutes, price changes (this GW and since the start) and this GW's transfers in and out.
- **Per-GW history.** Group syncs (manual or scheduled, never FINALIZE runs) fill in points and minutes for every finished, data-checked GW before the current one that isn't stored yet, one `/event/{gw}/live/` request per GW. After the first run it makes no requests. A failed request is a warning (`HISTORY_BACKFILL_INCOMPLETE`) and the rest is retried next time; results never depend on it.
- **Shared stats** (`server/src/analytics/playerStats.js`, pure):
  - points and minutes over the last 3, 5 and 10 GWs;
  - rotation risk: under 60 minutes in 2 of the last 3 games, blank GWs skipped, unknown with fewer than 3 games;
  - the team's next 3 GWs with FDR, doubles and blanks;
  - FPL selling price (you keep half of any rise, rounded down).
- **API.** `GET /api/seasons/:season/players?event=` (admin or any group viewer, read-only) returns every player with those fields. `event` defaults to the current GW. Form windows only count finished GWs, so a GW in progress never looks like a bad week.

## Injury & news (Step 18)

- **News tab.** FPL news and flags for every player owned by anyone in the group, newest FPL news first. Owners are each member's latest synced squad (all 15) up to the chosen GW, shown as avatars. Filter by all, mine or rivals.
- **Flags** (`server/src/analytics/news.js`, pure):
  - 🔴 injured, suspended or unavailable (FPL status `i`, `s`, `u`, `n`);
  - 🚨 doubt, with FPL's chance of playing;
  - 🔄 rotation risk (Step 17 rule);
  - 📉 price already dropped this GW;
  - 📈 price pressure: 50,000 or more net transfers in this GW. A signal, not a prediction.
- **Your squad strip.** Results shows your own players who are out, doubtful, at rotation risk or dropped in price. It needs "me" set in Settings, and stays hidden when there's nothing to report.
- **Freshness.** When the admin opens News, the app asks the server to re-read FPL's player data (`POST /api/seasons/:season/players/refresh`). The server reads bootstrap and fixtures at most once every 5 minutes. If FPL is down, the stored news is shown with a notice. Viewers never trigger FPL requests; they see the data as of the time shown.
- **API.** `GET /api/groups/:groupId/gw/:gw/news?season=` (admin or group viewer, read-only).

## Differential & value finder (Step 19)

- **Finder tab.** Every FPL player, filtered and sorted against your group (`server/src/analytics/finder.js`, pure).
- **Filters:** position; max price; max world ownership (FPL's selected-by %); max owners in the group (latest synced squads); fit only, which hides players whose FPL status isn't "available". A player missing the data a filter needs never passes that filter.
- **Sorts:** season points per £1m, FPL form, next-GW expected points (`ep_next`), or easiest next 3 GWs (average FDR, ascending). Missing values sort last; ties go to better value, then player id.
- **Rows** show "12% world · 0/10 FFM300", the next 3 fixtures coloured by difficulty, blanks, and an "Easy run" badge when the average FDR is under 3.0.
- **Filters live in the URL**, so a search can be bookmarked or shared.
- **API.** `GET /api/groups/:groupId/gw/:gw/finder?season=&position=&maxPrice=&maxOwnership=&maxGroupOwners=&fit=&sort=&limit=` (admin or group viewer, read-only). `maxPrice` is in £m and `maxOwnership` in %. `limit` defaults to 50 (max 200), and `total` counts every match.

## Transfer simulator (Step 20)

- **Transfers tab.** Needs "me" set in Settings and a synced squad. It always works from FPL's current GW: your latest synced squad and FPL's next-GW numbers, whatever GW the page shows. Transfers you've already made for next GW aren't visible without FPL login, so the squad is the last synced one.
- **Sell** one of your 15, shown with an estimated selling price. Your latest transfer in sets the purchase price, or the season start price if you've owned him since the start (`now_cost − cost_change_start`). You keep half of any rise, rounded down, and any fall is passed on in full.
- **Buy** a player of the same position, searchable by name or club and sorted by FPL expected points. A player who would be your 4th from one club is marked.
- **Result:**
  - ≈ bank after the transfer, sell and buy prices, and warnings for the 3-per-club limit or running out of money;
  - both players' points and minutes over the last 3/5/10 GWs, next-GW expected points and next-3 fixtures;
  - a projection table and a verdict.
- **Estimate rule** (`server/src/analytics/transfer.js`, pure):
  - GW+1 is FPL's `ep_next`.
  - GW+2 to GW+5 are estimates: a per-game base times a difficulty factor for each fixture (1.2, 1.1, 1.0, 0.9, 0.8 for FDR 1–5). The base is `ep_next` divided by his team's GW+1 games, or FPL form when his team blanks in GW+1.
  - Blank GWs count 0 and doubles count both games.
- **Verdict:** a −4 hit pays off at the first GW where the cumulative gain reaches 4; a free transfer, at the first GW where it is above 0. Otherwise it "doesn't beat −4 over 5 GWs", or it's "not enough data" when an estimate is missing. Every estimated number is labelled.
- **Choices live in the URL** (`?out=&in=&hit=`).
- **API** (admin or group viewer, read-only): `GET /api/groups/:groupId/transfer-plan?season=` and `GET /api/groups/:groupId/transfer-sim?season=&out=&in=&hit=`. Errors: 422 `ME_NOT_SET`, `NO_SQUAD`, `NO_CURRENT_GW`, `NOT_IN_SQUAD`.

## Wildcard / Free Hit planner (Step 21)

- **Planner tab.** Build a 15-player squad for next GW, starting from your latest synced squad or from a blank slate. The budget is your squad's estimated selling value plus the bank, or £100.0m without "me"; you can edit it.
- **FPL's rules checked live** (`client/src/lib/planner.js`, pure, unit-tested):
  - The squad must be 2 GKP / 5 DEF / 5 MID / 3 FWD, with at most 3 per club, within the budget.
  - The starting XI must be 11 players: 1 GKP, at least 3 DEF, 2 MID and 1 FWD.
  - Adding a player to a full position or a 4th from one club is blocked, with the reason shown. Going over budget is allowed but flagged, as in FPL's own picker.
- **Live totals:**
  - money left;
  - XI expected points (FPL `ep_next`, captain = highest xP, counted twice);
  - average difficulty of the XI's next-3 fixtures;
  - starters with a double or a blank next GW.
- **Best XI** picks the formation minimums by expected points, then the best of the rest.
- **Drafts are saved in this browser only** (`localStorage`, per group and season), with several drafts, Wildcard or Free Hit mode, and delete. No server changes: nothing is stored or deleted server-side.

## Test

```bash
npm test                 # unit + contract tests (server/test/unit, server/test/contract); no database or network needed
npm run test:integration # server/test/integration: migrations, models, validators, unique indexes, transactions, locks, repositories, T4 results, sync, API auth/groups, shutdown, db:check, production process (boot, SIGTERM, restart)
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
| `JWT_SECRET`  | required      | any non-empty value locally; 32+ random chars in production|
| `ADMIN_PASSWORD_HASH` | unset (login disabled) | bcrypt hash from `npm run auth:hash`; required in production |
| `TICK_SECRET` | unset (tick route absent) | 32+ random chars; required in production (`X-Tick-Secret` for `POST /api/internal/tick`) |
| `FPL_API_BASE_URL` | `https://fantasy.premierleague.com/api` | http(s) URL; trailing slash trimmed |

The server loads `.env` from the repo root via Node's `--env-file` (`npm run dev`) or `--env-file-if-exists` (`npm start`, where the host provides the variables). `server/src/config/env.js` validates them with zod; if anything is missing or invalid, the server prints every problem and exits.

## Never commit

Secrets, `.env` files, MongoDB credentials, database dumps or backups, or real FPL data. `.gitignore` covers the common paths.
