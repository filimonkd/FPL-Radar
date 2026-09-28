import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, defineModel } from './shared.js';
import { RAW_REASONS, SHA256 } from './enums.js';

export const MAX_RAW_BYTES = 2 * 1024 * 1024; // bodies over 2 MB raw are never stored (v0.3 §9)

const fplRawResponseSchema = new Schema({
  syncRunId: { type: Schema.Types.ObjectId, default: null },
  path: { type: String, required: true },
  httpStatus: intField({ default: null }),
  contentType: { type: String, default: null },
  bodyGzip: { type: Buffer, required: true },
  bodySha256: { type: String, required: true, match: SHA256 },
  bytesRaw: intField({ required: true, min: 0, max: MAX_RAW_BYTES }),
  bytesStored: intField({ required: true, min: 0 }),
  reason: { type: String, enum: RAW_REASONS, required: true },
  retainedBySnapshotIds: { type: [Schema.Types.ObjectId], default: [] },
  expireAt: { type: Date },
  capturedAt: { type: Date, required: true },
}, { ...MODEL_OPTIONS, collection: 'fplRawResponses' });

export const FplRawResponse = defineModel(mongoose, 'FplRawResponse', fplRawResponseSchema);
