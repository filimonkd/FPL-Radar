import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, provenanceSchema, fixtureSchema, defineModel } from './shared.js';
import { deterministicId } from './plugins/deterministicId.js';
import { CHIP_RULE_SOURCES, POINTS_SEMANTICS, SEASON_RE } from './enums.js';
import { ids } from '../db/ids.js';

const teamSchema = new Schema({
  id: intField({ required: true }),
  name: { type: String, required: true },
  shortName: { type: String, required: true },
}, { _id: false, strict: 'throw' });

const chipRuleSchema = new Schema({
  chipName: { type: String, required: true },
  startEvent: intField({ required: true, min: 1, max: 38 }),
  stopEvent: intField({ required: true, min: 1, max: 38 }),
  number: intField({ required: true, min: 1 }),
  chipType: { type: String, default: null },
}, { _id: false, strict: 'throw' });

const seasonSchema = new Schema({
  _id: { type: String, match: SEASON_RE }, // '2026-27'
  season: { type: String, required: true, match: SEASON_RE },
  teams: { type: [teamSchema], default: [] },
  chipRules: {
    type: new Schema({
      source: { type: String, enum: CHIP_RULE_SOURCES, required: true },
      rules: { type: [chipRuleSchema], default: [] },
      provenance: { type: provenanceSchema, required: true },
    }, { _id: false, strict: 'throw' }),
    required: true,
  },
  // Stays UNVERIFIED until a real C > 0 row proves it; CONFLICTED blocks (v0.2 §2).
  pointsSemantics: {
    type: new Schema({
      value: { type: String, enum: POINTS_SEMANTICS, default: 'UNVERIFIED' },
      evidenceRows: intField({ default: 0, min: 0 }),
      conflictRows: intField({ default: 0, min: 0 }),
      firstVerifiedRunId: { type: Schema.Types.ObjectId, default: null },
    }, { _id: false, strict: 'throw' }),
    default: () => ({}),
  },
  unscheduledFixtures: { type: [fixtureSchema], default: [] },
  provenance: { type: provenanceSchema, required: true },
}, { ...MODEL_OPTIONS, collection: 'seasons' });

seasonSchema.plugin(deterministicId, (d) => ids.season(d.season));

export const Season = defineModel(mongoose, 'Season', seasonSchema);
