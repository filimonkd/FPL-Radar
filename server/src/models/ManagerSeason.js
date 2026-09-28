import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, provenanceSchema, defineModel } from './shared.js';
import { deterministicId } from './plugins/deterministicId.js';
import { SEASON_RE } from './enums.js';
import { ids } from '../db/ids.js';

const managerSeasonSchema = new Schema({
  _id: String, // '2026-27:123456'
  season: { type: String, required: true, match: SEASON_RE },
  entryId: intField({ required: true, min: 1 }),
  // Full lists from FPL, replaced wholesale each sync (v0.3 §6).
  chips: {
    type: [new Schema({
      name: { type: String, required: true },
      event: intField({ required: true, min: 1, max: 38 }),
      time: { type: Date, default: null },
    }, { _id: false, strict: 'throw' })],
    default: [],
  },
  transfers: {
    type: [new Schema({
      elementIn: intField({ required: true }),
      elementInCostTenths: intField({ required: true, min: 0 }),
      elementOut: intField({ required: true }),
      elementOutCostTenths: intField({ required: true, min: 0 }),
      event: intField({ required: true, min: 1, max: 38 }),
      time: { type: Date, required: true },
    }, { _id: false, strict: 'throw' })],
    default: [],
  },
  provenance: { type: provenanceSchema, required: true },
}, { ...MODEL_OPTIONS, collection: 'managerSeasons' });

managerSeasonSchema.plugin(deterministicId, (d) => ids.managerSeason(d.season, d.entryId));

export const ManagerSeason = defineModel(mongoose, 'ManagerSeason', managerSeasonSchema);
