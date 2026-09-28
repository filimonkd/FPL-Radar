import mongoose, { Schema } from 'mongoose';
import { MODEL_OPTIONS, intField, defineModel } from './shared.js';
import { MEMBER_SOURCES, WINNER_RULES, TIE_BREAK_RULES, DEFAULT_TIE_BREAK_RULES } from './enums.js';
import { isValidRuleChain } from '../analytics/tieBreakers.js';

const memberSchema = new Schema({
  entryId: intField({ required: true, min: 1 }),
  isExcluded: { type: Boolean, default: false },
  joinedEvent: intField({ min: 1, max: 38, default: null }),
  leftLeague: { type: Boolean, default: false },
  addedManually: { type: Boolean, default: false },
  addedAt: { type: Date, required: true },
}, { _id: false, strict: 'throw' });

const groupSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  slug: { type: String, required: true, match: /^[a-z0-9]+(-[a-z0-9]+)*$/ },
  memberSource: { type: String, enum: MEMBER_SOURCES, required: true },
  fplLeagueId: intField({ min: 1, default: null }),
  myEntryId: intField({ default: null }),
  winnerRule: { type: String, enum: WINNER_RULES, required: true },
  // Configurable data; only architecture-documented rules, SHARED last (v0.2 §6).
  tieBreakRules: { type: [{ type: String, enum: TIE_BREAK_RULES }], default: () => [...DEFAULT_TIE_BREAK_RULES] },
  shareToken: { type: String, default: null },
  isActive: { type: Boolean, default: true },
  archivedAt: { type: Date, default: null },
  members: { type: [memberSchema], default: [] },
  createdAt: { type: Date, required: true, immutable: true },
  updatedAt: { type: Date, required: true },
}, { ...MODEL_OPTIONS, collection: 'groups' });

groupSchema.path('fplLeagueId').validate(function leagueRequired(v) {
  return this.memberSource === 'MANUAL' || Number.isInteger(v);
}, 'fplLeagueId required for LEAGUE_STANDINGS');
groupSchema.path('members').validate((ms) => new Set(ms.map((m) => m.entryId)).size === ms.length, 'duplicate member');
groupSchema.path('tieBreakRules').validate((r) => isValidRuleChain(r, TIE_BREAK_RULES), 'tieBreakRules must be unique confirmed rules ending with SHARED');
groupSchema.path('archivedAt').validate(function archiveConsistent(v) {
  return this.isActive ? v === null : v instanceof Date;
}, 'archivedAt must be set exactly when the group is archived');

export const Group = defineModel(mongoose, 'Group', groupSchema);
