import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, provenanceSchema, defineModel } from './shared.js';
import { deterministicId } from './plugins/deterministicId.js';
import { ids } from '../db/ids.js';

const managerSchema = new Schema({
  _id: intField(), // = entryId
  entryId: intField({ required: true, min: 1 }),
  playerName: { type: String, required: true },
  teamName: { type: String, required: true },
  provenance: { type: provenanceSchema, required: true },
}, { ...MODEL_OPTIONS, collection: 'managers' });

managerSchema.plugin(deterministicId, (d) => ids.manager(d.entryId));

export const Manager = defineModel(mongoose, 'Manager', managerSchema);
