import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api.js';
import { explain, pct } from '../lib/format.js';
import { useNames } from '../lib/useNames.js';
import { Badge, Button, Card, ErrorBox, Notice, Spinner, Table } from '../components/ui.jsx';

// Ownership / captaincy / transfers (v0.2 §7): picked vs effective, rivals vs
// all, with the denominators and missing managers shown rather than hidden.
export default function Ownership({ group, season, gw }) {
  const [view, setView] = useState(null); // null → the server's default view
  const [scope, setScope] = useState('rivals');
  const own = useQuery({ queryKey: ['ownership', group.id, season, gw, view], queryFn: () => endpoints.ownership(group.id, gw, season, view ?? undefined) });
  const transfers = useQuery({ queryKey: ['ownership', group.id, season, gw, 'transfers'], queryFn: () => endpoints.transfers(group.id, gw, season) });
  const name = useNames(group, season, gw);
  if (own.isLoading) return <Spinner />;
  if (own.error) return <ErrorBox error={own.error} title="Ownership unavailable" />;
  const o = own.data.ownership;
  const effective = o.view === 'effective';
  const hasRivals = o.myEntryId != null;
  const sc = hasRivals ? scope : 'all';
  const rows = [...o.rows].sort((a, b) => (effective ? b.effectiveEo[sc] - a.effectiveEo[sc] : b.pickedEo[sc] - a.pickedEo[sc]) || b.pickedSquad[sc].count - a.pickedSquad[sc].count || a.player.id - b.player.id);

  return (
    <div className="space-y-4">
      <Card
        title="Ownership"
        actions={(
          <>
            <div className="inline-flex rounded-md ring-1 ring-slate-300" role="group" aria-label="View">
              {['picked', 'effective'].map((v) => <Button key={v} variant={o.view === v ? 'primary' : 'ghost'} onClick={() => setView(v)} data-testid={`view-${v}`}>{v === 'picked' ? 'Picked' : 'Effective'}</Button>)}
            </div>
            {hasRivals && (
              <div className="inline-flex rounded-md ring-1 ring-slate-300" role="group" aria-label="Scope">
                {['rivals', 'all'].map((v) => <Button key={v} variant={sc === v ? 'primary' : 'ghost'} onClick={() => setScope(v)}>{v === 'rivals' ? 'Rivals' : 'Everyone'}</Button>)}
              </div>
            )}
          </>
        )}
      >
        <p className="text-sm text-slate-600" data-testid="denominators">
          {effective ? 'Effective: what actually scored, after auto-subs, chips and captain failure.' : 'Picked: the team as submitted at the deadline.'}
          {' '}Out of {o.denominators[sc]} {sc === 'rivals' ? 'rivals' : 'managers'}{hasRivals ? '' : ' (set “Me” in Settings to see rivals only)'}.
        </p>
        {effective && o.effectiveProvisional && <Notice>Effective numbers are provisional until the gameweek is data-checked.</Notice>}
        {o.missingEntryIds.length > 0 && <Notice testId="missing">Not counted (no synced squad): {o.missingEntryIds.map(name).join(', ')}</Notice>}
        {o.invalidPicks?.length > 0 && <Notice>Invalid picks ignored for: {o.invalidPicks.map((p) => name(p.entryId ?? p)).join(', ')}</Notice>}
        <div className="mt-3">
          <Table testId="ownership-table">
            <thead className="text-xs uppercase text-slate-500">
              <tr><th className="py-2 pr-2">Player</th><th className="pr-2 text-right">Squad</th><th className="pr-2 text-right">XI</th><th className="pr-2 text-right">{effective ? 'Eff. captain' : 'Captain'}</th><th className="pr-2 text-right">EO</th>{hasRivals && <th className="text-right">My ×</th>}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.player.id}>
                  <td className="py-1.5 pr-2">{row.player.webName}</td>
                  <td className="pr-2 text-right font-mono">{pct(row.pickedSquad[sc])}</td>
                  <td className="pr-2 text-right font-mono">{pct(row.pickedXi[sc])}</td>
                  <td className="pr-2 text-right font-mono">{pct(effective ? row.effectiveCaptain[sc] : row.pickedCaptain[sc])}</td>
                  <td className="pr-2 text-right font-mono">{(effective ? row.effectiveEo : row.pickedEo)[sc]}</td>
                  {hasRivals && <td className="text-right font-mono">{effective ? row.myEffectiveMultiplier : row.myPickedMultiplier}</td>}
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Card>

      <Card title="Captaincy">
        {o.pendingCaptaincy?.length > 0 && <Notice>Captaincy still pending for: {o.pendingCaptaincy.map((p) => name(p.entryId ?? p)).join(', ')}</Notice>}
        <Table testId="captaincy-table">
          <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-2">Manager</th><th className="pr-2">Picked</th><th className="pr-2">Effective</th><th className="pr-2 text-right">Pts</th><th>Notes</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {o.captaincy.map((c) => {
              const player = (id) => o.rows.find((r) => r.player.id === id)?.player.webName ?? `#${id}`;
              return (
                <tr key={c.entryId}>
                  <td className="py-1.5 pr-2">{name(c.entryId)}</td>
                  <td className="pr-2">{player(c.pickedCaptain)}{c.tripleCaptain && <> <Badge tone="info">TC</Badge></>}</td>
                  <td className="pr-2">{c.effectiveCaptain ? `${player(c.effectiveCaptain.elementId)}${c.effectiveCaptain.via === 'VICE' ? ' (vice)' : ''}` : '–'}</td>
                  <td className="pr-2 text-right font-mono">{c.captainPoints ?? '–'}</td>
                  <td className="text-xs text-slate-600">{[c.benchBoost && 'Bench boost', c.autoSubSource !== 'NONE' && `Auto-subs: ${c.autoSubSource}`, ...(c.warnings ?? []).map(explain)].filter(Boolean).join(' · ')}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card title="Transfers">
        {transfers.isLoading && <Spinner />}
        <ErrorBox error={transfers.error} />
        {transfers.data && <Transfers t={transfers.data.transfers} name={name} player={(id) => o.rows.find((r) => r.player.id === id)?.player.webName ?? `#${id}`} />}
      </Card>
    </div>
  );
}

