// npm run db:seed [-- --finalize] [--allow-remote]
// Loads the committed, anonymized FPL contract samples into the configured
// database through the real sync path (architecture v0.3 §11), so the app has
// a realistic local dataset without calling FPL. Idempotent: re-running
// re-syncs the same group (a replay changes nothing but confirmations).
//
//   --finalize      also finalize the sampled gameweek (as the admin would)
//   --allow-remote  allow a mongodb+srv:// (Atlas) target; refused by default
//
// Never runs with NODE_ENV=production.
import mongoose from 'mongoose';
import { envSchema } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connection.js';
import { runMigrationsLocked } from '../src/db/migrations/locked.js';
import { createSyncService } from '../src/sync/index.js';
import { createGroupService } from '../src/services/groupService.js';
import { createResultService } from '../src/services/resultService.js';
import { groupRepo } from '../src/repositories/index.js';
import { loadSamples, sampleFplClient } from '../src/ops/sampleFpl.js';
import { redact } from '../src/utils/redact.js';

const args = new Set(process.argv.slice(2));
const fail = (msg) => { console.error(msg); process.exit(1); };

if (process.env.NODE_ENV === 'production') fail('db:seed refuses to run with NODE_ENV=production.');
const uri = envSchema.shape.MONGODB_URI.safeParse(process.env.MONGODB_URI);
const db = envSchema.shape.MONGODB_DB.safeParse(process.env.MONGODB_DB);
if (!uri.success || !db.success) fail('db:seed needs MONGODB_URI and MONGODB_DB (see .env.example).');
if (uri.data.startsWith('mongodb+srv://') && !args.has('--allow-remote')) {
  fail('MONGODB_URI points at a remote (mongodb+srv) cluster; db:seed is for local databases. Pass --allow-remote to override.');
}

const SLUG = 'sample-league';
const samples = loadSamples();
const leagueId = samples.standings.league.id;
const current = samples.bootstrap.events.find((e) => e.is_current);
const season = (() => {
  const y = new Date(samples.bootstrap.events[0].deadline_time).getUTCFullYear();
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
})();

let code = 0;
const client = sampleFplClient(samples);
try {
  await connectDb(uri.data, db.data);
  const m = await runMigrationsLocked(mongoose.connection.db, { log: () => {} });
  console.log(`Connected to ${db.data}; migrations: ${m.applied.length} applied, ${m.skipped.length} already applied.`);

  const sync = createSyncService({ client });
  const groups = createGroupService({ sync });
  const results = createResultService({ sync });

  let group = await groupRepo.getBySlug(SLUG);
  if (group) {
    console.log(`Group "${group.name}" already seeded (${group.id}); re-syncing.`);
  } else {
    group = await groups.create({
      name: 'Sample league', slug: SLUG, memberSource: 'LEAGUE_STANDINGS', fplLeagueId: leagueId, winnerRule: 'NET_POINTS',
      myEntryId: samples.entry.id,
    });
    console.log(`Created group "${group.name}" (${group.id}) from sample league ${leagueId} with ${group.members.length} members.`);
  }

  const run = await sync.syncGroupGameweek({ groupId: group.id, season, event: current.id, trigger: 'MANUAL' });
  console.log(`Synced ${season} GW${current.id}: ${run.status}${run.failures.length ? ` (${run.failures.length} failures)` : ''}.`);

  if (args.has('--finalize')) {
    try {
      const r = await results.finalize(group.id, season, current.id);
      console.log(`Finalized GW${current.id}: ${r.snapshot?.kind ?? ''} winners ${JSON.stringify(r.snapshot?.declaredWinnerEntryIds ?? r.winners ?? [])}${r.replayed ? ' (already final)' : ''}.`);
    } catch (err) {
      if (err.code !== 'FINALIZE_BLOCKED') throw err;
      console.log(`Finalize blocked: ${(err.details?.reasons ?? []).join(', ')}.`);
    }
  }
  console.log(`\nOpen http://localhost:5173/groups/${group.id}/results?season=${season}&gw=${current.id}`);
  console.log('Note: only one team was fully sampled; the other members reuse its sampled data under their own anonymized names.');
} catch (err) {
  code = 1;
  console.error(`db:seed failed: ${redact(err.message)}`);
} finally {
  client.close();
  await disconnectDb().catch(() => {});
}
process.exit(code);
