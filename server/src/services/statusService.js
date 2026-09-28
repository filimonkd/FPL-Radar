import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  ownershipRepo as defaultOwnershipRepo, groupRepo as defaultGroupRepo, seasonRepo as defaultSeasonRepo, eventRepo as defaultEventRepo,
  liveRepo as defaultLiveRepo, syncRunRepo as defaultSyncRunRepo, NotFoundError,
} from '../repositories/index.js';
import { getStorageStats as defaultStorageStats } from '../db/connection.js';
import { chipInputs, buildChipView } from './chipModel.js';
import { parseSmokeReport } from './smokeReport.js';

// Chips page and Status page reads (architecture v0.2 §8, v0.3 §9, §15 step 11).
// Read-only: nothing here writes, and finalized results are never touched.

const CONTRACT_DIR = fileURLToPath(new URL('../../fpl-contract/', import.meta.url));

export function createStatusService({ repos = {}, storageStats = defaultStorageStats, contractDir = CONTRACT_DIR } = {}) {
  const ownershipRepo = repos.ownershipRepo ?? defaultOwnershipRepo;
  const groupRepo = repos.groupRepo ?? defaultGroupRepo;
  const seasonRepo = repos.seasonRepo ?? defaultSeasonRepo;
  const eventRepo = repos.eventRepo ?? defaultEventRepo;
  const liveRepo = repos.liveRepo ?? defaultLiveRepo;
  const syncRunRepo = repos.syncRunRepo ?? defaultSyncRunRepo;

  const runSummary = (r) => ({
    id: r.id, job: r.job, target: r.target, season: r.season, event: r.event, trigger: r.trigger, status: r.status,
    startedAt: r.startedAt, finishedAt: r.finishedAt, requests: r.requests.length,
    failures: r.failures, warnings: r.warnings, retained: r.expireAt === null,
  });

  async function smoke(season) {
    try {
      return parseSmokeReport(await readFile(`${contractDir}${season}/smoke-report.md`, 'utf8'));
    } catch {
      return { available: false };
    }
  }

  return {
    /** Chips for a group: rules + availability per manager, and the GW's chip state per manager. */
    async getChips(groupId, season, event) {
      if (!(await groupRepo.getById(groupId))) throw new NotFoundError('group', groupId);
      let gw = event;
      if (gw == null) gw = (await eventRepo.getCurrent(season))?.gw ?? null;
      if (gw == null) {
        return { groupId, season, event: null, rules: null, availability: null, gameweek: [], warnings: [{ code: 'NO_CURRENT_EVENT' }], sources: [] };
      }
      const loaded = await ownershipRepo.loadChips(groupId, season, gw);
      return { groupId, season, ...buildChipView(chipInputs(loaded, gw)), sources: loaded.sources };
    },

    /** Event states of a season (gameweek status, live state of the current GW). */
    async getEvents(season) {
      const events = await eventRepo.listBySeason(season, { withProvenance: true });
      const current = events.find((e) => e.isCurrent) ?? null;
      const live = current ? await liveRepo.get(season, current.gw, { withProvenance: true }) : null;
      return {
        season,
        currentEvent: current?.gw ?? null,
        events: events.map((e) => ({
          gw: e.gw, state: e.state, deadlineTime: e.deadlineTime, isCurrent: e.isCurrent, isNext: e.isNext, finished: e.finished,
          dataChecked: e.dataChecked, dataCheckedObservedAt: e.dataCheckedObservedAt,
          fixtures: { total: e.fixtures.length, finished: e.fixtures.filter((f) => f.finished).length, started: e.fixtures.filter((f) => f.started).length },
          lastConfirmedAt: e.provenance.lastConfirmedAt, lastConfirmedByRunId: e.provenance.lastConfirmedByRunId,
        })),
        live: live ? {
          gw: live.gw,
          elements: live.elements.length,
          settled: live.elements.filter((x) => x.settled).length,
          lastConfirmedAt: live.provenance.lastConfirmedAt,
          lastConfirmedByRunId: live.provenance.lastConfirmedByRunId,
          settledFlag: live.provenance.settled,
        } : null,
      };
    },

    /** Status page (admin): runs, semantics, chip-rule source, storage gauge, smoke verdicts. */
    async getStatus(season, { limit = 20 } = {}) {
      const s = await seasonRepo.get(season, { withProvenance: true });
      const runs = await syncRunRepo.listRecentRuns({ limit });
      return {
        season,
        semantics: s?.pointsSemantics ?? null, // shown verbatim: UNVERIFIED / CONFLICTED are never reinterpreted
        chipRules: s ? { source: s.chipRules.source, rules: s.chipRules.rules.length, lastChangedAt: s.chipRules.provenance.lastChangedAt, lastConfirmedAt: s.chipRules.provenance.lastConfirmedAt } : null,
        storage: await storageStats(),
        runs: runs.map(runSummary),
        smoke: await smoke(season),
      };
    },

    /** One run with its full request log (Status page drill-down). */
    async getRun(runId) {
      const run = await syncRunRepo.get(runId);
      if (!run) throw new NotFoundError('run', runId);
      return run;
    },
  };
}
