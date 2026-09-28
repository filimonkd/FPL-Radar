import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, defineModel } from './shared.js';
import { SHA256 } from './enums.js';

const migrationSchema = new Schema({
  _id: { type: String, required: true, match: /^\d{3}_[a-z0-9_]+$/ }, // migration name
  checksum: { type: String, required: true, match: SHA256 },
  appliedAt: { type: Date, required: true },
}, { ...MODEL_OPTIONS, collection: '_migrations' });

export const Migration = defineModel(mongoose, 'Migration', migrationSchema);
