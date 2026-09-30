import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarRange, Plus, Search, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { money } from '../lib/format.js';
import { DEFAULT_BUDGET_TENTHS, SQUAD_SHAPE, addBlocker, bestXi, evaluate, loadDrafts, newDraft, saveDrafts } from '../lib/planner.js';
import { Badge, Button, Card, Drawer, EmptyState, ErrorBox, Segmented, Skeleton, inputClass } from '../components/ui.jsx';

// Wildcard / Free Hit planner (Step 21). Rules and totals come from
// lib/planner.js; drafts are kept in this browser only (localStorage), per
// group and season. Nothing here talks to FPL or changes the server.

const POSITIONS = Object.keys(SQUAD_SHAPE);
const tenths = (v) => (v == null ? '–' : (v / 10).toFixed(1));
const fdrClass = (d) => (d == null ? 'bg-surface-2 text-muted' : d <= 2 ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : d === 3 ? 'bg-ink/5 text-muted' : 'bg-rose-500/12 text-rose-700 dark:text-rose-300');
const newId = () => `d${Date.now().toString(36)}${Math.floor(performance.now() % 1000).toString(36)}`;

function Tile({ label, value, sub, tone, testId }) {
  return (
    <div className={`rounded-2xl p-3 ring-1 ring-inset ${tone === 'bad' ? 'bg-rose-500/10 ring-rose-500/25' : 'bg-surface-2 ring-line'}`} data-testid={testId}>
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className={`text-xl font-black tabular ${tone === 'bad' ? 'text-rose-700 dark:text-rose-300' : ''}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted">{sub}</p>}
    </div>
  );
}

function Picker({ position, draft, byId, all, bankTenths, onPick, onClose, teams }) {
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const list = all
    .filter((p) => p.position === position && !draft.squad.includes(p.elementId) && (!needle || p.webName.toLowerCase().includes(needle) || (p.team ?? '').toLowerCase() === needle))
    .sort((a, b) => (b.epNextTenths ?? -1) - (a.epNextTenths ?? -1) || a.elementId - b.elementId)
    .slice(0, 40);
  return (
    <Drawer open title={`Add a ${position}`} onClose={onClose} testId="planner-picker">
      <label className="relative mb-3 block">
        <span className="sr-only">Search players</span>
        <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input type="search" autoFocus data-testid="planner-search" className={`${inputClass} pl-9`} placeholder="Name or club (e.g. ARS)" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <ul className="divide-y divide-line">
        {list.map((p) => {
          const blocker = addBlocker(draft, byId, p);
          const tooDear = p.priceTenths > bankTenths;
          return (
            <li key={p.elementId}>
              <button type="button" disabled={Boolean(blocker)} onClick={() => onPick(p)} data-testid={`pick-${p.elementId}`} className="flex min-h-12 w-full items-center justify-between gap-3 py-2 text-left disabled:opacity-45">
                <span className="min-w-0">
                  <span className="block truncate font-bold">{p.webName}</span>
                  <span className="block text-xs text-muted">{p.team}{p.status && p.status !== 'a' ? ` · ${p.status === 'd' ? 'doubt' : 'out'}` : ''} · {(p.fixtures?.fixtures ?? []).map((f) => `${teams.get(f.opponent) ?? '?'}${f.home ? '' : ' (a)'}`).join(', ') || 'no fixtures'}</span>
                  {blocker && <span className="block text-[11px] font-semibold text-rose-600 dark:text-rose-300">{blocker}</span>}
                </span>
                <span className="shrink-0 text-right tabular">
                  <span className={`block font-bold ${tooDear ? 'text-rose-600 dark:text-rose-300' : ''}`}>{money(p.priceTenths)}</span>
                  <span className="block text-xs text-muted">xP {tenths(p.epNextTenths)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Drawer>
  );
}

export default function Planner({ group, season }) {
  const players = useQuery({ queryKey: ['players', season], queryFn: () => endpoints.players(season), staleTime: 5 * 60_000 });
  const plan = useQuery({ queryKey: ['transfer-plan', group.id, season], queryFn: () => endpoints.transferPlan(group.id, season), retry: false });
  const [state, setState] = useState(() => loadDrafts(group.id, season));
  const [picking, setPicking] = useState(null);
  useEffect(() => { setState(loadDrafts(group.id, season)); }, [group.id, season]);
  useEffect(() => { saveDrafts(group.id, season, state); }, [group.id, season, state]);

  const view = players.data?.players;
  const byId = useMemo(() => new Map((view?.players ?? []).map((p) => [p.elementId, p])), [view]);
  const teams = useMemo(() => new Map((view?.teams ?? []).map((t) => [t.id, t.shortName])), [view]);
  const draft = state.drafts.find((d) => d.id === state.activeId) ?? null;
  const nextGw = (view?.event ?? 0) + 1;
  const e = draft && view ? evaluate(draft, byId, nextGw) : null;

  const update = (fn) => setState((s) => ({ ...s, drafts: s.drafts.map((d) => (d.id === s.activeId ? fn(d) : d)) }));
  const create = (fromSquad) => {
    const p = plan.data?.plan;
    const squad = fromSquad && p ? p.squad.map((x) => x.elementId) : [];
    // Budget: the squad's estimated selling value plus the bank (a blank slate gets the same), else £100.0m.
    const budget = p ? p.squad.reduce((s, x) => s + (x.sellingTenths ?? x.priceTenths ?? 0), 0) + (p.bankTenths ?? 0) : DEFAULT_BUDGET_TENTHS;
    const d = newDraft({ id: newId(), name: `Draft ${state.drafts.length + 1}`, squad, xi: bestXi(squad.map((id) => byId.get(id)).filter(Boolean)), budgetTenths: budget });
    setState((s) => ({ drafts: [...s.drafts, d], activeId: d.id }));
  };
  const remove = () => {
    if (!draft || !window.confirm(`Delete “${draft.name}” from this browser?`)) return;
    setState((s) => { const drafts = s.drafts.filter((d) => d.id !== s.activeId); return { drafts, activeId: drafts[0]?.id ?? null }; });
  };
  const add = (p) => {
    update((d) => {
      const squad = [...d.squad, p.elementId];
      const full = squad.length === 15;
      return { ...d, squad, xi: full && d.xi.length === 0 ? bestXi(squad.map((id) => byId.get(id)).filter(Boolean)) : d.xi };
    });
    setPicking(null);
  };
  const drop = (id) => update((d) => ({ ...d, squad: d.squad.filter((x) => x !== id), xi: d.xi.filter((x) => x !== id) }));
  const toggleXi = (id) => update((d) => ({ ...d, xi: d.xi.includes(id) ? d.xi.filter((x) => x !== id) : [...d.xi, id] }));

  if (players.isLoading) return <Skeleton rows={6} />;
  if (players.error) return <ErrorBox error={players.error} title="Player data unavailable" />;
  const hasPlan = Boolean(plan.data?.plan);

  const newButtons = (
    <div className="flex flex-wrap justify-center gap-2">
      <Button icon={Sparkles} onClick={() => create(true)} disabled={!hasPlan} data-testid="planner-new-squad">From my squad</Button>
      <Button variant="secondary" icon={Plus} onClick={() => create(false)} data-testid="planner-new-blank">Blank slate</Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><CalendarRange size={18} className="text-brand" />Wildcard / Free Hit planner</span>} subtitle={`For GW${nextGw} · drafts are saved in this browser only`}>
        {!draft ? (
          <EmptyState title="Start a draft" action={newButtons}>
            {hasPlan ? 'Start from your latest synced squad (budget = its estimated selling value + bank), or from scratch.' : 'Set “me” in Settings and sync to start from your own squad, or start from scratch with £100.0m.'}
          </EmptyState>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Draft" data-testid="planner-draft" className={`${inputClass} w-auto! flex-1`} value={draft.id} onChange={(ev) => setState((s) => ({ ...s, activeId: ev.target.value }))}>
                {state.drafts.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.mode === 'FREE_HIT' ? 'Free Hit' : 'Wildcard'}</option>)}
              </select>
              <Button variant="secondary" size="sm" icon={Plus} onClick={() => create(hasPlan)} data-testid="planner-add-draft">New</Button>
              <Button variant="ghost" size="sm" icon={Trash2} onClick={remove} aria-label="Delete draft" data-testid="planner-delete" />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Segmented label="Chip" value={draft.mode} onChange={(v) => update((d) => ({ ...d, mode: v }))} options={[['WILDCARD', 'Wildcard'], ['FREE_HIT', 'Free Hit']]} testIdPrefix="planner-mode" />
              <label className="block w-28">
                <span className="mb-1 block text-xs font-semibold text-muted">Budget £m</span>
                <input type="number" inputMode="decimal" step="0.1" min="50" max="150" data-testid="planner-budget" className={inputClass} value={(draft.budgetTenths / 10).toFixed(1)}
                  onChange={(ev) => { const v = Math.round(Number(ev.target.value) * 10); if (Number.isInteger(v) && v >= 500 && v <= 1500) update((d) => ({ ...d, budgetTenths: v })); }} />
              </label>
            </div>
          </div>
        )}
      </Card>

      {draft && e && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Money left" value={e.bankTenths < 0 ? `−${money(-e.bankTenths)}` : money(e.bankTenths)} sub={`${money(e.cost)} of ${money(draft.budgetTenths)}`} tone={e.bankTenths < 0 ? 'bad' : null} testId="planner-bank" />
            <Tile label="Expected pts" value={e.xPts ?? '–'} sub={`GW${nextGw} XI, captain ×2${e.xPtsMissing ? ` · ${e.xPtsMissing} without estimate` : ''}`} testId="planner-xpts" />
            <Tile label="Avg difficulty" value={e.avgFdr ?? '–'} sub="XI fixtures, next 3 GWs" testId="planner-fdr" />
            <Tile label={`GW${nextGw} doubles / blanks`} value={`${e.doubles} / ${e.blanks}`} sub="starters playing twice / not at all" testId="planner-gw" />
          </div>

          <div className={`rounded-2xl p-3 text-sm ring-1 ring-inset ${e.valid ? 'bg-emerald-500/10 text-emerald-800 ring-emerald-500/25 dark:text-emerald-200' : 'bg-amber-500/10 text-amber-900 ring-amber-500/30 dark:text-amber-200'}`} data-testid="planner-status">
            {e.valid ? <p className="font-bold">✓ Valid {draft.mode === 'FREE_HIT' ? 'Free Hit' : 'Wildcard'} squad</p> : (
              <>
                <p className="font-bold">{e.size}/15 players{e.missing.length ? ` · still need ${e.missing.join(', ')}` : ''}</p>
                {e.problems.length > 0 && <ul className="mt-1 list-disc pl-5">{e.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
              </>
            )}
          </div>

          <Card title="Squad" subtitle="Tap XI / Bench to change the starting line-up" actions={<Button variant="secondary" size="sm" icon={Wand2} onClick={() => update((d) => ({ ...d, xi: bestXi(d.squad.map((id) => byId.get(id)).filter(Boolean)) }))} disabled={e.size === 0} data-testid="planner-best-xi">Best XI</Button>} padded={false}>
            {POSITIONS.map((pos) => {
              const list = draft.squad.map((id) => byId.get(id)).filter((p) => p && p.position === pos);
              const empty = Math.max(0, SQUAD_SHAPE[pos] - list.length);
              return (
                <div key={pos} data-testid={`planner-${pos}`}>
                  <p className="bg-surface-2 px-4 py-1 text-[11px] font-bold text-muted sm:px-5">{pos} · {list.length}/{SQUAD_SHAPE[pos]}</p>
                  <ul className="divide-y divide-line">
                    {list.map((p) => {
                      const inXi = draft.xi.includes(p.elementId);
                      return (
                        <li key={p.elementId} className={`flex items-center gap-2 px-4 py-2 sm:px-5 ${inXi ? '' : 'opacity-70'}`} data-testid={`planner-row-${p.elementId}`}>
                          <button type="button" onClick={() => toggleXi(p.elementId)} aria-pressed={inXi} data-testid={`xi-${p.elementId}`} className={`min-h-9 w-14 shrink-0 rounded-lg text-xs font-bold ring-1 ring-inset ${inXi ? 'bg-brand text-brand-ink ring-transparent' : 'bg-surface-2 text-muted ring-line'}`}>{inXi ? 'XI' : 'Bench'}</button>
                          <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-1.5 truncate font-bold">{p.webName}{e.captainId === p.elementId && <Badge tone="info" title="Captain: highest expected points in the XI">C</Badge>}{p.status && p.status !== 'a' && <Badge tone={p.status === 'd' ? 'warn' : 'bad'}>{p.status === 'd' ? 'doubt' : 'out'}</Badge>}</p>
                            <span className="mt-0.5 flex flex-wrap gap-1">
                              <span className="text-xs text-muted">{p.team}</span>
                              {(p.fixtures?.fixtures ?? []).map((f) => <span key={`${f.gw}-${f.opponent}`} className={`rounded px-1 text-[10px] font-bold ${fdrClass(f.fdr)}`}>{teams.get(f.opponent) ?? '?'}{f.home ? '' : ' (a)'}</span>)}
                              {(p.fixtures?.blanks ?? 0) > 0 && <span className="rounded bg-surface-2 px-1 text-[10px] font-bold text-muted">{p.fixtures.blanks} blank</span>}
                            </span>
                          </div>
                          <span className="shrink-0 text-right text-sm tabular"><span className="block font-bold">{money(p.priceTenths)}</span><span className="block text-xs text-muted">xP {tenths(p.epNextTenths)}</span></span>
                          <button type="button" onClick={() => drop(p.elementId)} aria-label={`Remove ${p.webName}`} data-testid={`drop-${p.elementId}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2"><X size={16} /></button>
                        </li>
                      );
                    })}
                    {Array.from({ length: empty }, (_, i) => (
                      <li key={`empty-${i}`}>
                        <button type="button" onClick={() => setPicking(pos)} data-testid={`add-${pos}`} className="flex min-h-12 w-full items-center gap-2 px-4 text-sm font-semibold text-brand hover:bg-surface-2 sm:px-5"><Plus size={16} aria-hidden="true" />Add {pos}</button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </Card>
          <p className="px-1 text-xs text-muted">Checks FPL’s squad rules: 2 GKP, 5 DEF, 5 MID, 3 FWD; at most 3 per club; the budget; and a starting XI of 1 GKP, at least 3 DEF, 2 MID and 1 FWD. Expected points are FPL’s ep_next for GW{nextGw}. Prices are current buy prices. Drafts never leave this browser.</p>
        </>
      )}

      {picking && draft && e && <Picker position={picking} draft={draft} byId={byId} all={view.players} bankTenths={e.bankTenths} onPick={add} onClose={() => setPicking(null)} teams={teams} />}
    </div>
  );
}
