import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, provenanceSchema, defineModel } from './shared.js';
import { deterministicId } from './plugins/deterministicId.js';
import { SEASON_RE } from './enums.js';
import { ids } from '../db/ids.js';

const playerSchema = new Schema({
  _id: String, // '2026-27:351'
  season: { type: String, required: true, match: SEASON_RE },
  elementId: intField({ required: true, min: 1 }),
  webName: { type: String, required: true },
  teamId: intField({ required: true, min: 1 }),
  elementType: intField({ required: true, min: 1, max: 4 }),
  priceTenths: intField({ required: true, min: 0 }), // FPL now_cost
  status: { type: String, default: null },
  epNextTenths: intField({ default: null }), // FPL ep_next ×10 (expected points next GW)
  // Step 17 player intel from bootstrap (null = not reported). Tenths for FPL's decimal strings.
  news: { type: String, default: null },
  newsAdded: { type: Date, default: null },
  chanceNext: intField({ default: null, min: 0, max: 100 }),
  selectedByTenths: intField({ default: null }),
  formTenths: intField({ default: null }),
  ppgTenths: intField({ default: null }),
  totalPoints: intField({ default: null }),
  minutes: intField({ default: null }),
  costChangeEventTenths: intField({ default: null }),
  costChangeStartTenths: intField({ default: null }),
  transfersInEvent: intField({ default: null }),
  transfersOutEvent: intField({ default: null }),
  provenance: { type: provenanceSchema, required: true },
}, { ...MODEL_OPTIONS, collection: 'players' });

playerSchema.plugin(deterministicId, (d) => ids.player(d.season, d.elementId));

export const Player = defineModel(mongoose, 'Player', playerSchema);
