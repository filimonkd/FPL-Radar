import { z } from 'zod';
import { WinnerRule } from '../analytics/constants.js';
import { CONFIRMED_TIE_BREAK_RULES } from '../analytics/tieBreakers.js';

// Request validation for the group API (zod 4). Only request shape is checked
// here; business rules (league access, membership, archive state) live in the
// group service, and document rules are enforced again by the models and the
// $jsonSchema validators.

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const INT32_MAX = 2 ** 31 - 1;
// FPL entry and league IDs are positive integers (never ObjectIds, v0.3 §12).
export const fplId = z.number().int().min(1).max(INT32_MAX);
export const objectIdParam = z.string().regex(/^[a-f0-9]{24}$/);
export const seasonKey = z.string().regex(/^\d{4}-\d{2}$/);

const name = z.string().trim().min(1).max(60);
const winnerRule = z.enum(Object.values(WinnerRule));
// Only architecture-documented rules; SHARED-last / uniqueness is checked by the model.
const tieBreakRules = z.array(z.enum(CONFIRMED_TIE_BREAK_RULES)).min(1).max(CONFIRMED_TIE_BREAK_RULES.length);
const entryIds = z.array(fplId).min(1).max(50);

export const createGroupBody = z.strictObject({
  name,
  slug: z.string().max(60).regex(SLUG).optional(),
  memberSource: z.enum(['LEAGUE_STANDINGS', 'MANUAL']),
  // For MANUAL groups the league ID may be kept as a label (v0.2 §10).
  fplLeagueId: fplId.nullable().optional(),
  entryIds: entryIds.optional(),
  winnerRule,
  tieBreakRules: tieBreakRules.optional(),
  myEntryId: fplId.nullable().optional(),
}).superRefine((b, ctx) => {
  if (b.memberSource === 'LEAGUE_STANDINGS') {
    if (b.fplLeagueId == null) ctx.addIssue({ code: 'custom', path: ['fplLeagueId'], message: 'required for LEAGUE_STANDINGS' });
    if (b.entryIds) ctx.addIssue({ code: 'custom', path: ['entryIds'], message: 'members of a LEAGUE_STANDINGS group come from the standings' });
  } else if (!b.entryIds) {
    ctx.addIssue({ code: 'custom', path: ['entryIds'], message: 'required for MANUAL' });
  }
});

export const updateGroupBody = z.strictObject({
  name: name.optional(),
  winnerRule: winnerRule.optional(),
  tieBreakRules: tieBreakRules.optional(),
  myEntryId: fplId.nullable().optional(),
  // The documented fallback only: a league group can switch to manual (v0.2 §10).
  memberSource: z.literal('MANUAL').optional(),
}).refine((b) => Object.keys(b).length > 0, 'no fields to update');

export const addMembersBody = z.strictObject({ entryIds });

export const updateMemberBody = z.strictObject({
  isExcluded: z.boolean().optional(),
  joinedEvent: z.number().int().min(1).max(38).nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, 'no fields to update');

export const validateEntriesBody = z.strictObject({ entryIds });

export const syncBody = z.strictObject({
  season: seasonKey,
  event: z.number().int().min(1).max(38),
});

export const listQuery = z.object({ includeArchived: z.enum(['true', 'false']).optional() });

export const loginBody = z.strictObject({ password: z.string().min(1).max(256) });

export const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
