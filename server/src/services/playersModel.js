import { pointsOver, rotationRisk, fixtureRun, startPrice } from '../analytics/playerStats.js';

// Loaded season data → the players view (Step 17): every FPL player with the
// news/intel fields, recent points and minutes, rotation risk and the next
// fixtures. Pure; the service loads, this shapes. Form windows run over
// finished GWs only, so a GW in progress never reads as a bad week.

export const POSITIONS = Object.freeze({ 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' });
export const FORM_WINDOWS = Object.freeze([3, 5, 10]);

/**
 * @param {{ season: string, event: number, events: object[], teams: object[], players: object[], live: object[] }} loaded
 */
export function buildPlayersView({ season, event, events, teams, players, live }) {
  const statsThrough = events.filter((e) => e.gw <= event && e.finished).reduce((m, e) => Math.max(m, e.gw), 0);
  const current = events.find((e) => e.gw === event) ?? null;

  const fixtures = events.flatMap((e) => e.fixtures.map((f) => ({ event: e.gw, teamH: f.teamH, teamA: f.teamA, teamHFdr: f.teamHFdr ?? null, teamAFdr: f.teamAFdr ?? null })));
  const perTeamGw = new Map();
  for (const f of fixtures) {
    for (const t of [f.teamH, f.teamA]) perTeamGw.set(`${t}:${f.event}`, (perTeamGw.get(`${t}:${f.event}`) ?? 0) + 1);
  }

  const history = new Map();
  for (const l of live) {
    if (l.gw > statsThrough) continue;
    for (const e of l.elements) {
      if (!history.has(e.elementId)) history.set(e.elementId, []);
      history.get(e.elementId).push({ gw: l.gw, points: e.totalPoints, minutes: e.minutes });
    }
  }

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const view = [...players].sort((a, b) => a.elementId - b.elementId).map((p) => {
    const h = history.get(p.elementId) ?? [];
    const games = (gw) => perTeamGw.get(`${p.teamId}:${gw}`) ?? 0;
    return {
      elementId: p.elementId,
      webName: p.webName,
      teamId: p.teamId,
      team: teamById.get(p.teamId)?.shortName ?? null,
      position: POSITIONS[p.elementType] ?? null,
      priceTenths: p.priceTenths,
      startPriceTenths: startPrice(p.priceTenths, p.costChangeStartTenths ?? null),
      costChangeEventTenths: p.costChangeEventTenths ?? null,
      status: p.status ?? null,
      news: p.news ?? null,
      newsAdded: p.newsAdded ?? null,
      chanceNext: p.chanceNext ?? null,
      selectedByTenths: p.selectedByTenths ?? null,
      formTenths: p.formTenths ?? null,
      ppgTenths: p.ppgTenths ?? null,
      epNextTenths: p.epNextTenths ?? null,
      totalPoints: p.totalPoints ?? null,
      minutes: p.minutes ?? null,
      transfersInEvent: p.transfersInEvent ?? null,
      transfersOutEvent: p.transfersOutEvent ?? null,
      last: Object.fromEntries(FORM_WINDOWS.map((n) => [n, pointsOver(h, statsThrough, n)])),
      rotation: rotationRisk(h, statsThrough, games),
      fixtures: fixtureRun(p.teamId, fixtures, event),
    };
  });

  return {
    season,
    event,
    eventState: current?.state ?? null,
    statsThrough,
    historyGws: [...new Set(live.filter((l) => l.gw <= statsThrough).map((l) => l.gw))].sort((a, b) => a - b),
    teams: [...teams].sort((a, b) => a.id - b.id).map((t) => ({ id: t.id, name: t.name, shortName: t.shortName })),
    players: view,
  };
}
