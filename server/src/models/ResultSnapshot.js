import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, defineModel } from './shared.js';
import { appendOnly } from './plugins/appendOnly.js';
import { SNAPSHOT_KINDS, WINNER_RULES, EVENT_STATES, SEASON_RE, SHA256 } from './enums.js';

const resultSnapshotSchema = new Schema({
  groupId: { type: Schema.Types.ObjectId, required: true },
  season: { type: String, required: true, match: SEASON_RE },
  event: intField({ required: true, min: 1, max: 38 }),
  kind: { type: String, enum: SNAPSHOT_KINDS, required: true },
  winnerRule: { type: String, enum: WINNER_RULES, required: true },
  tieBreakRules: { type: [String], required: true },
  computedWinnerEntryIds: { type: [Number], required: true }, // what the rules said
  declaredWinnerEntryIds: { type: [Number], required: true }, // = computed unless OVERRIDE
  winningScore: intField({ default: null }),
  tieBreakApplied: { type: String, default: null },
  tieBreakTrace: { type: Schema.Types.Mixed, required: true },
  standings: { type: Schema.Types.Mixed, required: true },
  inputs: { type: Schema.Types.Mixed, required: true },
  inputsHash: { type: String, required: true, match: SHA256 },
  eventState: { type: String, enum: EVENT_STATES, required: true },
  engineVersion: { type: String, required: true },
  warnings: { type: [Schema.Types.Mixed], default: [] },
  sources: {
    type: [new Schema({
      syncRunId: { type: Schema.Types.ObjectId, required: true },
      startedAt: { type: Date, required: true },
      status: { type: String, required: true },
      requestHashes: { type: [String], default: [] },
    }, { _id: false, strict: 'throw' })],
    default: [],
  },
  contentHash: { type: String, required: true, match: SHA256 },
  computedAt: { type: Date, required: true },
}, { ...MODEL_OPTIONS, collection: 'resultSnapshots' });

resultSnapshotSchema.plugin(appendOnly);

export const ResultSnapshot = defineModel(mongoose, 'ResultSnapshot', resultSnapshotSchema);
