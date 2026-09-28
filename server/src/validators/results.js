import { z } from 'zod';
import { fplId, seasonKey } from './groups.js';

// Request validation for the results API (v0.2 §4, §15).
const note = z.string().trim().min(3).max(280);

export const seasonQuery = z.object({ season: seasonKey });
export const finalizeBody = z.strictObject({ season: seasonKey });
export const overrideBody = z.strictObject({ season: seasonKey, winners: z.array(fplId).min(1).max(50), note });
export const recomputeBody = z.strictObject({ season: seasonKey, dryRun: z.boolean().default(false), note: note.optional() });
export const gwParam = z.number().int().min(1).max(38);
