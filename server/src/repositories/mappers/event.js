import { ids } from '../../db/ids.js';
import { attachProvenance, mapList } from './common.js';

// events ↔ domain event (fixtures embedded, derived state stored, v0.3 §3).

export const fixtureToDomain = (f) => ({
  id: f.id,
  teamH: f.teamH,
  teamA: f.teamA,
  teamHFdr: f.teamHFdr ?? null,
  teamAFdr: f.teamAFdr ?? null,
  kickoffTime: f.kickoffTime ?? null,
  started: f.started,
  finished: f.finished,
  finishedProvisional: f.finishedProvisional,
  teamHScore: f.teamHScore ?? null,
  teamAScore: f.teamAScore ?? null,
});

export const fixtureToDocument = fixtureToDomain;

export function eventToDomain(doc, opts) {
  if (!doc) return null;
  return attachProvenance({
    id: doc._id,
    season: doc.season,
    gw: doc.gw,
    deadlineTime: doc.deadlineTime,
    isCurrent: doc.isCurrent,
    isNext: doc.isNext,
    finished: doc.finished,
    dataChecked: doc.dataChecked,
    state: doc.state,
    dataCheckedObservedAt: doc.dataCheckedObservedAt ?? null,
    fixtures: mapList(doc.fixtures, fixtureToDomain),
  }, doc, opts);
}

export function eventToDocument(e) {
  return {
    _id: ids.event(e.season, e.gw),
    season: e.season,
    gw: e.gw,
    deadlineTime: e.deadlineTime,
    isCurrent: e.isCurrent,
    isNext: e.isNext,
    finished: e.finished,
    dataChecked: e.dataChecked,
    state: e.state,
    dataCheckedObservedAt: e.dataCheckedObservedAt ?? null,
    fixtures: mapList(e.fixtures, fixtureToDocument),
  };
}
