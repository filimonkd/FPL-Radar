import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, defineModel } from './shared.js';
import { SYNC_TRIGGERS, SYNC_STATUSES, SEASON_RE } from './enums.js';

export const MAX_REQUESTS_PER_RUN = 300; // past this the run records REQUEST_LOG_TRUNCATED (v0.3 §8)

const syncRunSchema = new Schema({
  job: { type: String, required: true },
  target: { type: String, default: null }, // groupId or 'bootstrap'
  season: { type: String, match: SEASON_RE, default: null },
  event: intField({ min: 1, max: 38, default: null }),
  trigger: { type: String, enum: SYNC_TRIGGERS, required: true },
  status: { type: String, enum: SYNC_STATUSES, required: true },
  lockId: { type: String, default: null },
  lockFencingToken: intField({ default: null }),
  requests: {
    type: [new Schema({
      path: { type: String, required: true },
      httpStatus: intField({ default: null }),
      bodySha256: { type: String, default: null },
      bytes: intField({ default: null }),
      durationMs: intField({ required: true, min: 0 }),
      schemaOk: { type: Boolean, default: null },
      fromCache: { type: Boolean, default: false },
      rawResponseId: { type: Schema.Types.ObjectId, default: null },
    }, { _id: false, strict: 'throw' })],
    default: [],
  },
  failures: { type: [new Schema({ entryId: intField({ default: null }), code: String, message: String }, { _id: false, strict: 'throw' })], default: [] },
  warnings: { type: [new Schema({ code: { type: String, required: true }, detail: Schema.Types.Mixed }, { _id: false, strict: 'throw' })], default: [] },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date, default: null },
  expireAt: { type: Date }, // absent = retained permanently (TTL, v0.3 §9)
}, { ...MODEL_OPTIONS, collection: 'syncRuns' });

syncRunSchema.path('requests').validate((r) => r.length <= MAX_REQUESTS_PER_RUN, `at most ${MAX_REQUESTS_PER_RUN} request log entries`);

export const SyncRun = defineModel(mongoose, 'SyncRun', syncRunSchema);
