import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, provenanceSchema, defineModel } from './shared.js';
import { deterministicId } from './plugins/deterministicId.js';
import { pickViolations } from './validation/picks.js';
import { POINTS_SEMANTICS, RECONCILIATION_STATUSES, RECONCILED, AUTO_SUB_SOURCES, SEASON_RE } from './enums.js';
import { ids } from '../db/ids.js';

const pickSchema = new Schema({
  elementId: intField({ required: true, min: 1 }),
  squadPosition: intField({ required: true, min: 1, max: 15 }),
  fplMultiplier: intField({ required: true, min: 0, max: 3 }),
  isCaptain: { type: Boolean, required: true },
  isViceCaptain: { type: Boolean, required: true },
}, { _id: false, strict: 'throw' });

const pointsSchema = new Schema({
  reportedGwPoints: intField({ required: true }),
  transferCost: intField({ required: true, min: 0 }),
  netGwPoints: intField({ default: null }),
  grossGwPoints: intField({ default: null }),
  totalPoints: intField({ required: true }),
  previousTotalPoints: intField({ default: null }),
  picksReportedPoints: intField({ default: null }),
  pointsSemantics: { type: String, required: true, enum: POINTS_SEMANTICS },
  reconciliationStatus: { type: String, required: true, enum: RECONCILIATION_STATUSES },
  reconciliationDetail: {
    type: new Schema({
      delta: intField({ default: null }),
      hypothesis: { type: String, enum: ['GROSS', 'NET', 'NONE', 'BOTH'], required: true },
      picksPoints: intField({ default: null }),
    }, { _id: false, strict: 'throw' }),
    required: true,
  },
}, { _id: false, strict: 'throw' });

// net/gross are null unless reconciled (v0.2 §2 CHECK constraint → hook + $jsonSchema oneOf).
pointsSchema.pre('validate', async function checkReconciledNullability() {
  const ok = RECONCILED.includes(this.reconciliationStatus);
  const consistent = ok ? this.netGwPoints != null && this.grossGwPoints != null
    : this.netGwPoints == null && this.grossGwPoints == null;
  if (!consistent) throw new Error('net/gross must be null unless reconciled');
});

const managerGameweekSchema = new Schema({
  _id: String, // '2026-27:123456:5'
  season: { type: String, required: true, match: SEASON_RE },
  entryId: intField({ required: true, min: 1 }),
  event: intField({ required: true, min: 1, max: 38 }),
  points: { type: pointsSchema, required: true },
  eventTransfers: intField({ default: 0, min: 0 }),
  pointsOnBench: intField({ default: 0, min: 0 }),
  overallRank: intField({ default: null }),
  bankTenths: intField({ default: null }),
  teamValueTenths: intField({ default: null }),
  activeChip: { type: String, default: null },
  hasPicks: { type: Boolean, required: true },
  picks: { type: [pickSchema], default: [] },
  autoSubs: {
    type: [new Schema({
      elementIn: intField({ required: true }),
      elementOut: intField({ required: true }),
      source: { type: String, enum: AUTO_SUB_SOURCES, required: true },
    }, { _id: false, strict: 'throw' })],
    default: [],
  },
  provenance: { type: provenanceSchema, required: true },
}, { ...MODEL_OPTIONS, collection: 'managerGameweeks' });

managerGameweekSchema.plugin(deterministicId, (d) => ids.managerGameweek(d.season, d.entryId, d.event));

managerGameweekSchema.pre('validate', async function checkPicks() {
  if (!this.hasPicks) {
    if (this.picks.length !== 0) throw new Error('picks present but hasPicks=false');
    return;
  }
  const violations = pickViolations(this.picks);
  if (violations.length) throw new Error(`invalid picks: ${violations.join('; ')}`);
});

export const ManagerGameweek = defineModel(mongoose, 'ManagerGameweek', managerGameweekSchema);
