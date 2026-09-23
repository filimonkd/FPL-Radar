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
