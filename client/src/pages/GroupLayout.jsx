import { useEffect, useRef } from 'react';
import { Navigate, NavLink, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, Brain, CalendarRange, Sparkles, ChevronLeft, ChevronRight, Layers, Newspaper, PieChart, Search, Settings as SettingsIcon, Swords, Trophy } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { seasonForDate, isSeasonKey } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import { Badge, ErrorBox, Skeleton } from '../components/ui.jsx';
import Results from './Results.jsx';
import Ownership from './Ownership.jsx';
import Chips from './Chips.jsx';
import Settings from './Settings.jsx';
import Rivals from './Rivals.jsx';
import Strategy from './Strategy.jsx';
import News from './News.jsx';
import Finder from './Finder.jsx';
import Transfers from './Transfers.jsx';
import Planner from './Planner.jsx';

const TABS = [['results', 'Results', Trophy], ['rivals', 'Rivals', Swords], ['news', 'News', Newspaper], ['strategy', 'Strategy', Brain], ['finder', 'Finder', Search], ['transfers', 'Transfers', ArrowLeftRight], ['planner', 'Planner', CalendarRange], ['ownership', 'Ownership', PieChart], ['chips', 'Chips', Layers], ['settings', 'Settings', SettingsIcon]];
const STATE_LABEL = { UPCOMING: 'upcoming', LIVE: 'live', MATCHES_FINISHED: 'matches finished', FPL_PROCESSING: 'processing', DATA_CHECKED: 'final data' };

// Phones: a floating Results · Rivals · News · Tools bar; the rest are tools,
// listed as chips under the header while a tool is open. Wider screens keep
// every tab in the chip row.
const SECTIONS = ['results', 'rivals', 'news'];
const TOOL_KEY = 'fpl-radar:last-tool';
const lastTool = (allowed) => {
  try {
    const t = globalThis.localStorage?.getItem(TOOL_KEY);
    return allowed.includes(t) ? t : 'finder';
  } catch { return 'finder'; }
};
const rememberTool = (t) => { try { globalThis.localStorage?.setItem(TOOL_KEY, t); } catch { /* private mode */ } };

