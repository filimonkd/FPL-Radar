import { Navigate, NavLink, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api.js';
import { seasonForDate, isSeasonKey } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import { Badge, ErrorBox, Spinner, inputClass } from '../components/ui.jsx';
import Results from './Results.jsx';
import Ownership from './Ownership.jsx';
import Chips from './Chips.jsx';
import Settings from './Settings.jsx';

const TABS = [['results', 'Results'], ['ownership', 'Ownership'], ['chips', 'Chips'], ['settings', 'Settings']];

/** Season and gameweek live in the URL (?season=&gw=) so every view is linkable. */
export function useGwParams(events) {
  const [params, setParams] = useSearchParams();
  const season = isSeasonKey(params.get('season')) ? params.get('season') : seasonForDate();
  const gwParam = Number(params.get('gw'));
  const fallback = events?.currentEvent ?? null;
  const gw = Number.isInteger(gwParam) && gwParam >= 1 && gwParam <= 38 ? gwParam : fallback;
  const set = (next) => setParams((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(next)) n.set(k, String(v)); return n; }, { replace: true });
  return { season, gw, set };
}

export default function GroupLayout() {
  const { groupId, tab } = useParams();
  const session = useSession();
  const group = useQuery({ queryKey: ['group', groupId], queryFn: () => endpoints.group(groupId) });
  const [params] = useSearchParams();
  const season = isSeasonKey(params.get('season')) ? params.get('season') : seasonForDate();
  const events = useQuery({ queryKey: ['events', season], queryFn: () => endpoints.events(season) });
  const { gw, set } = useGwParams(events.data);

  const isAdmin = session.role === 'admin';
  const tabs = TABS.filter(([k]) => k !== 'settings' || isAdmin);
  if (!tabs.some(([k]) => k === tab)) return <Navigate to={`/groups/${groupId}/results`} replace />;
  if (group.isLoading) return <Spinner />;
  if (group.error) return <ErrorBox error={group.error} title="Cannot open this group" />;
  const g = group.data.group;
  const stateOf = new Map((events.data?.events ?? []).map((e) => [e.gw, e.state]));
  const query = `?season=${season}${gw ? `&gw=${gw}` : ''}`;
  const seasons = [seasonForDate(), seasonForDate(new Date(Date.UTC(new Date().getUTCFullYear() - 1, 7, 1)))];
  if (!seasons.includes(season)) seasons.unshift(season);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-xl font-semibold" data-testid="group-name">
          {g.name}{!g.isActive && <Badge tone="neutral">Archived</Badge>}
        </h1>
        <div className="flex gap-2">
          <select aria-label="Season" className={`${inputClass} w-auto`} value={season} onChange={(e) => set({ season: e.target.value })}>
            {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select aria-label="Gameweek" data-testid="gw-select" className={`${inputClass} w-auto`} value={gw ?? ''} onChange={(e) => set({ gw: e.target.value })}>
            {gw == null && <option value="">GW…</option>}
            {Array.from({ length: 38 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>GW{n}{stateOf.get(n) ? ` · ${stateOf.get(n).replace('_', ' ').toLowerCase()}` : ''}</option>
            ))}
          </select>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 text-sm">
        {tabs.map(([k, label]) => (
          <NavLink key={k} to={`/groups/${groupId}/${k}${query}`} className={({ isActive }) => `whitespace-nowrap border-b-2 px-3 py-2 ${isActive ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-600'}`}>{label}</NavLink>
        ))}
      </nav>
      {events.error && <ErrorBox error={events.error} title="Gameweeks unavailable" />}
      {tab === 'settings' ? <Settings group={g} season={season} gw={gw} />
        : gw == null ? <p className="text-sm text-slate-600">No gameweek known for {season} yet. Pick one above, or run a sync from the Results tab after choosing a gameweek.</p>
          : tab === 'results' ? <Results group={g} season={season} gw={gw} isAdmin={isAdmin} />
            : tab === 'ownership' ? <Ownership group={g} season={season} gw={gw} />
              : <Chips group={g} season={season} gw={gw} />}
    </div>
  );
}
