import { withTransaction } from '../db/unitOfWork.js';
import { ids } from '../db/ids.js';
import { tryAcquireLease, acquireLease, DEFAULT_HEARTBEAT_MS } from '../locks/leaseLock.js';
import { lockKeys } from '../locks/lockKeys.js';
import { LockBusyError, LockLostError } from '../locks/errors.js';
import { DEFAULT_TTL_MS } from '../repositories/lockRepo.js';
import {
  groupRepo, managerRepo, seasonRepo, eventRepo, playerRepo, managerGameweekRepo, managerSeasonRepo, liveRepo, syncRunRepo, NotFoundError,
} from '../repositories/index.js';
import { FplError, FplErrorKind } from '../fpl/errors.js';
import { RunRecorder } from './runRecorder.js';
import { FailureCode, SyncStageError, failureOf } from './classify.js';
import {
  seasonOfBootstrap, buildEvents, teamsOf, playersOf, chipRulesOf, profileFromEntry, profileFromStandings, mergeLeagueMembers, sameMembers,
  picksOf, chipsOf, transfersOf, buildSeasonRows, liveElementsOf,
} from './normalize.js';

// Synchronization (architecture v0.2 §15, v0.3 §5, §6, §8). Orchestrates the
// FPL client, the repositories, db/unitOfWork and the lease lock; it never
// touches Mongoose itself.
//
// A run:
//   1. takes the lease (busy → LockBusyError, 409 SYNC_IN_PROGRESS; no run row),
//      marks runs left RUNNING under older fencing tokens ABANDONED (§5 step 5),
//      and inserts the syncRuns document RUNNING before any fetch (§6 rule 7);
//   2. bootstrap: season + events in T1 (fenced on the bootstrap lease), then
//      players (unordered bulk upsert);
//   3. members: league standings → T2 (fenced on the group lease);
//   4. per member: fetch concurrently (the client limits concurrency), then one
//      T3 per member (fenced), whole season reconciled before the write;
//   5. live data once the deadline has passed;
//   6. semantics evidence from rows this run inserted or changed;
//   7. finish SUCCESS | PARTIAL | FAILED and release the lease.
// Non-transactional writes (players, live, semantics) first confirm the lease
// is still held. Every write is an idempotent upsert behind a content hash, so a
// transient-error retry or a replay changes nothing but confirmation stamps.

export class GroupArchivedError extends Error {
  constructor(groupId) {
    super(`group ${groupId} is archived`);
    this.name = 'GroupArchivedError';
    this.code = 'GROUP_ARCHIVED';
    this.status = 409;
  }
}

const MAX_STANDINGS_PAGES = 20;

const stageError = (stage) => (err) => {
  if (err && typeof err === 'object' && !err.stage) err.stage = stage;
  throw err;
};

const settledWarnings = (collection, out) => (out?.settledRowChanges ?? []).map((c) => ({
  code: 'SETTLED_ROW_CHANGED', detail: { collection, id: c.id, oldHash: c.oldHash, newHash: c.newHash },
}));

/**
 * @param {{ client: ReturnType<import('../fpl/client.js').createFplClient>, clock?: () => Date,
 *   leaseTtlMs?: number, heartbeatMs?: number, bootstrapWaitMs?: number }} deps
 */
