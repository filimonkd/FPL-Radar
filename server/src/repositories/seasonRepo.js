import { Season } from '../models/Season.js';
import { ids } from '../db/ids.js';
import { seasonToDomain, seasonBlockToDocument, chipRulesToDocument, INITIAL_POINTS_SEMANTICS } from './mappers/season.js';
import { snapshotContentHash, toObjectId } from './mappers/common.js';
import { runContext, provenanceStage, hashDiffers } from './internal/snapshotUpsert.js';
import { requireTransaction, sessionOpt } from './internal/session.js';
import { NotFoundError } from './errors.js';

// seasons (v0.3 §10): replace teams + chipRules (T1), and the points-semantics
// evidence update. Teams / unscheduled fixtures and the chip-rule set are two
// separately hashed blocks with their own provenance (v0.3 §8); chip rules are
// always replaced as a whole set (v0.2 §8). pointsSemantics is never touched
// by the T1 write.

const literal = (v) => ({ $literal: v });
const PS = Object.freeze({ UNVERIFIED: 'UNVERIFIED', GROSS: 'GROSS_BEFORE_HITS', NET: 'NET_AFTER_HITS', CONFLICTED: 'CONFLICTED' });

function nonNegativeInt(name, v) {
  if (!Number.isInteger(v) || v < 0) throw new TypeError(`${name} must be a non-negative integer, got ${v}`);
  return v;
}

