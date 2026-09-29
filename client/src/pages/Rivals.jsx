import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Crosshair, Crown, Shirt, Swords, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { money, signed } from '../lib/format.js';
import { Avatar, Badge, Card, EmptyState, ErrorBox, Notice, Skeleton } from '../components/ui.jsx';

// Spy vs Me + Rival Radar (Step 16). Everything here is read from
// GET /groups/:id/gw/:gw/rivals; unknown values show "–", never zero.

export const THREAT = {
  HIGH: { emoji: '🔥', label: 'HIGH', tone: 'bad' },
  MEDIUM: { emoji: '⚠️', label: 'MEDIUM', tone: 'warn' },
  LOW: { emoji: '🧊', label: 'LOW', tone: 'info' },
};
const CHIP_LABEL = { wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain' };

export function ThreatBadge({ threat, testId }) {
  const t = THREAT[threat.level];
  return <Badge tone={t.tone} testId={testId}>{t.emoji} {t.label}</Badge>;
}

function h2hText(h) {
  if (!h || h.gws === 0) return 'No shared GWs yet';
  if (h.wins > h.losses) return `You lead ${h.wins}–${h.losses}${h.draws ? ` (${h.draws} drawn)` : ''}`;
  if (h.wins < h.losses) return `They lead ${h.losses}–${h.wins}${h.draws ? ` (${h.draws} drawn)` : ''}`;
  return `Level ${h.wins}–${h.losses}${h.draws ? ` (${h.draws} drawn)` : ''}`;
}

function Stat({ icon: Icon, label, value, hint, tone }) {
  const color = tone === 'good' ? 'text-emerald-600 dark:text-emerald-300' : tone === 'bad' ? 'text-rose-600 dark:text-rose-300' : '';
  return (
    <div className="rounded-xl bg-surface-2 p-3 ring-1 ring-line">
      <p className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-muted">{Icon && <Icon size={12} aria-hidden="true" />}{label}</p>
      <p className={`mt-1 text-xl font-black tabular ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export default function Rivals({ group, season, gw, isAdmin }) {
  const q = useQuery({ queryKey: ['rivals', group.id, season, gw], queryFn: () => endpoints.rivals(group.id, gw, season) });
  const [picked, setPicked] = useState(null);
  if (q.isLoading) return <Skeleton rows={5} />;
  if (q.error) return <ErrorBox error={q.error} title="Rivals unavailable" />;
  const r = q.data.rivals;
  if (r.rivals.length === 0) return <EmptyState icon={Swords} title="No rivals yet">Sync this gameweek to see your rivals.</EmptyState>;
  const player = (id) => r.players.find((p) => p.id === id)?.webName ?? (id == null ? '–' : `#${id}`);
  const hasMe = r.myEntryId != null;
  const defaultId = r.closest?.above?.entryId ?? r.closest?.below?.entryId ?? r.rivals[0].entryId;
  const sel = r.rivals.find((x) => x.entryId === (picked ?? defaultId)) ?? r.rivals[0];
  const byRank = [...r.rivals].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.entryId - b.entryId);

  return (
    <div className="space-y-4">
      {!hasMe && <Notice>Set “Me” {isAdmin ? 'in Settings' : '(ask the admin)'} to see differentials, squad overlap and head-to-head. Threat levels below compare with the group average.</Notice>}

      {r.closest && (
        <div className="grid grid-cols-2 gap-3" data-testid="closest">
          {[['above', 'Chasing', ArrowUp, r.closest.above], ['below', 'Chased by', ArrowDown, r.closest.below]].map(([k, title, Icon, x]) => (
            <button key={k} type="button" disabled={!x} onClick={() => x && setPicked(x.entryId)} className="rounded-2xl bg-surface p-3 text-left shadow-sm ring-1 ring-line transition enabled:hover:ring-brand/40 disabled:opacity-60">
              <p className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-muted"><Icon size={12} />{title}</p>
              {x ? (
                <>
                  <p className="mt-1 truncate font-bold">{x.teamName}</p>
                  <p className={`text-sm font-semibold ${k === 'above' ? 'text-rose-600 dark:text-rose-300' : 'text-emerald-600 dark:text-emerald-300'}`}>{k === 'above' ? `${x.gap} pts to catch` : `you lead by ${Math.abs(x.gap)}`}</p>
                </>
              ) : <p className="mt-1 text-sm text-muted">{k === 'above' ? 'You are top 🏆' : 'Nobody below'}</p>}
            </button>
          ))}
        </div>
      )}

      <div className="-mx-4 overflow-x-auto px-4" role="tablist" aria-label="Choose a rival">
        <div className="flex w-max gap-2">
          {byRank.map((x) => (
            <button key={x.entryId} type="button" role="tab" aria-selected={x.entryId === sel.entryId} onClick={() => setPicked(x.entryId)} data-testid={`pick-${x.entryId}`}
              className={`flex min-h-11 items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm font-semibold ring-1 transition ${x.entryId === sel.entryId ? 'bg-brand text-brand-ink ring-brand' : 'bg-surface ring-line'}`}>
              <Avatar name={x.teamName} id={x.entryId} size={28} />{x.teamName}<span aria-hidden="true">{THREAT[x.threat.level].emoji}</span>
            </button>
          ))}
        </div>
      </div>

      <Card padded={false}>
        <div className="flex items-center gap-3 p-4 sm:p-5" data-testid="spy">
          <Avatar name={sel.teamName} id={sel.entryId} size={48} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-extrabold">{sel.teamName}</p>
            <p className="truncate text-sm text-muted">{sel.playerName}{sel.rank ? ` · #${sel.rank} overall` : ''}</p>
          </div>
          <ThreatBadge threat={sel.threat} testId="threat" />
        </div>
        <div className="grid grid-cols-2 gap-2 px-4 pb-4 sm:grid-cols-3 sm:px-5">
          <Stat icon={Swords} label="This GW" value={hasMe && sel.gwDiff != null ? signed(-sel.gwDiff) : '–'} hint={sel.gwScore != null ? `They scored ${sel.gwScore}` : 'Score not confirmed'} tone={sel.gwDiff == null ? null : sel.gwDiff > 0 ? 'bad' : sel.gwDiff < 0 ? 'good' : null} />
          <Stat icon={Crosshair} label="Overall" value={hasMe && sel.overallDiff != null ? signed(-sel.overallDiff) : '–'} hint={sel.overallDiff == null ? `${sel.total ?? '–'} pts` : sel.overallDiff > 0 ? `${sel.overallDiff} behind them` : sel.overallDiff < 0 ? `${-sel.overallDiff} ahead of them` : 'Level'} tone={sel.overallDiff == null ? null : sel.overallDiff > 0 ? 'bad' : sel.overallDiff < 0 ? 'good' : null} />
          <Stat icon={Shirt} label="XI overlap" value={sel.overlap ? `${sel.overlap.shared}/11` : '–'} hint={sel.overlap ? (sel.overlap.shared >= 9 ? 'Too similar: find a differential' : 'shared starters') : 'Needs both squads'} />
          <Stat icon={Wallet} label="Bank · Value" value={money(sel.bankTenths)} hint={`Squad ${money(sel.valueTenths)}`} />
          <Stat icon={Crown} label="Captain" value={player(sel.captain)} hint={sel.activeChip === '3xc' ? 'Triple Captain!' : sel.overlap ? `GW${sel.overlap.squadEvent} team` : null} />
          <Stat icon={sel.form != null && r.threatBaseline.value != null && sel.form >= r.threatBaseline.value ? TrendingUp : TrendingDown} label="Form (3 GW)" value={sel.form ?? '–'} hint={r.threatBaseline.value != null ? `${r.threatBaseline.source === 'ME' ? 'You' : 'Group'}: ${r.threatBaseline.value}` : null} />
        </div>
        <div className="space-y-3 border-t border-line px-4 py-4 text-sm sm:px-5">
          <p data-testid="h2h"><span className="font-bold">Head to head:</span> {hasMe ? h2hText(sel.h2h) : '–'}</p>
          <p><span className="font-bold">Hits this season:</span> {sel.hits} pts{sel.hits >= 12 ? ' 🎲 risk-taker' : sel.hits === 0 ? ' 🛡️ plays it safe' : ''}</p>
          <div>
            <p className="font-bold">Chips left</p>
            <div className="mt-1 flex flex-wrap gap-1.5" data-testid="chips-left">
              {sel.chipsLeft == null ? <span className="text-muted">Unknown (chip rules not synced)</span>
                : sel.chipsLeft.length === 0 ? <span className="text-muted">None in this window</span>
                  : sel.chipsLeft.map((c) => <Badge key={c} tone={c === '3xc' || c === 'bboost' ? 'warn' : 'info'}>{CHIP_LABEL[c] ?? c}</Badge>)}
            </div>
          </div>
          {sel.overlap?.theirOnly.length > 0 && <p><span className="font-bold">Their differentials:</span> {sel.overlap.theirOnly.map(player).join(', ')}</p>}
          <p className="text-xs text-muted" data-testid="threat-reasons">{THREAT[sel.threat.level].emoji} {sel.threat.reasons.length ? sel.threat.reasons.join(' · ') : 'Nothing stands out'}{sel.threat.complete ? '' : ' (partial data)'}</p>
        </div>
      </Card>

      <Card title="Rival radar" subtitle="Everyone at a glance" padded={false}>
        <ul className="divide-y divide-line" data-testid="radar">
          {byRank.map((x) => (
            <li key={x.entryId}>
              <button type="button" onClick={() => setPicked(x.entryId)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 sm:px-5">
                <span className="w-7 text-center font-black text-muted tabular">{x.rank ?? '–'}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{x.teamName}</p>
                  <p className="truncate text-xs text-muted">form {x.form ?? '–'} · hits {x.hits} · {hasMe ? h2hText(x.h2h) : `${x.total ?? '–'} pts`}</p>
                </div>
                {hasMe && <span className={`text-sm font-black tabular ${x.overallDiff > 0 ? 'text-rose-600 dark:text-rose-300' : 'text-emerald-600 dark:text-emerald-300'}`}>{x.overallDiff == null ? '–' : signed(-x.overallDiff)}</span>}
                <ThreatBadge threat={x.threat} />
              </button>
            </li>
          ))}
        </ul>
        <p className="px-4 pb-4 text-xs text-muted sm:px-5">Threat: {r.rules.threat}</p>
      </Card>
    </div>
  );
}
