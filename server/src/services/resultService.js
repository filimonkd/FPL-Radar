import { withTransaction } from '../db/unitOfWork.js';
import { ENGINE_VERSION } from '../analytics/index.js';
import {
  resultRepo as defaultResultRepo, syncRunRepo as defaultSyncRunRepo, rawResponseRepo as defaultRawResponseRepo,
  seasonRepo as defaultSeasonRepo, groupRepo as defaultGroupRepo, NotFoundError,
} from '../repositories/index.js';
import { snapshotContentHashOf } from '../repositories/mappers/result.js';
import { GroupArchivedError } from '../sync/index.js';
import { AppError } from '../errors.js';
import { canonicalJson } from '../utils/canonical.js';
import {
  evaluateFinalizeGate, computeResult, explainDecision, buildSnapshotInput, verifySnapshotReproduces, diffResults,
} from './resultModel.js';

// Results and decisions (architecture v0.2 §3–§4, §15; v0.3 §5, §7, §8).
//
// Reads (GET result) compute PROVISIONAL / BLOCKED from stored data, or return
// the current FINAL / OVERRIDDEN snapshot; they never write.
//
// Decisions all go through one T4 (runT4), inside one db/unitOfWork transaction,
// under the group lease:
//   fence → read head (+ chain check) → load inputs & gate on the same snapshot
//   → insertSnapshot → appendAction → movePointer → retain sources & evidence.
// Any failure (gate, validation, a lost lease, a concurrent decision) rolls the
// whole transaction back. Finalize holds the lease from its FINALIZE sync
// through T4, so inputs cannot change between the gate and the commit.

const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const sortIds = (ids) => [...ids].sort((a, b) => a - b);

