import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowLeftRight, Search, TriangleAlert } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { money, signed } from '../lib/format.js';
import { Badge, Card, EmptyState, ErrorBox, Segmented, Skeleton, inputClass } from '../components/ui.jsx';

// Transfer simulator (Step 20): sell one of "me"'s players, buy one of the
// same position, and see the money, the recent numbers and a break-even
// verdict. The server computes everything (server/src/analytics/transfer.js);
// the choices live in the URL (?out=&in=&hit=).

const POS_ORDER = ['GKP', 'DEF', 'MID', 'FWD'];
const sellText = (p) => (p.sellingTenths == null ? '–' : `≈${money(p.sellingTenths)}`);
const tenths = (v) => (v == null ? '–' : (v / 10).toFixed(1));
const fdrClass = (d) => (d == null ? 'bg-surface-2 text-muted' : d <= 2 ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : d === 3 ? 'bg-ink/5 text-muted' : 'bg-rose-500/12 text-rose-700 dark:text-rose-300');

function Fixtures({ run, teams }) {
  const short = (id) => teams.get(id) ?? `#${id}`;
  return (
    <span className="flex flex-wrap gap-1">
      {run.fixtures.map((x) => <span key={`${x.gw}-${x.opponent}`} className={`rounded-md px-1.5 py-0.5 text-[11px] font-bold ${fdrClass(x.fdr)}`}>{short(x.opponent)} ({x.home ? 'H' : 'A'})</span>)}
      {run.blanks > 0 && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-bold text-muted">{run.blanks} blank</span>}
    </span>
  );
}

function PlayerLine({ p, right, onClick, selected, testId }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} aria-pressed={selected} className={`flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2 text-left sm:px-5 ${selected ? 'bg-brand-soft/70' : 'hover:bg-surface-2'}`}>
      <span className="min-w-0">
        <span className="block truncate font-bold">{p.webName ?? `#${p.elementId}`}</span>
        <span className="block text-xs text-muted">{[p.team, p.position].filter(Boolean).join(' · ')}{p.status && p.status !== 'a' ? ` · ${p.status === 'd' ? `doubt${p.chanceNext != null ? ` ${p.chanceNext}%` : ''}` : 'out'}` : ''}</span>
      </span>
      <span className="shrink-0 text-right text-sm tabular">{right}</span>
    </button>
  );
}

function Verdict({ projection }) {
  const { verdict, withinGws, hitCost, perGw, net } = projection;
  const n = perGw.length;
  const text = verdict === 'UNKNOWN' ? 'Not enough data to call it'
    : verdict === 'PAYS_OFF' ? (hitCost ? `Pays off the −${hitCost} within ${withinGws} GW${withinGws === 1 ? '' : 's'}` : `Gains within ${withinGws} GW${withinGws === 1 ? '' : 's'}`)
      : hitCost ? `Doesn’t beat −${hitCost} over ${n} GWs` : `No gain over ${n} GWs`;
  const tone = verdict === 'PAYS_OFF' ? 'bg-emerald-500/12 text-emerald-800 ring-emerald-500/30 dark:text-emerald-200' : verdict === 'UNKNOWN' ? 'bg-surface-2 text-muted ring-line' : 'bg-rose-500/10 text-rose-800 ring-rose-500/25 dark:text-rose-200';
  return (
    <div className={`rounded-2xl p-4 ring-1 ring-inset ${tone}`} data-testid="sim-verdict">
      <p className="text-lg font-extrabold">{text}</p>
      {net != null && <p className="mt-0.5 text-sm">Estimated net over {n} GWs: <strong className="tabular">{signed(net)}</strong>{hitCost ? ` (after the −${hitCost})` : ''}</p>}
    </div>
  );
}

