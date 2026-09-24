import { PointsSemantics as PS, ReconciliationStatus as RS, EventState } from './constants.js';

// Point reconciliation (architecture v0.2 §2). Pure; never throws on bad data.
//
//   Δ = T − Tprev      H_gross: Δ = R − C      H_net: Δ = R
//
// Rows are keyed on event (never array index). Net/gross points are produced
// only when the reported points, transfer cost and season-total change agree.

function hypothesisOf(gross, net) {
  if (gross && net) return 'BOTH';
  if (gross) return 'GROSS';
  if (net) return 'NET';
  return 'NONE';
}

/**
 * @param {{ season: string, entryId?: number,
 *   historyRows: { event: number, points: number, eventTransfersCost: number, totalPoints: number }[],
 *   picksPoints?: Map<number, number|null>, seasonSemantics: string, eventStates?: Map<number, string> }} input
 */
export function reconcileSeason({ season, entryId = null, historyRows, picksPoints = new Map(), seasonSemantics, eventStates = new Map() }) {
  const rows = [...historyRows].sort((a, b) => a.event - b.event);
  const byEvent = new Map(rows.map((r) => [r.event, r]));
  const firstEvent = rows[0]?.event;

  // Evaluate the hypotheses for every row first: an UNVERIFIED season can still
  // be proven (or found in conflict) by this entry's own hit rows.
  const evaluated = rows.map((row) => {
    const R = row.points;
    const C = row.eventTransfersCost;
    const T = row.totalPoints;
    let tPrev = null;
    if (row.event === firstEvent) tPrev = 0;
    else if (byEvent.has(row.event - 1)) tPrev = byEvent.get(row.event - 1).totalPoints;
    const delta = tPrev === null ? null : T - tPrev;
    const gross = delta !== null && delta === R - C;
    const net = delta !== null && delta === R;
    return { row, R, C, T, tPrev, delta, gross, net };
  });

  const evidence = {
    gross: evaluated.filter((e) => e.C > 0 && e.gross && !e.net).length,
    net: evaluated.filter((e) => e.C > 0 && e.net && !e.gross).length,
  };

  // Semantics applied to hit rows: the verified season value, else what this
  // entry's rows prove on their own (conflicting proofs → conflict).
  let applied = seasonSemantics;
  if (seasonSemantics === PS.UNVERIFIED) {
    if (evidence.gross > 0 && evidence.net > 0) applied = PS.CONFLICTED;
    else if (evidence.gross > 0) applied = PS.GROSS_BEFORE_HITS;
    else if (evidence.net > 0) applied = PS.NET_AFTER_HITS;
  }

  const out = evaluated.map(({ row, R, C, T, tPrev, delta, gross, net }) => {
    const picksPointsValue = picksPoints.get(row.event) ?? null;
    const base = {
      entryId,
      season,
      event: row.event,
      reportedGwPoints: R,
      transferCost: C,
      totalPoints: T,
      previousTotalPoints: tPrev,
      pointsSemantics: C > 0 ? applied : seasonSemantics,
      reconciliationDetail: { delta, hypothesis: hypothesisOf(gross, net), picksPoints: picksPointsValue },
    };
    const unreconciled = (status) => ({ ...base, netGwPoints: null, grossGwPoints: null, reconciliationStatus: status });

    if (tPrev === null) return unreconciled(RS.INCOMPLETE);
    if (
      picksPointsValue !== null &&
      picksPointsValue !== R &&
      eventStates.get(row.event) === EventState.DATA_CHECKED
    ) {
      return unreconciled(RS.SOURCE_DISAGREEMENT);
    }
    if (C === 0) {
      return net
        ? { ...base, netGwPoints: R, grossGwPoints: R, reconciliationStatus: RS.RECONCILED_NO_COST }
        : unreconciled(RS.MISMATCH);
    }
    const rowEvidence = gross && !net ? PS.GROSS_BEFORE_HITS : net && !gross ? PS.NET_AFTER_HITS : null;
    if (rowEvidence === null) return unreconciled(RS.MISMATCH);
    if (applied === PS.CONFLICTED || rowEvidence !== applied) return unreconciled(RS.SEMANTICS_CONFLICT);
    return rowEvidence === PS.GROSS_BEFORE_HITS
      ? { ...base, netGwPoints: R - C, grossGwPoints: R, reconciliationStatus: RS.RECONCILED }
      : { ...base, netGwPoints: R, grossGwPoints: R + C, reconciliationStatus: RS.RECONCILED };
  });

  return { rows: out, evidence };
}