function GroupBar({ groupId, tab, query, tools }) {
  const inTools = !SECTIONS.includes(tab);
  const items = [['results', 'Results', Trophy], ['rivals', 'Rivals', Swords], ['news', 'News', Newspaper], ['tools', 'Tools', Sparkles]];
  return (
    <nav aria-label="Group" className="float-safe fixed left-1/2 z-30 -translate-x-1/2 sm:hidden" data-testid="group-bar">
      <div className="flex items-center gap-1.5 rounded-full bg-[#122420]/95 p-1.5 shadow-[0_14px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/10 backdrop-blur">
        {items.map(([k, label, Icon]) => {
          const active = k === 'tools' ? inTools : tab === k;
          const to = `/groups/${groupId}/${k === 'tools' ? (inTools ? tab : lastTool(tools)) : k}${query}`;
          return (
            <NavLink key={k} to={to} className={`flex h-13 items-center justify-center gap-2 rounded-full text-xs font-extrabold tracking-wide transition ${active ? 'bg-brand px-5 text-brand-ink' : 'w-13 bg-white/7 text-ink'}`}>
              <Icon size={20} aria-hidden="true" />
              {active ? <span className="uppercase">{label}</span> : <span className="sr-only">{label}</span>}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

/** Two letters for a group's avatar: the first two words' initials, or a one-word name's first two letters. */
const groupInitials = (name) => {
  const words = name.match(/[A-Za-z0-9]+/g) ?? ['?'];
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
};

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

  const tabsRef = useRef(null);
  // With many tabs the bar scrolls sideways; keep the open one in view.
  useEffect(() => {
    const bar = tabsRef.current;
    const active = bar?.querySelector('[aria-current="page"]');
    if (bar && active) bar.scrollLeft = active.offsetLeft - (bar.clientWidth - active.offsetWidth) / 2; // sideways only, never the page
  }, [tab, group.isLoading]);
  useEffect(() => { if (!SECTIONS.includes(tab)) rememberTool(tab); }, [tab]);

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
      <div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span aria-hidden="true" className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-[conic-gradient(var(--brand),#1b8f78,var(--brand))] p-[3px]">
              <span className="grid h-full w-full place-items-center rounded-full bg-surface font-display text-base font-extrabold ring-2 ring-bg">{groupInitials(g.name)}</span>
            </span>
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 truncate text-2xl font-bold" data-testid="group-name">
                <span className="truncate">{g.name}</span>{!g.isActive && <Badge tone="neutral">Archived</Badge>}
              </h1>
              <p className="text-sm font-semibold text-muted">{g.members.length} members · {g.winnerRule === 'NET_POINTS' ? 'net points' : 'gross points'}</p>
            </div>
          </div>
          <select aria-label="Season" className="min-h-11 shrink-0 rounded-full bg-white/7 px-3 text-sm font-bold ring-1 ring-white/10" value={season} onChange={(e) => set({ season: e.target.value })}>
            {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {tab !== 'settings' && (
          <div className="mt-4 flex items-center gap-2">
            <button type="button" aria-label="Previous gameweek" disabled={!gw || gw <= 1} onClick={() => set({ gw: gw - 1 })} className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/7 ring-1 ring-white/10 disabled:opacity-30"><ChevronLeft size={20} /></button>
            <label className="relative flex-1">
              <span className="sr-only">Gameweek</span>
              <select aria-label="Gameweek" data-testid="gw-select" className="h-12 w-full appearance-none rounded-full bg-brand/15 px-4 text-center font-display text-lg font-bold ring-1 ring-brand/45" value={gw ?? ''} onChange={(e) => set({ gw: e.target.value })}>
                {gw == null && <option value="">Choose a gameweek</option>}
                {Array.from({ length: 38 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>Gameweek {n}{stateOf.get(n) === 'DATA_CHECKED' ? ' ✓' : stateOf.get(n) === 'LIVE' ? ' · live' : ''}</option>
                ))}
              </select>
            </label>
            <button type="button" aria-label="Next gameweek" disabled={!gw || gw >= 38} onClick={() => set({ gw: gw + 1 })} className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/7 ring-1 ring-white/10 disabled:opacity-30"><ChevronRight size={20} /></button>
          </div>
        )}
        {tab !== 'settings' && state && (
          <p className="mt-2 flex items-center justify-center gap-1.5 text-xs font-bold text-muted">
            <span className={`h-2 w-2 rounded-full ${state === 'DATA_CHECKED' ? 'bg-brand' : state === 'LIVE' ? 'bg-[#ff8a7a]' : 'bg-muted'}`} aria-hidden="true" />
            {state === 'DATA_CHECKED' ? 'FPL has confirmed the final data' : `FPL status: ${STATE_LABEL[state] ?? state}`}
          </p>
        )}
      </div>

      <nav className={`sticky top-16 z-20 -mx-4 bg-[#071c18]/60 px-4 py-2 backdrop-blur-xl ${SECTIONS.includes(tab) ? 'hidden sm:block' : ''}`}>
        <div ref={tabsRef} className="flex gap-2 overflow-x-auto [scrollbar-width:none]">
          {tabs.map(([k, label, Icon]) => (
            <NavLink key={k} to={`/groups/${groupId}/${k}${query}`} className={({ isActive }) => `${SECTIONS.includes(k) ? 'hidden sm:flex' : 'flex'} min-h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-4 text-sm font-bold ring-1 ring-inset transition ${isActive ? 'bg-brand/16 text-ink ring-brand/50' : 'bg-white/5 text-muted ring-white/8 hover:text-ink'}`}>
              <Icon size={16} aria-hidden="true" />{label}
            </NavLink>
          ))}
        </div>
      </nav>

      {events.error && <ErrorBox error={events.error} title="Gameweeks unavailable" />}
      {tab === 'settings' ? <Settings group={g} season={season} gw={gw} />
        : gw == null ? <p className="rounded-2xl bg-surface p-4 text-sm text-muted ring-1 ring-line">No gameweek known for {season} yet. Choose one above, then sync it from the Results tab.</p>
          : tab === 'results' ? <Results group={g} season={season} gw={gw} isAdmin={isAdmin} />
            : tab === 'rivals' ? <Rivals group={g} season={season} gw={gw} isAdmin={isAdmin} />
            : tab === 'news' ? <News group={g} season={season} gw={gw} isAdmin={isAdmin} />
            : tab === 'planner' ? <Planner group={g} season={season} />
            : tab === 'transfers' ? <Transfers group={g} season={season} />
            : tab === 'finder' ? <Finder group={g} season={season} gw={gw} />
            : tab === 'strategy' ? <Strategy group={g} season={season} gw={gw} />
            : tab === 'ownership' ? <Ownership group={g} season={season} gw={gw} />
              : <Chips group={g} season={season} gw={gw} />}
      <GroupBar groupId={groupId} tab={tab} query={query} tools={tabs.map(([k]) => k).filter((k) => !SECTIONS.includes(k))} />
    </div>
  );
}
