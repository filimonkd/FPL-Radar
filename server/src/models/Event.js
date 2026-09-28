import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, provenanceSchema, fixtureSchema, defineModel } from './shared.js';
import { deterministicId } from './plugins/deterministicId.js';
import { EVENT_STATES, SEASON_RE } from './enums.js';
import { ids } from '../db/ids.js';

const eventSchema = new Schema({
  _id: String, // '2026-27:5'
  season: { type: String, required: true, match: SEASON_RE },
  gw: intField({ required: true, min: 1, max: 38 }),
  deadlineTime: { type: Date, required: true },
  isCurrent: { type: Boolean, required: true },
  isNext: { type: Boolean, required: true },
  finished: { type: Boolean, required: true },
  dataChecked: { type: Boolean, required: true },
  state: { type: String, required: true, enum: EVENT_STATES },
  dataCheckedObservedAt: { type: Date, default: null },
  fixtures: { type: [fixtureSchema], default: [] },
  provenance: { type: provenanceSchema, required: true },
}, { ...MODEL_OPTIONS, collection: 'events' });

eventSchema.plugin(deterministicId, (d) => ids.event(d.season, d.gw));

export const Event = defineModel(mongoose, 'Event', eventSchema);