function Transfers({ t, name, player }) {
  return (
    <div className="space-y-2 text-sm">
      <p data-testid="transfer-totals">{t.totals.transfers} transfers by {t.totals.managersWithTransfers} managers; {t.totals.managersWithHits} took hits ({t.totals.hitCost} pts).</p>
      {t.missingEntryIds.length > 0 && <Notice>Not counted: {t.missingEntryIds.map(name).join(', ')}</Notice>}
      {(t.playersIn.length > 0 || t.playersOut.length > 0) && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div><p className="font-medium">In</p><ul>{t.playersIn.map((p) => <li key={p.elementId}>{p.player?.webName ?? player(p.elementId)} × {p.count}</li>)}</ul></div>
          <div><p className="font-medium">Out</p><ul>{t.playersOut.map((p) => <li key={p.elementId}>{p.player?.webName ?? player(p.elementId)} × {p.count}</li>)}</ul></div>
        </div>
      )}
      <ul className="divide-y divide-slate-100">
        {t.members.filter((m) => m.transfers.length || m.transferCost).map((m) => (
          <li key={m.entryId} className="py-1">{name(m.entryId)}: {m.transfers.map((x) => `${player(x.elementOut)} → ${player(x.elementIn)}`).join(', ') || `${m.eventTransfers} transfer(s)`}{m.transferCost ? ` (−${m.transferCost})` : ''}{m.activeChip ? ` · ${m.activeChip}` : ''}</li>
        ))}
      </ul>
    </div>
  );
}
