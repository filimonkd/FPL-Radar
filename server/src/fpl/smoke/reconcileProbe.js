// Evaluates the v0.2 §2 point-reconciliation hypotheses over one entry's
// history.current rows. This only gathers smoke-test evidence; the production
// reconciler (reconcileSeason) is built in Step 3.
//
//   Δ = T − Tprev      H_gross: Δ = R − C      H_net: Δ = R

export function evaluateHistory(currentRows) {
  const rows = [...currentRows].sort((a, b) => a.event - b.event);
  const byEvent = new Map(rows.map((r) => [r.event, r]));
  const firstEvent = rows[0]?.event;

  const evaluated = rows.map((row) => {
    const R = row.points;
    const C = row.event_transfers_cost;
    const T = row.total_points;
    let tPrev;
    if (row.event === firstEvent) tPrev = 0;
    else if (byEvent.has(row.event - 1)) tPrev = byEvent.get(row.event - 1).total_points;
    else return { event: row.event, R, C, T, tPrev: null, outcome: 'INCOMPLETE' };

    const delta = T - tPrev;
    const gross = delta === R - C;
    const net = delta === R;
    let outcome;
    if (C === 0) outcome = net ? 'NO_COST' : 'MISMATCH';
    else if (gross && !net) outcome = 'GROSS';
    else if (net && !gross) outcome = 'NET';
    else outcome = 'MISMATCH';
    return { event: row.event, R, C, T, tPrev, delta, outcome };
  });

  const count = (o) => evaluated.filter((r) => r.outcome === o).length;
  const evidence = { gross: count('GROSS'), net: count('NET'), noCost: count('NO_COST'), mismatch: count('MISMATCH'), incomplete: count('INCOMPLETE') };
  let semantics = 'UNVERIFIED';
  if (evidence.gross > 0 && evidence.net > 0) semantics = 'CONFLICTED';
  else if (evidence.gross > 0) semantics = 'GROSS_BEFORE_HITS';
  else if (evidence.net > 0) semantics = 'NET_AFTER_HITS';
  return { rows: evaluated, evidence, semantics };
}

// Combines per-entry results into season-level semantics.
export function combineSemantics(results) {
  const total = { gross: 0, net: 0, noCost: 0, mismatch: 0, incomplete: 0 };
  for (const r of results) for (const k of Object.keys(total)) total[k] += r.evidence[k];
  let semantics = 'UNVERIFIED';
  if (total.gross > 0 && total.net > 0) semantics = 'CONFLICTED';
  else if (total.gross > 0) semantics = 'GROSS_BEFORE_HITS';
  else if (total.net > 0) semantics = 'NET_AFTER_HITS';
  return { evidence: total, semantics };
}
