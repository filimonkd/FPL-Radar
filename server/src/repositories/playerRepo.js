import { Player } from '../models/Player.js';
import { playerToDomain, playerToDocument } from './mappers/player.js';
import { upsertSnapshots, requestsFor } from './internal/snapshotUpsert.js';

// players (v0.3 §10): bulk upsert. Unordered, no transaction: each document is
// independent and idempotent (v0.3 §5).

export const playerRepo = {
  async bulkUpsert(players, run, { sourceRequests = {}, session } = {}) {
    return upsertSnapshots(Player, players.map((p) => ({ doc: playerToDocument(p), sourceRequests: requestsFor(sourceRequests, p) })), run, { session, ordered: false });
  },

  async getMany(season, elementIds, { withProvenance = false, session } = {}) {
    const docs = await Player.find({ season, elementId: { $in: elementIds } }).sort({ elementId: 1 }).session(session ?? null).lean();
    return docs.map((d) => playerToDomain(d, { withProvenance }));
  },

  async listBySeason(season, { withProvenance = false, session } = {}) {
    const docs = await Player.find({ season }).sort({ elementId: 1 }).session(session ?? null).lean();
    return docs.map((d) => playerToDomain(d, { withProvenance }));
  },

  /** When a sync last confirmed the season's player data (the latest bootstrap read), or null. */
  async getLastConfirmedAt(season, { session } = {}) {
    const doc = await Player.findOne({ season }, { 'provenance.lastConfirmedAt': 1 }).sort({ 'provenance.lastConfirmedAt': -1 }).session(session ?? null).lean();
    return doc?.provenance?.lastConfirmedAt ?? null;
  },
};
