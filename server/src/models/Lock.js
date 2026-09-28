import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, defineModel } from './shared.js';

// Lease lock documents (v0.3 §5). Acquire/heartbeat/fence/release arrive with
// lockRepo in Step 5; this is only the document shape.
const lockSchema = new Schema({
  _id: { type: String, required: true, match: /^[a-z]+(:[a-z]+)*(:.+)?$/ }, // 'sync:group:<id>', 'migrate'
  owner: { type: Schema.Types.ObjectId, default: null },
  fencingToken: intField({ default: 0, min: 0 }),
  expiresAt: { type: Date, required: true },
  acquiredAt: { type: Date, default: null },
  heartbeatAt: { type: Date, default: null },
  lastWriteAt: { type: Date, default: null },
}, { ...MODEL_OPTIONS, collection: 'locks' });

export const Lock = defineModel(mongoose, 'Lock', lockSchema);
