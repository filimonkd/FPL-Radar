import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, defineModel } from './shared.js';
import { deterministicId } from './plugins/deterministicId.js';
import { RESULT_STATUSES, SEASON_RE, SHA256 } from './enums.js';
import { ids } from '../db/ids.js';

// The only mutable result document: a pointer moved under optimistic
// concurrency on headSeq (v0.3 §7).
const gwResultSchema = new Schema({
  _id: String, // `${groupId}:${season}:${event}`
  groupId: { type: Schema.Types.ObjectId, required: true },
  season: { type: String, required: true, match: SEASON_RE },
  event: intField({ required: true, min: 1, max: 38 }),
  status: { type: String, enum: RESULT_STATUSES, required: true },
  currentSnapshotId: { type: Schema.Types.ObjectId, required: true },
  headSeq: intField({ required: true, min: 1 }),
  headHash: { type: String, required: true, match: SHA256 },
  updatedAt: { type: Date, required: true },
}, { ...MODEL_OPTIONS, collection: 'gwResults' });

gwResultSchema.plugin(deterministicId, (d) => ids.gwResult(String(d.groupId), d.season, d.event));

export const GwResult = defineModel(mongoose, 'GwResult', gwResultSchema);
