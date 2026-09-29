import { Navigate, NavLink, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Layers, PieChart, Settings as SettingsIcon, Trophy } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { seasonForDate, isSeasonKey } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import { Badge, ErrorBox, Skeleton } from '../components/ui.jsx';
import Results from './Results.jsx';
import Ownership from './Ownership.jsx';
import Chips from './Chips.jsx';
import Settings from './Settings.jsx';

const TABS = [['results', 'Results', Trophy], ['ownership', 'Ownership', PieChart], ['chips', 'Chips', Layers], ['settings', 'Settings', SettingsIcon]];
const STATE_LABEL = { UPCOMING: 'upcoming', LIVE: 'live', MATCHES_FINISHED: 'matches finished', FPL_PROCESSING: 'processing', DATA_CHECKED: 'final data' };

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
  if (group.isLoading) return <Skeleton />;
  if (group.error) return <ErrorBox error={group.error} title="Cannot open this group" />;
  const g = group.data.group;
  const stateOf = new Map((events.data?.events ?? []).map((e) => [e.gw, e.state]));
  const query = `?season=${season}${gw ? `&gw=${gw}` : ''}`;
  const seasons = [seasonForDate(), seasonForDate(new Date(Date.UTC(new Date().getUTCFullYear() - 1, 7, 1)))];
  if (!seasons.includes(season)) seasons.unshift(season);
  const state = gw ? stateOf.get(gw) : null;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 truncate text-xl font-extrabold tracking-tight" data-testid="group-name">
              <span className="truncate">{g.name}</span>{!g.isActive && <Badge tone="neutral">Archived</Badge>}
            </h1>
            <p className="mt-0.5 text-sm text-muted">{g.members.length} members · {g.winnerRule === 'NET_POINTS' ? 'net points' : 'gross points'}</p>
          </div>
          <select aria-label="Season" className="min-h-9 rounded-lg bg-surface-2 px-2 text-sm font-semibold ring-1 ring-line" value={season} onChange={(e) => set({ season: e.target.value })}>
            {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {tab !== 'settings' && (
          <div className="mt-3 flex items-center gap-2">
            <button type="button" aria-label="Previous gameweek" disabled={!gw || gw <= 1} onClick={() => set({ gw: gw - 1 })} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-surface-2 ring-1 ring-line disabled:opacity-30"><ChevronLeft size={20} /></button>
            <label className="relative flex-1">
              <span className="sr-only">Gameweek</span>
              <select aria-label="Gameweek" data-testid="gw-select" className="h-11 w-full appearance-none rounded-xl bg-surface-2 px-3 text-center text-base font-bold ring-1 ring-line" value={gw ?? ''} onChange={(e) => set({ gw: e.target.value })}>
                {gw == null && <option value="">Choose a gameweek</option>}
                {Array.from({ length: 38 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>Gameweek {n}{stateOf.get(n) === 'DATA_CHECKED' ? ' ✓' : stateOf.get(n) === 'LIVE' ? ' · live' : ''}</option>
                ))}
              </select>
            </label>
            <button type="button" aria-label="Next gameweek" disabled={!gw || gw >= 38} onClick={() => set({ gw: gw + 1 })} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-surface-2 ring-1 ring-line disabled:opacity-30"><ChevronRight size={20} /></button>
          </div>
        )}
        {tab !== 'settings' && state && <p className="mt-2 text-center text-xs font-medium text-muted">{state === 'DATA_CHECKED' ? 'FPL has confirmed the final data' : `FPL status: ${STATE_LABEL[state] ?? state}`}</p>}
      </div>

      <nav className="sticky top-14 z-20 -mx-4 bg-bg/90 px-4 py-2 backdrop-blur">
        <div className="flex gap-1 rounded-2xl bg-surface p-1 shadow-sm ring-1 ring-line">
          {tabs.map(([k, label, Icon]) => (
            <NavLink key={k} to={`/groups/${groupId}/${k}${query}`} className={({ isActive }) => `flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-semibold transition ${isActive ? 'bg-brand text-brand-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
              <Icon size={16} aria-hidden="true" className="hidden min-[400px]:block" />{label}
            </NavLink>
          ))}
        </div>
      </nav>

      {events.error && <ErrorBox error={events.error} title="Gameweeks unavailable" />}
      {tab === 'settings' ? <Settings group={g} season={season} gw={gw} />
        : gw == null ? <p className="rounded-2xl bg-surface p-4 text-sm text-muted ring-1 ring-line">No gameweek known for {season} yet. Choose one above, then sync it from the Results tab.</p>
          : tab === 'results' ? <Results group={g} season={season} gw={gw} isAdmin={isAdmin} />
            : tab === 'ownership' ? <Ownership group={g} season={season} gw={gw} />
              : <Chips group={g} season={season} gw={gw} />}
    </div>
  );
}
