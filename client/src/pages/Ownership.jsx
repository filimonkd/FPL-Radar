import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Crown } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { explain, pct } from '../lib/format.js';
import { useNames } from '../lib/useNames.js';
import { Avatar, Badge, Card, ErrorBox, Notice, Segmented, Skeleton, Table, Th } from '../components/ui.jsx';

// Ownership / captaincy / transfers (v0.2 §7): picked vs effective, rivals vs
// all, with the denominators and missing managers shown rather than hidden.
export default function Ownership({ group, season, gw }) {
  const [view, setView] = useState(null); // null → the server's default view
  const [scope, setScope] = useState('rivals');
  const own = useQuery({ queryKey: ['ownership', group.id, season, gw, view], queryFn: () => endpoints.ownership(group.id, gw, season, view ?? undefined) });
  const transfers = useQuery({ queryKey: ['ownership', group.id, season, gw, 'transfers'], queryFn: () => endpoints.transfers(group.id, gw, season) });
  const name = useNames(group, season, gw);
  if (own.isLoading) return <Skeleton rows={6} />;
  if (own.error) return <ErrorBox error={own.error} title="Ownership unavailable" />;
  const o = own.data.ownership;
  const effective = o.view === 'effective';
  const hasRivals = o.myEntryId != null;
  const sc = hasRivals ? scope : 'all';
  const rows = [...o.rows].sort((a, b) => (effective ? b.effectiveEo[sc] - a.effectiveEo[sc] : b.pickedEo[sc] - a.pickedEo[sc]) || b.pickedSquad[sc].count - a.pickedSquad[sc].count || a.player.id - b.player.id);
  const player = (id) => o.rows.find((r) => r.player.id === id)?.player.webName ?? `#${id}`; // players missing from bootstrap show their id
  const max = Math.max(1, ...rows.map((r) => (effective ? r.effectiveEo : r.pickedEo)[sc]));

  return (
    <div className="space-y-4">
      <Card title="Ownership" subtitle={`Out of ${o.denominators[sc]} ${sc === 'rivals' ? 'rivals' : 'managers'}`}>
        <div className="mb-3 flex flex-wrap gap-2">
          <Segmented label="View" value={o.view} onChange={setView} testIdPrefix="view" options={[['picked', 'Picked'], ['effective', 'Effective']]} />
          {hasRivals && <Segmented label="Scope" value={sc} onChange={setScope} options={[['rivals', 'Rivals'], ['all', 'Everyone']]} />}
        </div>
        <p className="text-sm text-muted" data-testid="denominators">
          {effective ? 'Effective: what actually scored, after auto-subs, chips and captain failure.' : 'Picked: the team as submitted at the deadline.'}
          {' '}Out of {o.denominators[sc]} {sc === 'rivals' ? 'rivals' : 'managers'}{hasRivals ? '' : ' (set “Me” in Settings to see rivals only)'}.
        </p>
        <div className="mt-2 space-y-2">
          {effective && o.effectiveProvisional && <Notice>Effective numbers are provisional until the gameweek is data-checked.</Notice>}
          {o.missingEntryIds.length > 0 && <Notice testId="missing">Not counted (no synced squad): {o.missingEntryIds.map(name).join(', ')}</Notice>}
          {o.invalidPicks?.length > 0 && <Notice>Invalid picks ignored for: {o.invalidPicks.map((p) => name(p.entryId ?? p)).join(', ')}</Notice>}
        </div>
        <div className="mt-3">
          <Table testId="ownership-table">
            <thead><tr><Th>Player</Th><Th className="text-right">Squad</Th><Th className="text-right">XI</Th><Th className="text-right">{effective ? 'Eff. C' : 'C'}</Th><Th className="text-right">EO</Th>{hasRivals && <Th className="text-right">Me</Th>}</tr></thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => {
                const eo = (effective ? row.effectiveEo : row.pickedEo)[sc];
                return (
                  <tr key={row.player.id}>
                    <td className="py-2 pr-3">
                      <span className="font-semibold">{row.player.webName ?? `#${row.player.id}`}</span>
                      <span className="mt-1 block h-1 w-20 overflow-hidden rounded-full bg-surface-2"><span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round((eo / max) * 100)}%` }} /></span>
                    </td>
                    <td className="pr-3 text-right">{pct(row.pickedSquad[sc])}</td>
                    <td className="pr-3 text-right">{pct(row.pickedXi[sc])}</td>
                    <td className="pr-3 text-right">{pct(effective ? row.effectiveCaptain[sc] : row.pickedCaptain[sc])}</td>
                    <td className="pr-3 text-right font-bold">{eo}</td>
                    {hasRivals && <td className="text-right">{(effective ? row.myEffectiveMultiplier : row.myPickedMultiplier) || '–'}</td>}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      </Card>

      <Card title="Captaincy" padded={false}>
        {o.pendingCaptaincy?.length > 0 && <div className="px-4 pb-2 sm:px-5"><Notice>Captaincy still pending for: {o.pendingCaptaincy.map((p) => name(p.entryId ?? p)).join(', ')}</Notice></div>}
        <ul className="divide-y divide-line" data-testid="captaincy-table">
          {o.captaincy.map((c) => (
            <li key={c.entryId} className="flex items-center gap-3 px-4 py-3 sm:px-5" data-testid={`cap-${c.entryId}`}>
              <Avatar name={name(c.entryId)} id={c.entryId} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{name(c.entryId)}</p>
                <p className="truncate text-xs text-muted">
                  <Crown size={11} className="mr-0.5 inline" aria-hidden="true" />{player(c.pickedCaptain)}
                  {c.effectiveCaptain && c.effectiveCaptain.elementId !== c.pickedCaptain ? ` → ${player(c.effectiveCaptain.elementId)} (vice)` : ''}
                  {[c.benchBoost && 'Bench boost', c.autoSubSource !== 'NONE' && `Auto-subs: ${c.autoSubSource}`, ...(c.warnings ?? []).map(explain)].filter(Boolean).map((t) => ` · ${t}`).join('')}
                </p>
              </div>
              {c.tripleCaptain && <Badge tone="info">TC</Badge>}
              <span className="text-lg font-black tabular">{c.captainPoints ?? '–'}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Transfers">
        {transfers.isLoading && <Skeleton rows={2} />}
        <ErrorBox error={transfers.error} />
        {transfers.data && <Transfers t={transfers.data.transfers} name={name} player={player} />}
      </Card>
    </div>
  );
}

function Transfers({ t, name, player }) {
  const busy = t.members.filter((m) => m.transfers.length || m.transferCost);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted" data-testid="transfer-totals">{t.totals.transfers} transfers by {t.totals.managersWithTransfers} managers; {t.totals.managersWithHits} took hits ({t.totals.hitCost} pts).</p>
      {t.missingEntryIds.length > 0 && <Notice>Not counted: {t.missingEntryIds.map(name).join(', ')}</Notice>}
      {(t.playersIn.length > 0 || t.playersOut.length > 0) && (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-emerald-500/8 p-3 ring-1 ring-emerald-500/20">
            <p className="flex items-center gap-1 font-bold text-emerald-700 dark:text-emerald-300"><ArrowUpRight size={16} />In</p>
            <ul className="mt-1 space-y-0.5">{t.playersIn.map((p) => <li key={p.elementId}>{p.player?.webName ?? player(p.elementId)} <span className="text-muted">×{p.count}</span></li>)}</ul>
          </div>
          <div className="rounded-xl bg-rose-500/8 p-3 ring-1 ring-rose-500/20">
            <p className="flex items-center gap-1 font-bold text-rose-700 dark:text-rose-300"><ArrowDownRight size={16} />Out</p>
            <ul className="mt-1 space-y-0.5">{t.playersOut.map((p) => <li key={p.elementId}>{p.player?.webName ?? player(p.elementId)} <span className="text-muted">×{p.count}</span></li>)}</ul>
          </div>
        </div>
      )}
      {busy.length > 0 && (
        <ul className="divide-y divide-line">
          {busy.map((m) => (
            <li key={m.entryId} className="py-2">
              <p className="font-semibold">{name(m.entryId)}{m.transferCost ? <span className="ml-1 text-rose-600 dark:text-rose-300">−{m.transferCost}</span> : null}{m.activeChip ? <Badge tone="info">{m.activeChip}</Badge> : null}</p>
              <p className="text-muted">{m.transfers.map((x) => `${player(x.elementOut)} → ${player(x.elementIn)}`).join(', ') || `${m.eventTransfers} transfer(s)`}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