export function createSyncService({ client, clock = () => new Date(), leaseTtlMs = DEFAULT_TTL_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS, bootstrapWaitMs = 30_000 }) {
  async function ensureLease(lease) {
    if (!(await lease.heartbeat())) throw new LockLostError(lease.lockId, 'heartbeat');
  }

  async function runJob({ lockId, job, target, season, event, trigger }, body) {
    const lease = await tryAcquireLease(lockId, { ttlMs: leaseTtlMs });
    if (!lease) throw new LockBusyError(lockId);
    const runId = String(lease.owner); // the lease owner is the run id (v0.3 §3 locks row)
    const out = { warnings: [], failures: [], partial: false, stats: {} };
    let run;
    try {
      lease.startHeartbeat({ intervalMs: heartbeatMs });
      const abandoned = await syncRunRepo.markAbandoned(lockId, lease.fencingToken, { at: clock() });
      run = await syncRunRepo.insert({ id: runId, job, target, season, event, trigger, lockId, lockFencingToken: lease.fencingToken, startedAt: clock() });
      if (abandoned) out.warnings.push({ code: 'RUNS_ABANDONED', detail: { count: abandoned } });
    } catch (err) {
      lease.stopHeartbeat();
      await lease.release().catch(() => {});
      throw err;
    }

    const recorder = new RunRecorder({ runId, client, captureEvidence: trigger === 'FINALIZE', clock });
    const ctx = { lease, run, recorder, out, season, event, write: () => ({ runId, startedAt: run.startedAt, at: clock() }) };
    let status;
    try {
      await body(ctx);
      status = out.failures.length || out.partial ? 'PARTIAL' : 'SUCCESS';
    } catch (err) {
      out.failures.push(failureOf(err, { stage: err?.stage ?? null }));
      status = 'FAILED';
    } finally {
      lease.stopHeartbeat();
      await recorder.flush();
      if (recorder.writeErrors.length) out.warnings.push({ code: 'REQUEST_LOG_WRITE_FAILED', detail: { count: recorder.writeErrors.length } });
    }
    try {
      const finished = await syncRunRepo.finish(runId, { status, warnings: out.warnings, failures: out.failures, finishedAt: clock() });
      if (!finished) status = (await syncRunRepo.get(runId))?.status ?? status; // e.g. ABANDONED by a takeover
    } finally {
      await lease.release().catch(() => {});
    }
    return { runId, status, warnings: out.warnings, failures: out.failures, stats: out.stats };
  }

  // ── stage 2: bootstrap (T1 + players) ──────────────────────────────────
  async function bootstrapStage(ctx, { ownsBootstrapLease }) {
    const { recorder, out, season, write } = ctx;
    const { data: bootstrap, hash: hB } = await recorder.fetch((c) => c.getBootstrapStatic());
    const { data: fixtures, hash: hF } = await recorder.fetch((c) => c.getFixtures());
    const derived = seasonOfBootstrap(bootstrap);
    if (derived !== season) throw new SyncStageError('SEASON_MISMATCH', `bootstrap is season ${derived}, sync asked for ${season}`);

    const chip = chipRulesOf(bootstrap);
    let chipRules;
    let chipRequests;
    if (chip.valid) {
      chipRules = chip.chipRules;
      chipRequests = { bootstrap: hB };
    } else {
      // v0.2 §8: reject the whole set, keep the previous valid rules, log the payload.
      out.warnings.push({ code: 'CHIP_RULES_INVALID', detail: { problems: chip.problems, chips: bootstrap.chips } });
      const prev = await seasonRepo.get(season, { withProvenance: true });
      if (!prev) throw new SyncStageError('CHIP_RULES_UNAVAILABLE', 'bootstrap chips[] invalid, no stored rules and no config fallback file');
      chipRules = { source: prev.chipRules.source, rules: prev.chipRules.rules };
      chipRequests = prev.chipRules.provenance.sourceRequests;
    }

    await ensureLease(ctx.lease);
    const bootLease = ownsBootstrapLease ? ctx.lease : await acquireLease(lockKeys.bootstrap(), { waitMs: bootstrapWaitMs, ttlMs: leaseTtlMs });
    let t1;
    try {
      t1 = await withTransaction(async (session) => {
        await bootLease.fence(session);
        const existing = new Map((await eventRepo.listBySeason(season, { session })).map((e) => [e.gw, e]));
        const { events, unscheduledFixtures } = buildEvents({ season, bootstrap, fixtures, now: clock(), existing });
        const seasonOut = await seasonRepo.replaceTeamsAndChipRules(
          { season, teams: teamsOf(bootstrap), unscheduledFixtures, chipRules },
          write(),
          { session, sourceRequests: { season: { bootstrap: hB, fixtures: hF }, chipRules: chipRequests } },
        );
        const eventsOut = await eventRepo.bulkUpsert(events, write(), { session, sourceRequests: { bootstrap: hB, fixtures: hF } });
        return { events, seasonOut, eventsOut };
      });
    } finally {
      if (!ownsBootstrapLease) await bootLease.release().catch(() => {});
    }
    out.warnings.push(...settledWarnings('events', t1.eventsOut));

    await ensureLease(ctx.lease);
    const playersOut = await playerRepo.bulkUpsert(playersOf(bootstrap, season), write(), { sourceRequests: { bootstrap: hB } });
    out.stats.bootstrap = {
      season: t1.seasonOut.season, chipRules: t1.seasonOut.chipRules,
      events: { inserted: t1.eventsOut.inserted.length, changed: t1.eventsOut.changed.length, unchanged: t1.eventsOut.unchanged.length },
      players: { inserted: playersOut.inserted.length, changed: playersOut.changed.length, unchanged: playersOut.unchanged.length },
    };
    return { bootstrap, events: t1.events };
  }

  // ── stage 3: league members (T2) ───────────────────────────────────────
  async function membersStage(ctx, groupId) {
    const { recorder, out, lease, write } = ctx;
    const group = await groupRepo.getById(groupId);
    if (group.memberSource !== 'LEAGUE_STANDINGS') return group.members;

    const rows = [];
    const hashByEntry = new Map();
    try {
      for (let page = 1; page <= MAX_STANDINGS_PAGES; page++) {
        const { data, hash } = await recorder.fetch((c) => c.getClassicLeagueStandings(group.fplLeagueId, { page }));
        for (const r of data.standings.results) {
          if (!hashByEntry.has(r.entry)) rows.push(r);
          hashByEntry.set(r.entry, hash);
        }
        if (!data.standings.has_next) break;
      }
    } catch (err) {
      const f = failureOf(err, { league: true, stage: 'standings' });
      if (f.code !== FailureCode.AUTH_REQUIRED) throw err;
      // v0.2 §10: freeze members to the last known list; the run is PARTIAL.
      out.warnings.push({ code: 'LEAGUE_AUTH_REQUIRED', detail: { fplLeagueId: group.fplLeagueId } });
      out.partial = true;
      return group.members;
    }
    if (rows.length === 0) {
      out.warnings.push({ code: 'LEAGUE_EMPTY', detail: { fplLeagueId: group.fplLeagueId } });
      out.partial = true;
      return group.members;
    }

    const standingsIds = rows.map((r) => r.entry);
    const profiles = new Map(rows.map((r) => [r.entry, profileFromStandings(r)]));
    const t2 = await withTransaction(async (session) => {
      await lease.fence(session);
      const current = await groupRepo.getById(groupId, { session });
      const merged = mergeLeagueMembers(current.members, standingsIds);
      const members = sameMembers(merged, current.members) ? current.members : (await groupRepo.setMembers(groupId, merged, { session, at: clock() })).members;
      // Every member gets a managers document in the same transaction (no orphans, v0.3 §16 item 2).
      const known = new Set((await managerRepo.getMany(standingsIds, { session })).map((m) => m.entryId));
      const missing = standingsIds.filter((id) => !known.has(id));
      let managersOut = null;
      if (missing.length) {
        managersOut = await managerRepo.upsertProfiles(missing.map((id) => profiles.get(id)), write(), {
          session, sourceRequests: (p) => ({ standings: hashByEntry.get(p.entryId) }),
        });
      }
      return { members, managersOut };
    });
    out.warnings.push(...settledWarnings('managers', t2.managersOut));
    return t2.members;
  }

  // ── stage 4: one member (fetch, then T3) ───────────────────────────────
  async function fetchMember(recorder, entryId, event) {
    const entry = await recorder.fetch((c) => c.getEntry(entryId));
    const history = await recorder.fetch((c) => c.getEntryHistory(entryId));
    let picksCall = null;
    try {
      picksCall = await recorder.fetch((c) => c.getEntryPicks(entryId, event));
    } catch (err) {
      // No picks for this GW (e.g. before the deadline, or the entry joined later).
      if (!(err instanceof FplError && err.kind === FplErrorKind.NOT_FOUND)) throw err;
    }
    const transfers = await recorder.fetch((c) => c.getEntryTransfers(entryId));
    let picks = null;
    if (picksCall) {
      try {
        picks = picksOf(picksCall.data);
      } catch (err) {
        recorder.captureFailure(picksCall.entry);
        throw err;
      }
    }
    return { entry, history, transfers, picks, picksHash: picksCall?.hash ?? null };
  }

  async function writeMember(ctx, entryId, fetched, { seasonSemantics, eventStates }) {
    const { lease, season, event, write } = ctx;
    return withTransaction(async (session) => {
      await lease.fence(session);
      const existingRows = await managerGameweekRepo.listForEntry(season, entryId, { session, withProvenance: true });
      const built = buildSeasonRows({
        season, entryId, event, history: fetched.history.data, picks: fetched.picks, seasonSemantics, eventStates, existingRows,
        hashes: { history: fetched.history.hash, picks: fetched.picksHash },
      });
      const managerOut = await managerRepo.upsertProfiles([profileFromEntry(fetched.entry.data)], write(), { session, sourceRequests: { entry: fetched.entry.hash } });
      const seasonOut = await managerSeasonRepo.upsert(
        { season, entryId, chips: chipsOf(fetched.history.data), transfers: transfersOf(fetched.transfers.data) },
        write(),
        { session, sourceRequests: { history: fetched.history.hash, transfers: fetched.transfers.hash } },
      );
      const rowsOut = await managerGameweekRepo.bulkUpsertSeasonRows(season, entryId, built.rows, write(), {
        session, sourceRequests: (r) => built.sourceRequests.get(r.event),
      });
      return { built, managerOut, seasonOut, rowsOut };
    });
  }

  async function membersSyncStage(ctx, members, events) {
    const { recorder, out, season, event } = ctx;
    const seasonSemantics = (await seasonRepo.get(season)).pointsSemantics.value;
    const eventStates = new Map(events.map((e) => [e.gw, e.state]));
    const fetched = await Promise.all(members.map((m) => fetchMember(recorder, m.entryId, event).then(
      (value) => ({ entryId: m.entryId, value }),
      (error) => ({ entryId: m.entryId, error }),
    )));

    const evidence = { gross: 0, net: 0 };
    const stats = { synced: 0, failed: 0, rows: { inserted: 0, changed: 0, unchanged: 0 } };
    for (const f of fetched) {
      if (f.error) {
        if (f.error?.code === 'LOCK_LOST') throw f.error;
        out.failures.push(failureOf(f.error, { entryId: f.entryId, stage: 'fetch' }));
        stats.failed += 1;
        continue;
      }
      let w;
      try {
        w = await writeMember(ctx, f.entryId, f.value, { seasonSemantics, eventStates });
      } catch (err) {
        if (err?.code === 'LOCK_LOST') throw err;
        // Failure isolation (v0.3 §6 rule 6): the member keeps its previous rows and confirmations.
        out.failures.push(failureOf(err, { entryId: f.entryId, stage: 'write' }));
        stats.failed += 1;
        continue;
      }
      stats.synced += 1;
      for (const k of ['inserted', 'changed', 'unchanged']) stats.rows[k] += w.rowsOut[k].length;
      const written = new Set([...w.rowsOut.inserted, ...w.rowsOut.changed]);
      for (const [ev, hypothesis] of w.built.evidenceCandidates) {
        if (!written.has(ids.managerGameweek(season, f.entryId, ev))) continue;
        if (hypothesis === 'GROSS') evidence.gross += 1;
        else evidence.net += 1;
      }
      out.warnings.push(...settledWarnings('managers', w.managerOut), ...settledWarnings('managerSeasons', w.seasonOut), ...settledWarnings('managerGameweeks', w.rowsOut));
    }
    out.stats.members = stats;
    return evidence;
  }

  // ── stage 5: live ──────────────────────────────────────────────────────
  async function liveStage(ctx, bootstrap, events) {
    const { recorder, out, lease, season, event, write } = ctx;
    const ev = events.find((e) => e.gw === event);
    if (clock().getTime() < ev.deadlineTime.getTime()) return;
    try {
      const live = await recorder.fetch((c) => c.getEventLive(event));
      const teamOf = new Map(bootstrap.elements.map((p) => [p.id, p.team]));
      const elements = liveElementsOf(live.data, ev.fixtures, teamOf);
      await ensureLease(lease);
      const liveOut = await liveRepo.replace({ season, gw: event, elements }, write(), { sourceRequests: { live: live.hash } });
      out.warnings.push(...settledWarnings('liveGameweeks', liveOut));
    } catch (err) {
      if (err?.code === 'LOCK_LOST') throw err;
      out.failures.push(failureOf(err, { stage: 'live' }));
    }
  }

  return {
    /** Bootstrap-only job under the sync:bootstrap lease (T1 + players). */
    async syncBootstrap({ season, trigger = 'SCHEDULER' }) {
      return runJob({ lockId: lockKeys.bootstrap(), job: 'bootstrap', target: 'bootstrap', season, event: null, trigger }, async (ctx) => {
        await bootstrapStage(ctx, { ownsBootstrapLease: true }).catch(stageError('bootstrap'));
      });
    },

    /**
     * Group GW sync (v0.2 §15). Throws LockBusyError (409 SYNC_IN_PROGRESS) when
     * the group lease is held, GroupArchivedError for an archived group.
     * @returns {Promise<{ runId: string, status: string, warnings: object[], failures: object[], stats: object }>}
     */
    async syncGroupGameweek({ groupId, season, event, trigger = 'MANUAL' }) {
      const group = await groupRepo.getById(groupId);
      if (!group) throw new NotFoundError('group', groupId);
      if (!group.isActive) throw new GroupArchivedError(groupId);
      ids.event(season, event); // validates season / event before taking the lease
      return runJob({ lockId: lockKeys.group(groupId), job: 'group-gw', target: String(groupId), season, event, trigger }, async (ctx) => {
        const { bootstrap, events } = await bootstrapStage(ctx, { ownsBootstrapLease: false }).catch(stageError('bootstrap'));
        if (!events.some((e) => e.gw === event)) throw new SyncStageError('UNKNOWN_EVENT', `GW ${event} is not in bootstrap`);
        const members = await membersStage(ctx, groupId).catch(stageError('members'));
        const evidence = await membersSyncStage(ctx, members, events);
        await liveStage(ctx, bootstrap, events);
        if (evidence.gross + evidence.net > 0) {
          await ensureLease(ctx.lease);
          ctx.out.stats.semantics = await seasonRepo.applySemanticsEvidence(season, evidence, ctx.run.id);
        }
        ctx.out.stats.evidence = evidence;
      });
    },
  };
}
