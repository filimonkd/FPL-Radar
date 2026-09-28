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
  provenance: { type: provenanceSchema, required: true },
}, { ...MODEL_OPTIONS, collection: 'players' });

playerSchema.plugin(deterministicId, (d) => ids.player(d.season, d.elementId));

export const Player = defineModel(mongoose, 'Player', playerSchema);