export const seasonRepo = {
  /**
   * T1: content-hash upsert of { season, teams, unscheduledFixtures } and of
   * chipRules { source, rules }.
   * @param {{ season: string, teams: object[], unscheduledFixtures?: object[], chipRules: { source: string, rules: object[] } }} value
   * @param {{ runId: any, startedAt?: Date, at?: Date }} run
   * @param {{ sourceRequests?: { season?: object, chipRules?: object }, session }} opts
   */
  async replaceTeamsAndChipRules(value, run, { sourceRequests = {}, session } = {}) {
    requireTransaction(session, 'seasonRepo.replaceTeamsAndChipRules');
    const ctx = runContext(run);
    const block = seasonBlockToDocument(value);
    const chipRules = chipRulesToDocument(value.chipRules);
    const seasonRequests = { ...(sourceRequests.season ?? {}) };
    const chipRequests = { ...(sourceRequests.chipRules ?? {}) };
    const placeholder = {
      lastConfirmedByRunId: ctx.runId, lastConfirmedAt: ctx.at, lastChangedByRunId: ctx.runId, lastChangedAt: ctx.at,
      contentHash: `sha256:${'0'.repeat(64)}`, sourceRequests: {}, settled: false,
    };
    const hydrated = new Season({ ...block, chipRules: { ...chipRules, provenance: placeholder }, provenance: placeholder });
    await hydrated.validate();
    const cast = hydrated.toObject({ flattenMaps: true, versionKey: false });
    const seasonData = { season: cast.season, teams: cast.teams, unscheduledFixtures: cast.unscheduledFixtures };
    const chipData = { source: cast.chipRules.source, rules: cast.chipRules.rules };
    const seasonHash = snapshotContentHash(seasonData);
    const chipHash = snapshotContentHash(chipData);

    const before = await Season.findById(block._id, { 'provenance.contentHash': 1, 'chipRules.provenance.contentHash': 1 }).session(session).lean();

    const seasonChanged = hashDiffers('provenance.contentHash', seasonHash);
    const chipChanged = hashDiffers('chipRules.provenance.contentHash', chipHash);
    const $set = {
      season: { $cond: [seasonChanged, literal(seasonData.season), '$season'] },
      teams: { $cond: [seasonChanged, literal(seasonData.teams), '$teams'] },
      unscheduledFixtures: { $cond: [seasonChanged, literal(seasonData.unscheduledFixtures), '$unscheduledFixtures'] },
      chipRules: {
        source: { $cond: [chipChanged, literal(chipData.source), '$chipRules.source'] },
        rules: { $cond: [chipChanged, literal(chipData.rules), '$chipRules.rules'] },
        provenance: provenanceStage('chipRules.provenance', ctx, chipHash, chipChanged, { sourceRequests: chipRequests, settled: false }),
      },
      pointsSemantics: { $ifNull: ['$pointsSemantics', literal({ ...INITIAL_POINTS_SEMANTICS })] },
      provenance: provenanceStage('provenance', ctx, seasonHash, seasonChanged, { sourceRequests: seasonRequests, settled: false }),
    };
    await Season.collection.updateOne({ _id: block._id }, [{ $set }], { upsert: true, session });

    const outcome = (old, next) => (old == null ? 'inserted' : old === next ? 'unchanged' : 'changed');
    return {
      season: outcome(before?.provenance?.contentHash, seasonHash),
      chipRules: outcome(before?.chipRules?.provenance?.contentHash, chipHash),
    };
  },

  /**
   * Applies one sync's semantics evidence atomically (v0.2 §2 season semantics):
   * UNVERIFIED flips to the proven value on its first proving rows (recording
   * firstVerifiedRunId); later rows add to evidenceRows or conflictRows; any
   * conflict makes the season CONFLICTED, which is sticky (counters freeze)
   * until an admin investigates. `gross` / `net` are reconcileSeason().evidence
   * counts. The caller passes counts only for rows this run inserted or
   * changed, so replaying identical responses adds nothing (v0.3 §6).
   */
  async applySemanticsEvidence(season, { gross, net }, runId, { session } = {}) {
    nonNegativeInt('gross', gross);
    nonNegativeInt('net', net);
    const run = toObjectId(runId, 'runId');
    const cur = '$pointsSemantics.value';
    const both = gross > 0 && net > 0;
    const fromUnverified = both ? PS.CONFLICTED : gross > 0 ? PS.GROSS : net > 0 ? PS.NET : PS.UNVERIFIED;
    const addEvidence = { $switch: { branches: [
      { case: { $eq: [cur, PS.UNVERIFIED] }, then: both ? 0 : gross + net },
      { case: { $eq: [cur, PS.GROSS] }, then: gross },
      { case: { $eq: [cur, PS.NET] }, then: net },
    ], default: 0 } };
    const addConflict = { $switch: { branches: [
      { case: { $eq: [cur, PS.UNVERIFIED] }, then: both ? gross + net : 0 },
      { case: { $eq: [cur, PS.GROSS] }, then: net },
      { case: { $eq: [cur, PS.NET] }, then: gross },
    ], default: 0 } };
    const conflictRows = { $add: ['$pointsSemantics.conflictRows', addConflict] };
    const verifiesNow = { $and: [{ $eq: [cur, PS.UNVERIFIED] }, { $in: [literal(fromUnverified), [PS.GROSS, PS.NET]] }] };
    const pipeline = [{
      $set: {
        pointsSemantics: {
          value: { $cond: [{ $gt: [conflictRows, 0] }, literal(PS.CONFLICTED), { $cond: [{ $eq: [cur, PS.UNVERIFIED] }, literal(fromUnverified), cur] }] },
          evidenceRows: { $add: ['$pointsSemantics.evidenceRows', addEvidence] },
          conflictRows,
          firstVerifiedRunId: { $cond: [verifiesNow, run, '$pointsSemantics.firstVerifiedRunId'] },
        },
      },
    }];
    const doc = await Season.findOneAndUpdate({ _id: ids.season(season) }, pipeline, {
      ...sessionOpt(session), updatePipeline: true, returnDocument: 'after', lean: true,
    });
    if (!doc) throw new NotFoundError('season', season);
    return seasonToDomain(doc).pointsSemantics;
  },

  async get(season, { withProvenance = false, session } = {}) {
    return seasonToDomain(await Season.findById(ids.season(season)).session(session ?? null).lean(), { withProvenance });
  },
};