export default function Transfers({ group, season }) {
  const [params, setParams] = useSearchParams();
  const outId = Number(params.get('out')) || null;
  const inId = Number(params.get('in')) || null;
  const hit = params.get('hit') !== 'false';
  const [search, setSearch] = useState('');
  const set = (next) => setParams((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(next)) { if (v == null || v === '') n.delete(k); else n.set(k, String(v)); } return n; }, { replace: true });

  const plan = useQuery({ queryKey: ['transfer-plan', group.id, season], queryFn: () => endpoints.transferPlan(group.id, season), retry: false });
  const players = useQuery({ queryKey: ['players', season], queryFn: () => endpoints.players(season), staleTime: 5 * 60_000 });
  const sim = useQuery({
    queryKey: ['transfer-sim', group.id, season, outId, inId, hit],
    queryFn: () => endpoints.transferSim(group.id, season, outId, inId, hit),
    enabled: Boolean(outId && inId && plan.data),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const p = plan.data?.plan;
  const all = players.data?.players;
  const teams = useMemo(() => new Map((all?.teams ?? []).map((t) => [t.id, t.shortName])), [all]);
  const out = p?.squad.find((x) => x.elementId === outId) ?? null;
  const candidates = useMemo(() => {
    if (!out || !all || !p) return [];
    const mine = new Set(p.squad.map((x) => x.elementId));
    const needle = search.trim().toLowerCase();
    return all.players
      .filter((x) => x.position === out.position && !mine.has(x.elementId) && (!needle || x.webName.toLowerCase().includes(needle) || (x.team ?? '').toLowerCase() === needle))
      .sort((a, b) => (b.epNextTenths ?? -1) - (a.epNextTenths ?? -1) || a.elementId - b.elementId)
      .slice(0, 30);
  }, [out, all, p, search]);
  const clubAfter = (teamId) => (p ? p.squad.filter((x) => x.elementId !== outId && x.teamId === teamId).length + 1 : 0);

  if (plan.isLoading) return <Skeleton rows={6} />;
  if (plan.error) {
    const { code } = plan.error;
    if (plan.error.status === 422) {
      return (
        <EmptyState icon={ArrowLeftRight} title="Transfer simulator" action={code === 'ME_NOT_SET' ? <Link className="font-semibold text-brand" to={`/groups/${group.id}/settings?season=${season}`}>Open Settings</Link> : null}>
          {code === 'ME_NOT_SET' ? 'Set “me” in this group’s Settings to simulate transfers for your team.' : code === 'NO_SQUAD' ? 'Sync the current gameweek first so your squad is known.' : 'No current gameweek is known for this season yet.'}
        </EmptyState>
      );
    }
    return <ErrorBox error={plan.error} title="Simulator unavailable" />;
  }

  const byPos = POS_ORDER.map((pos) => [pos, p.squad.filter((x) => x.position === pos)]).filter(([, l]) => l.length);
  const s = sim.data?.sim;

  return (
    <div className="space-y-4">
      <Card
        title={<span className="flex items-center gap-2"><ArrowLeftRight size={18} className="text-brand" />Transfer simulator</span>}
        subtitle={<>Your GW{p.squadEvent} squad · bank {money(p.bankTenths)} · for GW{p.event + 1}</>}
        actions={<Segmented label="Transfer cost" value={hit ? 'hit' : 'free'} onChange={(v) => set({ hit: v === 'free' ? 'false' : null })} options={[['hit', '−4 hit'], ['free', 'Free']]} testIdPrefix="sim-cost" />}
        padded={false}
      >
        <p className="px-4 pb-2 text-xs font-bold uppercase tracking-wide text-muted sm:px-5">1 · Sell</p>
        <div data-testid="sim-sell">
          {out ? (
            <div className="flex items-center gap-2 pr-4 sm:pr-5">
              <div className="min-w-0 flex-1"><PlayerLine p={out} selected testId={`sell-${out.elementId}`} onClick={() => set({ out: null, in: null })} right={<><span className="block font-bold">{sellText(out)}</span><span className="block text-xs text-muted">now {money(out.priceTenths)}</span></>} /></div>
              <button type="button" data-testid="sim-change-sell" onClick={() => set({ out: null, in: null })} className="min-h-11 shrink-0 px-2 text-sm font-semibold text-brand">Change</button>
            </div>
          ) : byPos.map(([pos, list]) => (
            <div key={pos}>
              <p className="bg-surface-2 px-4 py-1 text-[11px] font-bold text-muted sm:px-5">{pos}</p>
              <div className="divide-y divide-line">
                {list.map((x) => (
                  <PlayerLine key={x.elementId} p={x} selected={x.elementId === outId} testId={`sell-${x.elementId}`}
                    onClick={() => { set({ out: x.elementId === outId ? null : x.elementId, in: null }); setSearch(''); }}
                    right={<><span className="block font-bold">{sellText(x)}</span><span className="block text-xs text-muted">now {money(x.priceTenths)}</span></>} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {out && (
        <Card title={<span className="flex items-center gap-2"><ArrowDown size={18} className="text-brand" />2 · Buy a {out.position}</span>} subtitle="Sorted by FPL’s expected points for next GW" padded={false}>
          <div className="px-4 pb-3 sm:px-5">
            <label className="relative block">
              <span className="sr-only">Search players</span>
              <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input type="search" data-testid="sim-search" className={`${inputClass} pl-9`} placeholder="Name or club (e.g. ARS)" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
          </div>
          {players.isLoading ? <Skeleton rows={3} /> : candidates.length === 0 ? <p className="px-4 pb-4 text-sm text-muted sm:px-5">No {out.position} matches.</p> : (
            <div className="max-h-96 divide-y divide-line overflow-y-auto" data-testid="sim-buy">
              {candidates.map((x) => (
                <PlayerLine key={x.elementId} p={x} selected={x.elementId === inId} testId={`buy-${x.elementId}`} onClick={() => set({ in: x.elementId === inId ? null : x.elementId })}
                  right={<>
                    <span className="block font-bold">{money(x.priceTenths)}</span>
                    <span className="block text-xs text-muted">xP {tenths(x.epNextTenths)}</span>
                    {clubAfter(x.teamId) > 3 && <span className="block text-[11px] font-bold text-rose-600 dark:text-rose-300">4th from club</span>}
                  </>} />
              ))}
            </div>
          )}
        </Card>
      )}

      {out && inId && (sim.isLoading ? <Skeleton rows={4} /> : sim.error ? <ErrorBox error={sim.error} title="Simulation failed" /> : s && (
        <div className={`space-y-4 ${sim.isPlaceholderData ? 'opacity-60' : ''}`} data-testid="sim-result">
          <Verdict projection={s.projection} />

          {(s.check.clubLimitBroken || s.check.affordable === false) && (
            <div className="space-y-1 rounded-2xl bg-rose-500/10 p-3 text-sm font-semibold text-rose-800 ring-1 ring-rose-500/25 dark:text-rose-200" data-testid="sim-warnings">
              {s.check.clubLimitBroken && <p className="flex items-center gap-2"><TriangleAlert size={16} aria-hidden="true" />That would be {s.check.clubCount} players from {s.in.team}: FPL allows 3.</p>}
              {s.check.affordable === false && <p className="flex items-center gap-2"><TriangleAlert size={16} aria-hidden="true" />Not enough money: about {money(-s.check.bankAfterTenths)} short.</p>}
            </div>
          )}

          <Card title="Money" padded>
            <dl className="grid grid-cols-3 gap-2 text-center">
              <div><dt className="text-xs text-muted">Sell for</dt><dd className="text-lg font-black tabular">{sellText(s.out)}</dd></div>
              <div><dt className="text-xs text-muted">Buy for</dt><dd className="text-lg font-black tabular">{money(s.in.priceTenths)}</dd></div>
              <div><dt className="text-xs text-muted">Bank after</dt><dd className="text-lg font-black tabular" data-testid="sim-bank">{s.check.bankAfterTenths == null ? '–' : `≈${s.check.bankAfterTenths < 0 ? `−${money(-s.check.bankAfterTenths)}` : money(s.check.bankAfterTenths)}`}</dd></div>
            </dl>
            <p className="mt-2 text-xs text-muted">≈ Selling price is estimated from your transfer history: you keep half of any rise, rounded down to £0.1m.</p>
          </Card>

          <Card title="Head to head" padded={false}>
            <table className="w-full text-sm tabular" data-testid="sim-compare">
              <thead><tr className="text-xs text-muted"><th className="px-4 py-2 text-left font-semibold sm:px-5" /><th className="px-2 py-2 text-right font-semibold">{s.out.webName}</th><th className="px-4 py-2 text-right font-semibold sm:px-5">{s.in.webName}</th></tr></thead>
              <tbody className="divide-y divide-line">
                {[3, 5, 10].map((n) => (
                  <tr key={n}>
                    <td className="whitespace-nowrap px-4 py-2 text-muted sm:px-5">Last {n}</td>
                    {[s.out, s.in].map((x, i) => <td key={i} className={`py-2 text-right ${i ? 'px-4 sm:px-5' : 'px-2'}`}><strong>{x.last[n].points ?? '–'}</strong> pts <span className="text-xs text-muted">{x.last[n].minutes ?? '–'}′</span></td>)}
                  </tr>
                ))}
                <tr>
                  <td className="whitespace-nowrap px-4 py-2 text-muted sm:px-5">xP next</td>
                  <td className="px-2 py-2 text-right">{tenths(s.out.epNextTenths)}</td><td className="px-4 py-2 text-right sm:px-5">{tenths(s.in.epNextTenths)}</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 align-top text-muted sm:px-5">Next 3</td>
                  {[s.out, s.in].map((x, i) => <td key={i} className={`py-2 text-right align-top ${i ? 'px-4 sm:px-5' : 'px-2'}`}><span className="flex justify-end"><Fixtures run={x.fixtures} teams={teams} /></span><span className="mt-0.5 block text-xs text-muted">avg FDR {x.fixtures.avgFdr ?? '–'}</span></td>)}
                </tr>
              </tbody>
            </table>
          </Card>

          <Card title="Projection" subtitle="Estimated points per GW" padded={false}>
            <table className="w-full text-sm tabular" data-testid="sim-projection">
              <thead><tr className="text-xs text-muted"><th className="px-4 py-2 text-left font-semibold sm:px-5">GW</th><th className="px-2 py-2 text-right font-semibold">Out</th><th className="px-2 py-2 text-right font-semibold">In</th><th className="px-2 py-2 text-right font-semibold">Gain</th><th className="px-4 py-2 text-right font-semibold sm:px-5">Total</th></tr></thead>
              <tbody className="divide-y divide-line">
                {s.projection.perGw.map((g) => (
                  <tr key={g.gw}>
                    <td className="px-4 py-2 sm:px-5">{g.gw} {g.source === 'FPL' ? <Badge tone="info">FPL</Badge> : <span className="text-xs text-muted">est.</span>}</td>
                    <td className="px-2 py-2 text-right">{g.out ?? '–'}</td>
                    <td className="px-2 py-2 text-right">{g.in ?? '–'}</td>
                    <td className="px-2 py-2 text-right font-semibold">{g.gain == null ? '–' : signed(g.gain)}</td>
                    <td className="px-4 py-2 text-right font-bold sm:px-5">{g.cumulative == null ? '–' : signed(g.cumulative)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-4 py-3 text-xs text-muted sm:px-5">
              GW{s.projection.perGw[0]?.gw} is FPL’s own expected points. Later GWs are estimates: his per-game expected points (or FPL form if his team blanks next GW), times {Object.entries(s.rules.fdrFactor).map(([d, f]) => `${f}× at difficulty ${d}`).join(', ')}. Blank GWs count 0 and doubles count both games.
            </p>
          </Card>
        </div>
      ))}
    </div>
  );
}
