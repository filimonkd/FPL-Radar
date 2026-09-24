# FPL Radar

Monorepo for FPL Radar: an Express + Mongoose API (`server/`) and a React + Vite client (`client/`).

> Status: **Step 0 scaffold**: tooling, MongoDB and a health endpoint only. There is no FPL integration, sync, auth, analytics or dashboard yet.

## Prerequisites

- **Node.js 22** (>= 22.12). `.nvmrc` pins the major version, so `nvm use` works.
- **npm 10** (ships with Node 22)
- **Docker** with Docker Compose v2 (for local MongoDB 8.0)

## Layout

```
.
├── client/            React 19 + Vite 8
├── server/            Express 5 + Mongoose 9, tests in server/test (node:test)
├── docker-compose.yml MongoDB 8.0, single-node replica set "rs0"
└── .env.example       Copy to .env
```

## Local setup

```bash
nvm use                 # optional: switch to Node 22
cp .env.example .env    # never commit .env
npm install             # installs all workspaces
```

## Start MongoDB (Docker)

```bash
docker compose up -d mongo     # or: npm run db:up
docker compose ps              # wait for "healthy"
npm run db:status              # expects [ { name: 'localhost:27017', state: 'PRIMARY' } ]
```

- On first start, the container healthcheck runs `rs.initiate` for the single-node replica set `rs0`. The check is idempotent. The container reports healthy only once the node is the writable primary.
- Data persists in the named volumes `mongo-data` and `mongo-config`. `docker compose down -v` wipes it.
- The port is bound to `127.0.0.1` only. The local instance has no authentication and must not be exposed.

## Run

```bash
npm run dev          # API on :4000 (node --watch) + client on :5173 (Vite, proxies /api)
npm run dev:server   # API only
npm run dev:client   # client only
npm start            # API without watch
```

Health check:

```bash
curl -s localhost:4000/api/health
```

The response is `200 {"status":"ok",...}` when the process, the MongoDB connection (live ping) and the environment are all healthy. Otherwise it is `503 {"status":"degraded",...}`, and `checks` shows which check failed.

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
| `getEventLive(event)` | `/event/{event}/live/` |
| `getElementSummary(elementId)` | `/element-summary/{id}/` |
| `getEntry(entryId)` | `/entry/{id}/` |
| `getEntryHistory(entryId)` | `/entry/{id}/history/` |
| `getEntryPicks(entryId, event)` | `/entry/{id}/event/{event}/picks/` |
| `getClassicLeagueStandings(leagueId, { page? })` | `/leagues-classic/{id}/standings/?page_standings=N` |

Pipeline for each call: cache and single-flight, then retry, then circuit breaker, then rate limiter, then `fetch` with a timeout, then boundary validation. All settings can be overridden through `createFplClient(options)`.

| Concern | Default |
|---|---|
| Timeout | 10 s per attempt (covers headers and body) |
| Retry | 3 attempts, exponential backoff with full jitter (500 ms base, 8 s cap), honours `Retry-After` on 429. Retries only timeout, network, 429 and 5xx. |
| Rate limit | Token bucket, burst 5, 2 req/s, FIFO |
| Circuit breaker | Opens after 5 consecutive upstream failures (timeout/network/429/5xx), stays open 30 s, then allows a single half-open probe. 404 and validation errors do not count. |
| Cache | In-memory TTL + LRU (500 entries). TTLs: 60 s for live, 2 min for standings, 5–10 min for others. Failures are never cached. |
| Logging hook | `onEvent({ type })` with `request`, `response`, `retry`, `cache_hit`, `circuit_state`, `error`. Exceptions thrown by the hook are swallowed. |

Errors are `FplError` with a `kind` of `timeout`, `network`, `rate_limited`, `upstream_unavailable`, `not_found`, `http`, `invalid_response`, `validation` or `circuit_open`, plus `retryable`, `status`, `url` and `issues` (for validation errors).

Validation checks only the fields the app relies on. Unknown fields pass through, so additive upstream changes don't break the client.

**Unverified:** FPL publishes no API documentation. The endpoint paths and response shapes above come from community usage. They have not been checked against live responses from this repo's CI or dev environment. The rate-limit, retry and TTL defaults are app policy, not FPL guidance.

## Test

```bash
npm test             # runs node:test in every workspace that defines a test script
```

## Environment

| Variable      | Default       | Notes                                                     |
|---------------|---------------|-----------------------------------------------------------|
| `NODE_ENV`    | `development` | `development` \| `test` \| `production`                   |
| `PORT`        | `4000`        | API port                                                  |
| `MONGODB_URI` | required      | e.g. `mongodb://localhost:27017/fpl_radar?replicaSet=rs0` |

The server loads `.env` from the repo root via Node's `--env-file-if-exists`. If the environment is invalid, the server refuses to start.

## Never commit

Secrets, `.env` files, MongoDB credentials, database dumps or backups, or real FPL data. `.gitignore` covers the common paths.
