import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, provenanceSchema, defineModel } from './shared.js';
import { deterministicId } from './plugins/deterministicId.js';
import { SEASON_RE } from './enums.js';
import { ids } from '../db/ids.js';

const liveGameweekSchema = new Schema({
  _id: String, // '2026-27:5'
  season: { type: String, required: true, match: SEASON_RE },
  gw: intField({ required: true, min: 1, max: 38 }),
  elements: {
    type: [new Schema({
      elementId: intField({ required: true, min: 1 }),
      totalPoints: intField({ required: true }),
      minutes: intField({ required: true, min: 0 }),
      settled: { type: Boolean, required: true },
    }, { _id: false, strict: 'throw' })],
    default: [],
  },
  provenance: { type: provenanceSchema, required: true },
}, { ...MODEL_OPTIONS, collection: 'liveGameweeks' });

liveGameweekSchema.plugin(deterministicId, (d) => ids.liveGameweek(d.season, d.gw));

export const LiveGameweek = defineModel(mongoose, 'LiveGameweek', liveGameweekSchema);