export function createResultService({
  sync,
  clock = () => new Date(),
  engineVersion = ENGINE_VERSION,
  repos = {},
}) {
  const resultRepo = repos.resultRepo ?? defaultResultRepo;
  const syncRunRepo = repos.syncRunRepo ?? defaultSyncRunRepo;
  const rawResponseRepo = repos.rawResponseRepo ?? defaultRawResponseRepo;
  const seasonRepo = repos.seasonRepo ?? defaultSeasonRepo;
  const groupRepo = repos.groupRepo ?? defaultGroupRepo;

  async function requireGroup(groupId, { writable = false } = {}) {
    const g = await groupRepo.getById(groupId);
    if (!g) throw new NotFoundError('group', groupId);
    if (writable && !g.isActive) throw new GroupArchivedError(groupId);
    return g;
  }

  const seasonSemanticsOf = async (season, session) => (await seasonRepo.get(season, { session }))?.pointsSemantics.value ?? 'UNVERIFIED';

  /**
   * The T4 decision transaction. `plan({ session, head, prev })` loads inputs on
   * the transaction's snapshot and returns { snapshot, newStatus } to commit, or
   * { replay } to return without writing; it throws to refuse (rolls back).
   */
  async function runT4({ lease, groupId, season, event, action, syncRunId = null, note = null, plan }) {
    return withTransaction(async (session) => {
      await lease.fence(session);
      const head = await resultRepo.getPointer(groupId, season, event, { session });
      if (head) {
        // A tampered chain blocks further decisions until an admin investigates (v0.3 §7).
        const chain = await resultRepo.verifyChain(groupId, season, event, { session });
        if (!chain.valid) throw new AppError(409, 'CHAIN_INVALID', 'the decision history for this gameweek does not verify', chain);
      }
      const prev = head ? await resultRepo.getSnapshot(head.currentSnapshotId, { session }) : null;
      const planned = await plan({ session, head, prev });
      if (planned.replay) return planned.replay;

      const snapshot = await resultRepo.insertSnapshot(planned.snapshot, { session });
      const appended = await resultRepo.appendAction(head, {
        groupId, season, event, action,
        prevStatus: head?.status ?? 'PROVISIONAL',
        newStatus: planned.newStatus,
        prevWinnerEntryIds: prev?.declaredWinnerEntryIds ?? [],
        newWinnerEntryIds: snapshot.declaredWinnerEntryIds,
        prevSnapshotId: head?.currentSnapshotId ?? null,
        newSnapshotId: snapshot.id,
        newSnapshotHash: snapshot.contentHash,
        note,
        syncRunId,
        actor: 'admin',
        createdAt: clock(),
      }, { session });
      const pointer = await resultRepo.movePointer(head, appended, { session });
      // Everything the snapshot cites is retained permanently (v0.3 §9).
      await syncRunRepo.unsetExpiry([...new Set(snapshot.sources.map((s) => s.syncRunId))], { session });
      await rawResponseRepo.unsetEvidenceExpiry(snapshot.sources, snapshot.id, { session });
      return { replayed: false, snapshot, action: appended, pointer };
    });
  }

  const blocked = (code, message, details) => new AppError(409, code, message, details);

  return {
    runT4, // exported for tests of the transaction itself

    /** GET result: the current decision, or a PROVISIONAL / BLOCKED preview. Never writes. */
    async getResult(groupId, season, event) {
      await requireGroup(groupId);
      const head = await resultRepo.getPointer(groupId, season, event);
      const inputs = await resultRepo.loadResultInputs(groupId, season, event);
      const seasonSemantics = await seasonSemanticsOf(season);
      const gate = evaluateFinalizeGate(inputs, { resultStatus: head?.status ?? null, seasonSemantics });
      const finalizeGate = { allowed: gate.allowed, reasons: gate.reasons };
      if (head) {
        const snap = await resultRepo.getSnapshot(head.currentSnapshotId);
        const regressed = inputs.eventState !== 'DATA_CHECKED' ? [{ code: 'SOURCE_STATE_REGRESSED', eventState: inputs.eventState }] : [];
        return {
          groupId, season, event,
          status: head.status,
          eventState: inputs.eventState,
          winners: snap.declaredWinnerEntryIds,
          computedWinners: snap.computedWinnerEntryIds,
          winningScore: snap.winningScore,
          tieBreakApplied: snap.tieBreakApplied,
          tieBreakTrace: snap.tieBreakTrace,
          standings: snap.standings,
          blockedBy: [],
          warnings: [...snap.warnings, ...regressed],
          finalizeGate,
          currentSnapshotId: head.currentSnapshotId,
          headSeq: head.headSeq,
        };
      }
      const result = computeResult(inputs);
      return {
        groupId, season, event,
        status: result.status,
        eventState: inputs.eventState,
        winners: result.winners,
        computedWinners: result.winners,
        winningScore: result.winningScore,
        tieBreakApplied: result.tieBreakApplied,
        tieBreakTrace: explainDecision(result),
        standings: result.rows,
        blockedBy: result.blockedBy,
        warnings: result.warnings,
        finalizeGate,
        currentSnapshotId: null,
        headSeq: 0,
        inputsHash: result.inputsHash,
      };
    },

    /**
     * POST finalize (v0.2 §15): FINALIZE sync (evidence stored) → gate → T4, all
     * under one group lease. Every eligible member must be confirmed by this
     * finalize run. A repeat with identical inputs returns the current FINAL
     * result without writing a second decision.
     */
    async finalize(groupId, season, event) {
      await requireGroup(groupId, { writable: true });
      return sync.syncGroupGameweekThen({ groupId, season, event, trigger: 'FINALIZE' }, async (ctx, run) => {
        const out = await runT4({
          lease: ctx.lease, groupId, season, event, action: 'FINALIZE', syncRunId: run.runId,
          plan: async ({ session, head, prev }) => {
            const inputs = await resultRepo.loadResultInputs(groupId, season, event, { session });
            const result = computeResult(inputs);
            if (head?.status === 'FINAL' && prev?.kind === 'RULE_BASED' && prev.inputsHash === result.inputsHash && same(prev.declaredWinnerEntryIds, result.winners)) {
              return { replay: { replayed: true, snapshot: prev, action: null, pointer: head } };
            }
            const gate = evaluateFinalizeGate(inputs, {
              resultStatus: head?.status ?? null, finalizeRunId: run.runId, seasonSemantics: await seasonSemanticsOf(season, session),
            });
            const reasons = [...gate.reasons];
            if (run.status !== 'SUCCESS' && !reasons.includes('FINALIZE_SYNC_NOT_SUCCESS')) reasons.unshift('FINALIZE_SYNC_NOT_SUCCESS');
            if (gate.allowed && result.status !== 'PROVISIONAL') reasons.push('RESULT_BLOCKED');
            if (reasons.length) {
              throw blocked('FINALIZE_BLOCKED', `finalize blocked: ${reasons.join(', ')}`, {
                reasons, ...gate.details, blockedBy: result.blockedBy,
                run: { id: run.runId, status: run.status, failures: run.failures },
              });
            }
            return { snapshot: buildSnapshotInput({ groupId, season, inputs, result, computedAt: clock() }), newStatus: 'FINAL' };
          },
        });
        return { ...out, run: { id: run.runId, status: run.status } };
      });
    },

    /**
     * POST override (v0.2 §4): admin-declared winners with a note. Allowed at
     * DATA_CHECKED (PROVISIONAL or BLOCKED) or on a FINAL / OVERRIDDEN result.
     * The rule-based result is computed and stored alongside, for the record.
     */
    async override(groupId, season, event, { winners, note }) {
      await requireGroup(groupId, { writable: true });
      const declared = sortIds(new Set(winners));
      if (declared.length !== winners.length) throw new AppError(400, 'VALIDATION_FAILED', 'winners must be distinct', { issues: [{ path: 'winners', message: 'duplicate entry' }] });
      return sync.withGroupLease(groupId, (lease) => runT4({
        lease, groupId, season, event, action: 'OVERRIDE', note,
        plan: async ({ session, head }) => {
          const inputs = await resultRepo.loadResultInputs(groupId, season, event, { session });
          if (!inputs.gate.groupActive) throw new GroupArchivedError(groupId);
          if (!head && inputs.eventState !== 'DATA_CHECKED') {
            throw blocked('OVERRIDE_NOT_ALLOWED', 'an override needs the gameweek at DATA_CHECKED, or an existing final result', { eventState: inputs.eventState });
          }
          const memberIds = new Set(inputs.members.map((m) => m.entryId));
          const outsiders = declared.filter((id) => !memberIds.has(id));
          if (outsiders.length) throw new AppError(422, 'WINNERS_NOT_MEMBERS', `not members of this group: ${outsiders.join(', ')}`, { entryIds: outsiders });
          const result = computeResult(inputs);
          return {
            snapshot: buildSnapshotInput({ groupId, season, inputs, result, kind: 'OVERRIDE', declaredWinnerEntryIds: declared, computedAt: clock() }),
            newStatus: 'OVERRIDDEN',
          };
        },
      }));
    },

    /**
     * POST recompute (v0.2 §4): re-run the rules on a FINAL / OVERRIDDEN result at
     * DATA_CHECKED with clean reconciliation. dryRun returns the diff and writes
     * nothing; a commit that changes the winners needs a note.
     */
    async recompute(groupId, season, event, { dryRun = false, note = null }) {
      await requireGroup(groupId, { writable: true });
      const check = (head, prev, inputs, result) => {
        if (!head) throw blocked('NOT_FINAL', 'only a FINAL or OVERRIDDEN result can be recomputed');
        const reasons = [];
        if (!inputs.gate.groupActive) reasons.push('GROUP_ARCHIVED');
        if (inputs.eventState !== 'DATA_CHECKED') reasons.push('NOT_DATA_CHECKED');
        if (result.status !== 'PROVISIONAL') reasons.push('RECONCILIATION_FAILED');
        if (reasons.length) throw blocked('RECOMPUTE_BLOCKED', `recompute blocked: ${reasons.join(', ')}`, { reasons, blockedBy: result.blockedBy });
        return diffResults(prev, result);
      };
      if (dryRun) {
        const head = await resultRepo.getPointer(groupId, season, event);
        const prev = head ? await resultRepo.getSnapshot(head.currentSnapshotId) : null;
        const inputs = await resultRepo.loadResultInputs(groupId, season, event);
        const result = computeResult(inputs);
        return { dryRun: true, diff: check(head, prev, inputs, result), preview: { winners: result.winners, tieBreakTrace: explainDecision(result), inputsHash: result.inputsHash } };
      }
      return sync.withGroupLease(groupId, (lease) => runT4({
        lease, groupId, season, event, action: 'RECOMPUTE', note,
        plan: async ({ session, head, prev }) => {
          const inputs = await resultRepo.loadResultInputs(groupId, season, event, { session });
          const result = computeResult(inputs);
          const diff = check(head, prev, inputs, result);
          if (diff.winnersChanged && !note) throw new AppError(400, 'NOTE_REQUIRED', 'a recompute that changes the winners needs a note', diff);
          return { snapshot: buildSnapshotInput({ groupId, season, inputs, result, computedAt: clock() }), newStatus: 'FINAL' };
        },
      }));
    },

    /** The GW's decision history in chain order. */
    async listActions(groupId, season, event) {
      await requireGroup(groupId);
      return resultRepo.listActions(groupId, season, event);
    },

    async verifyChain(groupId, season, event) {
      await requireGroup(groupId);
      return resultRepo.verifyChain(groupId, season, event);
    },

    /** A snapshot, if the principal may read its group (else NOT_FOUND). */
    async getSnapshot(snapshotId, principal) {
      const snap = await resultRepo.getSnapshot(snapshotId);
      if (!snap || (principal.role !== 'admin' && principal.groupId !== snap.groupId)) throw new NotFoundError('snapshot', snapshotId);
      return snap;
    },

    /** Stored hash check + recomputation from the stored inputs (v0.2 §9). */
    async verifySnapshot(snapshotId, principal) {
      const snap = await this.getSnapshot(snapshotId, principal);
      return { snapshotId, contentHashValid: snapshotContentHashOf(snap) === snap.contentHash, ...verifySnapshotReproduces(snap, { engineVersion }) };
    },

    /** Provenance trace (v0.3 §8): snapshot → sources → runs → requests → raw responses. */
    async trace(snapshotId, principal) {
      await this.getSnapshot(snapshotId, principal);
      return resultRepo.loadTrace(snapshotId);
    },
  };
}
