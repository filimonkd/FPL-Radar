import { Schema } from 'mongoose';
import { SHA256 } from './enums.js';
import { defaultMaxTime } from '../db/queryDefaults.js';

// Shared sub-schemas and options (architecture v0.3 §12).

export const MODEL_OPTIONS = Object.freeze({ strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false });

export const intField = (extra = {}) => ({
  type: Number,
  validate: { validator: (v) => v === null || v === undefined || Number.isInteger(v), message: '{PATH} must be an integer' },
  ...extra,
});

export const provenanceSchema = new Schema({
  lastConfirmedByRunId: { type: Schema.Types.ObjectId, required: true },
  lastConfirmedAt: { type: Date, required: true },
  lastChangedByRunId: { type: Schema.Types.ObjectId, required: true },
  lastChangedAt: { type: Date, required: true },
  contentHash: { type: String, required: true, match: SHA256 },
  sourceRequests: { type: Map, of: String, default: {} }, // role -> bodySha256
  settled: { type: Boolean, default: false },
}, { _id: false, strict: 'throw' });

export const fixtureSchema = new Schema({
  id: intField({ required: true }),
  teamH: intField({ required: true }),
  teamA: intField({ required: true }),
  teamHFdr: intField({ default: null }),
  teamAFdr: intField({ default: null }),
  kickoffTime: { type: Date, default: null },
  started: { type: Boolean, required: true },
  finished: { type: Boolean, required: true },
  finishedProvisional: { type: Boolean, required: true },
  teamHScore: intField({ default: null }),
  teamAScore: intField({ default: null }),
}, { _id: false, strict: 'throw' });

// Registers a model once (safe under node --watch and repeated test imports).
export function defineModel(mongoose, name, schema) {
  if (mongoose.models[name]) return mongoose.models[name];
  schema.plugin(defaultMaxTime);
  return mongoose.model(name, schema);
}
