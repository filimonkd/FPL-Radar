import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, defineModel } from './shared.js';
import { appendOnly } from './plugins/appendOnly.js';
import { RESULT_ACTIONS, RESULT_PREV_STATUSES, RESULT_STATUSES, SEASON_RE, SHA256 } from './enums.js';

const gwResultActionSchema = new Schema({
  groupId: { type: Schema.Types.ObjectId, required: true },
  season: { type: String, required: true, match: SEASON_RE },
  event: intField({ required: true, min: 1, max: 38 }),
  seq: intField({ required: true, min: 1 }),
  action: { type: String, enum: RESULT_ACTIONS, required: true },
  prevStatus: { type: String, enum: RESULT_PREV_STATUSES, required: true },
  newStatus: { type: String, enum: RESULT_STATUSES, required: true },
  prevWinnerEntryIds: { type: [Number], required: true },
  newWinnerEntryIds: { type: [Number], required: true },
  prevSnapshotId: { type: Schema.Types.ObjectId, default: null },
  newSnapshotId: { type: Schema.Types.ObjectId, required: true },
  newSnapshotHash: { type: String, required: true, match: SHA256 },
  note: { type: String, default: null, maxlength: 280 },
  syncRunId: { type: Schema.Types.ObjectId, default: null },
  actor: { type: String, default: 'admin' },
  prevHash: { type: String, required: true }, // 'GENESIS' for seq 1
  hash: { type: String, required: true, match: SHA256 },
  createdAt: { type: Date, required: true },
}, { ...MODEL_OPTIONS, collection: 'gwResultActions' });

gwResultActionSchema.path('note').validate(function overrideNeedsNote(n) {
  return this.action !== 'OVERRIDE' || (typeof n === 'string' && n.trim().length >= 3);
}, 'override requires a note');
gwResultActionSchema.path('prevHash').validate(function genesis(h) {
  return this.seq === 1 ? h === 'GENESIS' : SHA256.test(h);
}, "prevHash must be 'GENESIS' for seq 1, else a sha256");

gwResultActionSchema.plugin(appendOnly);

export const GwResultAction = defineModel(mongoose, 'GwResultAction', gwResultActionSchema);
