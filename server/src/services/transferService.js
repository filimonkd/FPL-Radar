import { ownershipRepo as defaultOwnershipRepo, groupRepo as defaultGroupRepo, eventRepo as defaultEventRepo, NotFoundError } from '../repositories/index.js';
import { purchasePrice, sellingPrice } from '../analytics/playerStats.js';
import { projectPoints, breakEven, transferCheck, FDR_FACTOR, HIT_COST, PROJECTION_GWS } from '../analytics/transfer.js';
import { AppError } from '../errors.js';
import { createPlayersService } from './playersService.js';
import { latestSquads } from './groupSquads.js';

// Transfer simulator reads (Step 20). Always from FPL's current GW: the
// group's "me" squad as last synced, FPL's next-GW expected points and the
// fixtures after it. Read-only; nothing here can make a transfer.

const unprocessable = (code, message) => new AppError(422, code, message);

export function createTransferService({ repos = {}, players } = {}) {
  const ownershipRepo = repos.ownershipRepo ?? defaultOwnershipRepo;
  const groupRepo = repos.groupRepo ?? defaultGroupRepo;
  const eventRepo = repos.eventRepo ?? defaultEventRepo;
  const playersService = players ?? createPlayersService({ repos });

  async function load(groupId, season) {
    const g = await groupRepo.getById(groupId);
    if (!g) throw new NotFoundError('group', groupId);
    if (g.myEntryId == null) throw unprocessable('ME_NOT_SET', 'set "me" in the group settings to use the transfer simulator');
    const events = await eventRepo.listBySeason(season);
    const current = events.find((e) => e.isCurrent)?.gw ?? null;
    if (current == null) throw unprocessable('NO_CURRENT_GW', `no current gameweek known for ${season} yet`);
    const [loaded, transfers, view] = await Promise.all([
      ownershipRepo.loadRivalInputs(groupId, season, current),
      ownershipRepo.loadTransfers(groupId, season, current),
      playersService.getPlayers(season, current),
    ]);
    const mine = latestSquads(loaded.squads).find((q) => q.entryId === g.myEntryId);
    if (!mine) throw unprocessable('NO_SQUAD', 'no synced squad for "me" yet: sync a gameweek first');
    const byId = new Map(view.players.map((p) => [p.elementId, p]));
    const myTransfers = transfers.transfers.get(g.myEntryId) ?? [];
    const row = loaded.rows.find((r) => r.entryId === g.myEntryId && r.event === mine.event);
    const picks = loaded.squads.find((q) => q.entryId === g.myEntryId && q.event === mine.event).picks;
    const squad = picks.map((pick) => {
      const p = byId.get(pick.elementId);
      const purchaseTenths = p ? purchasePrice(pick.elementId, myTransfers, p.startPriceTenths) : null;
      return {
        ...(p ?? { elementId: pick.elementId, webName: null, teamId: null, team: null, position: null, priceTenths: null }),
        squadPosition: pick.squadPosition,
        purchaseTenths,
        sellingTenths: sellingPrice(purchaseTenths, p?.priceTenths ?? null),
      };
    }).sort((a, b) => a.squadPosition - b.squadPosition);
    const fixtures = events.flatMap((e) => e.fixtures.map((f) => ({ event: e.gw, teamH: f.teamH, teamA: f.teamA, teamHFdr: f.teamHFdr ?? null, teamAFdr: f.teamAFdr ?? null })));
    return {
      plan: {
        groupId, season, event: current, myEntryId: g.myEntryId, squadEvent: mine.event, bankTenths: row?.bankTenths ?? null, asOf: view.asOf, squad,
        rules: { fdrFactor: FDR_FACTOR, hitCost: HIT_COST, projectionGws: PROJECTION_GWS },
      },
      byId,
      fixtures,
    };
  }

  const slim = (p) => ({
    elementId: p.elementId, webName: p.webName, team: p.team, teamId: p.teamId, position: p.position, status: p.status, chanceNext: p.chanceNext,
    priceTenths: p.priceTenths, epNextTenths: p.epNextTenths, formTenths: p.formTenths, last: p.last, fixtures: p.fixtures,
    ...(p.sellingTenths !== undefined ? { purchaseTenths: p.purchaseTenths, sellingTenths: p.sellingTenths } : {}),
  });

  return {
    /** My latest squad with estimated selling prices, the bank and the rules the simulator uses. */
    async plan(groupId, season) {
      const { plan } = await load(groupId, season);
      return { ...plan, squad: plan.squad.map(slim) };
    },

    /** One transfer: money and rule checks plus the projected break-even. */
    async simulate(groupId, season, { outId, inId, hit = true }) {
      const { plan, byId, fixtures } = await load(groupId, season);
      const out = plan.squad.find((p) => p.elementId === outId);
      if (!out) throw unprocessable('NOT_IN_SQUAD', `player ${outId} is not in your latest synced squad`);
      const buy = byId.get(inId);
      if (!buy) throw new NotFoundError('player', inId);
      const check = transferCheck({ squad: plan.squad, out, in: buy, bankTenths: plan.bankTenths });
      const projection = breakEven(projectPoints(out, fixtures, plan.event), projectPoints(buy, fixtures, plan.event), { hit });
      return { season, event: plan.event, squadEvent: plan.squadEvent, bankTenths: plan.bankTenths, out: slim(out), in: slim(buy), check, projection, rules: plan.rules };
    },
  };
}
