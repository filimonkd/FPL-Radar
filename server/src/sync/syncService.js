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

export class ShuttingDownError extends Error {
  constructor() {
    super('the server is shutting down; no new sync runs are started');
    this.name = 'ShuttingDownError';
    this.code = 'SHUTTING_DOWN';
    this.status = 503;
  }
}

const MAX_STANDINGS_PAGES = 20;

/** All standings pages of a classic league; `fetcher.fetch(call)` → { data, hash }. */
async function readStandings(fetcher, fplLeagueId) {
  const rows = [];
  const hashByEntry = new Map();
  let league = null;
  for (let page = 1; page <= MAX_STANDINGS_PAGES; page++) {
    const { data, hash } = await fetcher.fetch((c) => c.getClassicLeagueStandings(fplLeagueId, { page }));
    league ??= { id: data.league.id, name: data.league.name };
    for (const r of data.standings.results) {
      if (!hashByEntry.has(r.entry)) rows.push(r);
      hashByEntry.set(r.entry, hash);
    }
    if (!data.standings.has_next) break;
  }
  return { league, rows, hashByEntry };
}

// League access classes (v0.2 §10). BLOCKED / network / upstream failures are not
// an answer about the league, so they are thrown, never reported as EMPTY.
const LEAGUE_ACCESS_ANSWERS = new Map([[FailureCode.AUTH_REQUIRED, 'AUTH_REQUIRED'], [FailureCode.NOT_FOUND, 'NOT_FOUND']]);

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

  // Runs holding a lease in this process, for shutdown (v0.3 §11 SIGTERM).
  const active = new Map(); // runId → { lease }
  let closing = null;

  /**
   * One run under one lease. `rethrow`: a failing body still finishes the run as
   * FAILED, then its error is rethrown to the caller (used by the API-facing
   * member jobs, whose validation failures become 4xx responses).
   */
  async function runJob({ lockId, job, target, season = null, event = null, trigger, rethrow = false, after = null }, body) {
    if (closing) throw new ShuttingDownError();
    const lease = await tryAcquireLease(lockId, { ttlMs: leaseTtlMs });
    if (!lease) throw new LockBusyError(lockId);
    const runId = String(lease.owner); // the lease owner is the run id (v0.3 §3 locks row)
    active.set(runId, { lease, hasRun: true });
    const out = { warnings: [], failures: [], partial: false, stats: {} };
    let run;
    try {
      if (closing) throw new ShuttingDownError();
      lease.startHeartbeat({ intervalMs: heartbeatMs });
      const abandoned = await syncRunRepo.markAbandoned(lockId, lease.fencingToken, { at: clock() });
      run = await syncRunRepo.insert({ id: runId, job, target, season, event, trigger, lockId, lockFencingToken: lease.fencingToken, startedAt: clock() });
      if (abandoned) out.warnings.push({ code: 'RUNS_ABANDONED', detail: { count: abandoned } });
    } catch (err) {
      active.delete(runId);
      lease.stopHeartbeat();
      await lease.release().catch(() => {});
      throw err;
    }

    const recorder = new RunRecorder({ runId, client, captureEvidence: trigger === 'FINALIZE', clock });
    const ctx = { lease, run, recorder, out, season, event, write: () => ({ runId, startedAt: run.startedAt, at: clock() }) };
    let status;
    let result;
    let failure = null;
    try {
      if (closing) throw new ShuttingDownError();
      result = await body(ctx);
      status = out.failures.length || out.partial ? 'PARTIAL' : 'SUCCESS';
    } catch (err) {
      failure = err;
      out.failures.push(failureOf(err, { stage: err?.stage ?? null }));
      status = 'FAILED';
    } finally {
      if (!after) lease.stopHeartbeat();
      await recorder.flush();
      if (recorder.writeErrors.length) out.warnings.push({ code: 'REQUEST_LOG_WRITE_FAILED', detail: { count: recorder.writeErrors.length } });
    }
    let afterResult;
    let afterError = null;
    try {
      // finish() only moves a RUNNING run: a run already ABANDONED (takeover or
      // shutdown) can never be turned into a success afterwards.
      const finished = await syncRunRepo.finish(runId, { status, warnings: out.warnings, failures: out.failures, finishedAt: clock() });
      if (!finished) status = (await syncRunRepo.get(runId))?.status ?? status;
      // `after` runs on the finished, truthful run while the same lease is still
      // held and heartbeating (finalize: sync → gate → T4 under one lease, v0.3 §5).
      if (after) {
        try {
          afterResult = await after(ctx, { runId, status, warnings: out.warnings, failures: out.failures, stats: out.stats });
        } catch (err) {
          afterError = err;
        }
      }
    } finally {
      lease.stopHeartbeat();
      await lease.release().catch(() => {});
      active.delete(runId);
    }
    if (afterError) throw afterError;
    if (rethrow && failure) throw failure;
    if (rethrow && status !== 'SUCCESS') throw new SyncStageError(status === 'ABANDONED' ? 'RUN_ABANDONED' : 'RUN_FAILED', `run ${runId} ended ${status}`);
    return { runId, status, warnings: out.warnings, failures: out.failures, stats: out.stats, result, after: afterResult };
  }

  /**
   * Holds a group lease without a sync run (override / recompute decide on stored
   * data, v0.2 §4). Busy → LockBusyError; shutdown releases it like any other.
   */
  async function withGroupLease(groupId, fn) {
    if (closing) throw new ShuttingDownError();
    const lockId = lockKeys.group(groupId);
    const lease = await tryAcquireLease(lockId, { ttlMs: leaseTtlMs });
    if (!lease) throw new LockBusyError(lockId);
    const key = `lease:${lease.owner}`;
    active.set(key, { lease, hasRun: false });
    lease.startHeartbeat({ intervalMs: heartbeatMs });
    try {
      if (closing) throw new ShuttingDownError();
      return await fn(lease);
    } finally {
      lease.stopHeartbeat();
      await lease.release().catch(() => {});
      active.delete(key);
    }
  }

  /**
   * SIGTERM (v0.3 §11): refuse new runs, mark every run this process holds
   * ABANDONED (before anything can finish it), then release its lease. The
   * in-flight work then fails its next fence and cannot commit. Idempotent.
   */
  function shutdown() {
    closing ??= (async () => {
      const abandoned = [];
      for (const [runId, { lease, hasRun }] of active) {
        lease.stopHeartbeat();
        if (hasRun) await syncRunRepo.markAbandoned(lease.lockId, lease.fencingToken + 1, { at: clock() }).catch(() => {});
        await lease.release().catch(() => {});
        if (hasRun) abandoned.push(runId);
      }
      return { abandoned };
    })();
    return closing;
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

    let rows;
    let hashByEntry;
    try {
      ({ rows, hashByEntry } = await readStandings(recorder, group.fplLeagueId));
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

  // ── stage 6: player history backfill (Step 17) ─────────────────────────
  /**
   * Fetches live data for finished, data-checked GWs before the synced one
   * whose stored live data is missing or incomplete, so per-player points and
   * minutes exist for every finished GW. After the first run this makes no
   * requests. Skipped on FINALIZE runs (whose live responses are kept as
   * evidence). A failure is a warning, never a failed run: results do not
   * depend on it.
   */
  async function historyStage(ctx, bootstrap, events, trigger) {
    const { recorder, out, lease, season, event, write } = ctx;
    if (trigger === 'FINALIZE') return;
    const complete = new Set(await liveRepo.listSettledGws(season));
    const todo = events.filter((e) => e.gw < event && e.finished && e.dataChecked && !complete.has(e.gw)).map((e) => e.gw);
    const teamOf = new Map(bootstrap.elements.map((p) => [p.id, p.team]));
    let filled = 0;
    for (const gw of todo) {
      try {
        const live = await recorder.fetch((c) => c.getEventLive(gw));
        const ev = events.find((e) => e.gw === gw);
        await ensureLease(lease);
        await liveRepo.replace({ season, gw, elements: liveElementsOf(live.data, ev.fixtures, teamOf) }, write(), { sourceRequests: { live: live.hash } });
        filled += 1;
      } catch (err) {
        if (err?.code === 'LOCK_LOST') throw err;
        const f = failureOf(err, { stage: 'history' });
        out.warnings.push({ code: 'HISTORY_BACKFILL_INCOMPLETE', detail: { gw, failure: f.code, message: f.message } });
        break; // FPL trouble: try the rest on the next sync
      }
    }
    out.stats.history = { missing: todo.length, filled };
  }

  // ── group membership (T2) jobs used by the group API ───────────────────
  const direct = { fetch: async (call) => ({ data: await call(client), hash: null }) };

  /** Classifies anonymous standings access: OK | AUTH_REQUIRED | EMPTY | NOT_FOUND. Other failures throw. */
  async function leagueAccess(fplLeagueId, fetcher = direct) {
    try {
      const { league, rows, hashByEntry } = await readStandings(fetcher, fplLeagueId);
      if (rows.length === 0) return { access: 'EMPTY', league, members: [], hashByEntry };
      return { access: 'OK', league, members: rows.map(profileFromStandings), hashByEntry };
    } catch (err) {
      const access = LEAGUE_ACCESS_ANSWERS.get(failureOf(err, { league: true }).code);
      if (access) return { access, league: null, members: [], hashByEntry: new Map() };
      throw err;
    }
  }

  /** Looks each entry up on the public /entry/{id}/ endpoint: { valid: profiles[], invalid: entryIds[] }. */
  async function lookupEntries(entryIds, fetcher = direct) {
    const results = await Promise.all(entryIds.map(async (entryId) => {
      try {
        const { data, hash } = await fetcher.fetch((c) => c.getEntry(entryId));
        return { entryId, profile: profileFromEntry(data), hash };
      } catch (err) {
        if (err instanceof FplError && err.kind === FplErrorKind.NOT_FOUND) return { entryId, profile: null };
        throw err;
      }
    }));
    return {
      valid: results.filter((r) => r.profile).map((r) => ({ ...r.profile, hash: r.hash })),
      invalid: results.filter((r) => !r.profile).map((r) => r.entryId),
    };
  }

  const toProfile = ({ entryId, playerName, teamName }) => ({ entryId, playerName, teamName });

  /**
   * Creates a group with its members and their managers documents in one T2
   * (fenced on the new group's lease), under a logged run so every FPL call
   * behind the new documents is traceable (v0.3 §8).
   *   LEAGUE_STANDINGS: members from anonymous standings; any access answer other
   *                     than OK fails with LEAGUE_NOT_ACCESSIBLE (never a fake empty league).
   *   MANUAL:           entryIds, each checked on /entry/{id}/ (INVALID_ENTRY_IDS).
   */
  async function registerGroup({ id, group, entryIds = [] }) {
    const { result } = await runJob({ lockId: lockKeys.group(id), job: 'group-create', target: id, trigger: 'MANUAL', rethrow: true }, async (ctx) => {
      let members;
      let profiles;
      let sourceOf;
      if (group.memberSource === 'LEAGUE_STANDINGS') {
        const access = await leagueAccess(group.fplLeagueId, ctx.recorder);
        if (access.access !== 'OK') throw new SyncStageError('LEAGUE_NOT_ACCESSIBLE', `league ${group.fplLeagueId}: ${access.access}`, { access: access.access });
        members = access.members.map((p) => ({ entryId: p.entryId, addedManually: false }));
        const known = new Set((await managerRepo.getMany(members.map((m) => m.entryId))).map((m) => m.entryId));
        profiles = access.members.filter((p) => !known.has(p.entryId));
        sourceOf = (p) => ({ standings: access.hashByEntry.get(p.entryId) });
      } else {
        const found = await lookupEntries(entryIds, ctx.recorder);
        if (found.invalid.length) throw new SyncStageError('INVALID_ENTRY_IDS', `unknown FPL entries: ${found.invalid.join(', ')}`, { invalid: found.invalid });
        members = entryIds.map((entryId) => ({ entryId, addedManually: true }));
        const hashes = new Map(found.valid.map((p) => [p.entryId, p.hash]));
        profiles = found.valid.map(toProfile);
        sourceOf = (p) => ({ entry: hashes.get(p.entryId) });
      }
      if (group.myEntryId != null && !members.some((m) => m.entryId === group.myEntryId)) {
        throw new SyncStageError('MY_ENTRY_NOT_MEMBER', `myEntryId ${group.myEntryId} is not a member`);
      }
      return withTransaction(async (session) => {
        await ctx.lease.fence(session);
        const created = await groupRepo.create({ ...group, id, members }, { session, at: clock() });
        if (profiles.length) await managerRepo.upsertProfiles(profiles, ctx.write(), { session, sourceRequests: sourceOf });
        return created;
      });
    });
    return result;
  }

  /**
   * Adds manual members (v0.2 §10: POST /groups/:id/members { entryIds }) after
   * checking each on /entry/{id}/; one T2 fenced on the group lease. An entryId
   * already in the group is rejected (DuplicateMemberError), never merged.
   */
  async function addMembers(groupId, entryIds) {
    const { result } = await runJob({ lockId: lockKeys.group(groupId), job: 'group-members', target: String(groupId), trigger: 'MANUAL', rethrow: true }, async (ctx) => {
      const found = await lookupEntries(entryIds, ctx.recorder);
      if (found.invalid.length) throw new SyncStageError('INVALID_ENTRY_IDS', `unknown FPL entries: ${found.invalid.join(', ')}`, { invalid: found.invalid });
      const hashes = new Map(found.valid.map((p) => [p.entryId, p.hash]));
      return withTransaction(async (session) => {
        await ctx.lease.fence(session);
        const current = await groupRepo.getById(groupId, { session });
        if (!current) throw new NotFoundError('group', groupId);
        if (!current.isActive) throw new GroupArchivedError(groupId);
        const updated = await groupRepo.setMembers(groupId, [
          ...current.members,
          ...entryIds.map((entryId) => ({ entryId, addedManually: true })),
        ], { session, at: clock() });
        await managerRepo.upsertProfiles(found.valid.map(toProfile), ctx.write(), { session, sourceRequests: (p) => ({ entry: hashes.get(p.entryId) }) });
        return updated;
      });
    });
    return result;
  }

  return {
    leagueAccess: (fplLeagueId) => leagueAccess(fplLeagueId),
    lookupEntries: (entryIds) => lookupEntries(entryIds),
    registerGroup,
    addMembers,
    shutdown,
    get activeRuns() {
      return [...active].filter(([, v]) => v.hasRun).map(([runId]) => runId);
    },
    get shuttingDown() {
      return closing !== null;
    },

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
      return syncGroup({ groupId, season, event, trigger });
    },

    /**
     * Finalize path (v0.2 §15, v0.3 §5): a FINALIZE-trigger sync, then
     * `after(ctx, run)` on the finished run while the same group lease is held.
     * The result is `after`'s return value; its errors propagate.
     */
    async syncGroupGameweekThen({ groupId, season, event, trigger = 'FINALIZE' }, after) {
      return (await syncGroup({ groupId, season, event, trigger, after })).after;
    },

    withGroupLease,
  };

  async function syncGroup({ groupId, season, event, trigger, after = null }) {
    const group = await groupRepo.getById(groupId);
    if (!group) throw new NotFoundError('group', groupId);
    if (!group.isActive) throw new GroupArchivedError(groupId);
    ids.event(season, event); // validates season / event before taking the lease
    return runJob({ lockId: lockKeys.group(groupId), job: 'group-gw', target: String(groupId), season, event, trigger, after }, async (ctx) => {
      const { bootstrap, events } = await bootstrapStage(ctx, { ownsBootstrapLease: false }).catch(stageError('bootstrap'));
      if (!events.some((e) => e.gw === event)) throw new SyncStageError('UNKNOWN_EVENT', `GW ${event} is not in bootstrap`);
      const members = await membersStage(ctx, groupId).catch(stageError('members'));
      const evidence = await membersSyncStage(ctx, members, events);
      await liveStage(ctx, bootstrap, events);
      await historyStage(ctx, bootstrap, events, trigger);
      if (evidence.gross + evidence.net > 0) {
        await ensureLease(ctx.lease);
        ctx.out.stats.semantics = await seasonRepo.applySemanticsEvidence(season, evidence, ctx.run.id);
      }
      ctx.out.stats.evidence = evidence;
    });
  }
}
