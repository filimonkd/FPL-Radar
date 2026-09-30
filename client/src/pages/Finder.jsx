import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { money } from '../lib/format.js';
import { Badge, Card, EmptyState, ErrorBox, Segmented, Skeleton, inputClass } from '../components/ui.jsx';

// Differential & value finder (Step 19). Filters live in the URL so a search
// can be bookmarked or shared; the server filters and sorts
// (server/src/analytics/finder.js).

const SORTS = [['value', 'Points per £m'], ['form', 'Form'], ['xpts', 'Expected pts (next GW)'], ['fdr', 'Easiest next 3']];
const PRICES = ['4.5', '5.0', '5.5', '6.0', '6.5', '7.0', '7.5', '8.0', '9.0', '10.0', '12.0'];
const WORLD = ['1', '5', '10', '20'];
const KEYS = ['position', 'maxPrice', 'maxOwnership', 'maxGroupOwners', 'fit', 'sort'];
const fdrClass = (d) => (d == null ? 'bg-surface-2 text-muted' : d <= 2 ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : d === 3 ? 'bg-ink/5 text-muted' : 'bg-rose-500/12 text-rose-700 dark:text-rose-300');
const pctOf = (tenths) => (tenths == null ? '–' : `${tenths / 10}%`);

export default function Finder({ group, season, gw }) {
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? '']));
  const sort = SORTS.some(([k]) => k === filters.sort) ? filters.sort : 'value';
  const set = (k, v) => setParams((p) => { const n = new URLSearchParams(p); if (v === '' || v == null) n.delete(k); else n.set(k, String(v)); return n; }, { replace: true });
  const reset = () => setParams((p) => { const n = new URLSearchParams(p); KEYS.forEach((k) => n.delete(k)); return n; }, { replace: true });
  const apiParams = { ...Object.fromEntries(KEYS.map((k) => [k, filters[k]])), sort };

  const q = useQuery({ queryKey: ['finder', group.id, season, gw, apiParams], queryFn: () => endpoints.finder(group.id, gw, season, apiParams), placeholderData: keepPreviousData });
  const active = KEYS.filter((k) => k !== 'sort' && filters[k] !== '').length;
  const select = (label, key, options, testId) => (
    <label className="block min-w-0">
      <span className="mb-1 block text-xs font-semibold text-muted">{label}</span>
      <select aria-label={label} data-testid={testId} className={inputClass} value={filters[key]} onChange={(e) => set(key, e.target.value)}>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </label>
  );

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><Search size={18} className="text-brand" />Differential &amp; value finder</span>} subtitle="Find players your rivals don’t have">
        <div className="space-y-3">
          <div className="overflow-x-auto [scrollbar-width:none]">
            <Segmented label="Position" value={filters.position} onChange={(v) => set('position', v)} options={[['', 'All'], ['GKP', 'GKP'], ['DEF', 'DEF'], ['MID', 'MID'], ['FWD', 'FWD']]} testIdPrefix="finder-pos" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {select('Max price', 'maxPrice', [['', 'Any'], ...PRICES.map((p) => [p, `£${p}m`])], 'finder-price')}
            {select('World ownership', 'maxOwnership', [['', 'Any'], ...WORLD.map((w) => [w, `≤ ${w}%`])], 'finder-world')}
            {select(`Owned in ${group.name}`, 'maxGroupOwners', [['', 'Any'], ['0', 'Nobody'], ['1', '≤ 1 manager'], ['2', '≤ 2 managers']], 'finder-group')}
            <label className="block min-w-0">
              <span className="mb-1 block text-xs font-semibold text-muted">Sort by</span>
              <select aria-label="Sort by" data-testid="finder-sort" className={inputClass} value={sort} onChange={(e) => set('sort', e.target.value === 'value' ? '' : e.target.value)}>
                {SORTS.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
              </select>
            </label>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
              <input type="checkbox" data-testid="finder-fit" className="h-5 w-5 accent-[var(--brand)]" checked={filters.fit === 'true'} onChange={(e) => set('fit', e.target.checked ? 'true' : '')} />
              <span>Fit only<span className="block text-xs font-normal text-muted">Hide doubts &amp; injuries</span></span>
            </label>
            {active > 0 && <button type="button" onClick={reset} className="min-h-11 whitespace-nowrap px-2 text-sm font-semibold text-brand">Clear filters ({active})</button>}
          </div>
        </div>
      </Card>

      {q.isLoading ? <Skeleton rows={6} /> : q.error ? <ErrorBox error={q.error} title="Finder unavailable" /> : (() => {
        const f = q.data.finder;
        if (f.rows.length === 0) return <EmptyState icon={Search} title="No players match">Loosen a filter or clear them all.</EmptyState>;
        return (
          <Card padded={false} title={<span data-testid="finder-count">{f.total} player{f.total === 1 ? '' : 's'}</span>} subtitle={f.total > f.rows.length ? `Showing the top ${f.rows.length}` : undefined}>
            <ul className={`divide-y divide-line ${q.isPlaceholderData ? 'opacity-60' : ''}`} data-testid="finder-list">
              {f.rows.map((r) => (
                <li key={r.elementId} className="px-4 py-3 sm:px-5" data-testid={`finder-${r.elementId}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-x-2 font-bold">
                        <span className="truncate">{r.webName}</span>
                        <span className="text-xs font-semibold text-muted">{[r.team, r.position].filter(Boolean).join(' · ')}</span>
                        {r.ownedByMe && <Badge tone="info">yours</Badge>}
                        {r.status && r.status !== 'a' && <Badge tone={r.status === 'd' ? 'warn' : 'bad'}>{r.status === 'd' ? `doubt${r.chanceNext != null ? ` ${r.chanceNext}%` : ''}` : 'out'}</Badge>}
                      </p>
                      <p className="mt-0.5 text-xs text-muted" data-testid="finder-ownership">{pctOf(r.selectedByTenths)} world · {r.groupOwners}/{f.groupOf} {f.groupName}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {r.fixtures.fixtures.map((x) => (
                          <span key={`${x.gw}-${x.opponent}`} className={`rounded-md px-1.5 py-0.5 text-[11px] font-bold ${fdrClass(x.fdr)}`} title={`GW${x.gw} · difficulty ${x.fdr ?? '?'}`}>
                            {x.opponentShort ?? `#${x.opponent}`} ({x.home ? 'H' : 'A'})
                          </span>
                        ))}
                        {r.fixtures.blanks > 0 && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-bold text-muted">{r.fixtures.blanks} blank</span>}
                        {r.easyRun && <Badge tone="good" testId="finder-easy">Easy run {r.fixtures.avgFdr.toFixed(1)}</Badge>}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-lg font-black tabular">{money(r.priceTenths)}</p>
                      <p className="text-xs text-muted tabular">
                        {sort === 'value' && <>{r.pointsPerMillion ?? '–'} pts/£m</>}
                        {sort === 'form' && <>form {r.formTenths == null ? '–' : (r.formTenths / 10).toFixed(1)}</>}
                        {sort === 'xpts' && <>xP {r.epNextTenths == null ? '–' : (r.epNextTenths / 10).toFixed(1)}</>}
                        {sort === 'fdr' && <>FDR {r.fixtures.avgFdr ?? '–'}</>}
                      </p>
                      <p className="text-xs text-muted tabular">{r.totalPoints ?? '–'} pts</p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        );
      })()}
      <p className="px-1 text-xs text-muted">World ownership is FPL’s selected-by %. Group ownership counts each member’s latest synced squad up to GW{gw}. Difficulty is FPL’s 1–5 rating for the next 3 GWs; an average under 3.0 is marked as an easy run.</p>
    </div>
  );
}
