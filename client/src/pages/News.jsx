import { useState } from 'react';
import { Newspaper, RefreshCw } from 'lucide-react';
import { dateTime } from '../lib/format.js';
import { Avatar, Badge, Card, EmptyState, ErrorBox, Notice, Segmented, Skeleton } from '../components/ui.jsx';
import { FlagChips, useNews } from '../components/NewsFlags.jsx';

// Injury & news tracker (Step 18): FPL news and flags for every player someone
// in the group owns, newest first, with who owns him.

export default function News({ group, season, gw, isAdmin }) {
  const { news, refresh } = useNews(group, season, gw, { isAdmin });
  const [filter, setFilter] = useState('all');
  if (news.isLoading) return <Skeleton rows={5} />;
  if (news.error) return <ErrorBox error={news.error} title="News unavailable" />;
  const n = news.data.news;
  const nameOf = (id) => n.managers.find((m) => m.entryId === id)?.teamName ?? `#${id}`;
  const hasMe = n.myEntryId != null;
  const items = filter === 'mine' ? n.items.filter((x) => x.ownedByMe) : filter === 'rivals' ? n.items.filter((x) => x.ownedBy.some((e) => e !== n.myEntryId)) : n.items;
  const r = refresh.data?.refresh;

  return (
    <div className="space-y-4">
      <Card
        title={<span className="flex items-center gap-2"><Newspaper size={18} className="text-brand" />Injury &amp; news</span>}
        subtitle={<span data-testid="news-asof">FPL data as of {dateTime(n.asOf)}{refresh.isFetching && <> · <RefreshCw size={12} className="inline animate-spin" aria-hidden="true" /> checking FPL…</>}</span>}
        actions={hasMe ? <Segmented label="Whose players" value={filter} onChange={setFilter} options={[['all', 'All'], ['mine', 'Mine'], ['rivals', 'Rivals']]} testIdPrefix="news-filter" /> : null}
        padded={false}
      >
        {r?.status === 'FAILED' && <div className="px-4 pb-3 sm:px-5"><Notice testId="news-refresh-failed">FPL could not be reached just now; showing the news from the last successful read.</Notice></div>}
        {refresh.error && <div className="px-4 pb-3 sm:px-5"><Notice>Could not refresh from FPL; showing stored news.</Notice></div>}
        {n.squads.length === 0 ? (
          <div className="px-4 pb-4 sm:px-5"><EmptyState title="No squads synced yet">Sync this gameweek from the Results tab to see news for your group’s players.</EmptyState></div>
        ) : items.length === 0 ? (
          <div className="px-4 pb-4 sm:px-5"><EmptyState title="All clear">No news or flags for {filter === 'mine' ? 'your' : filter === 'rivals' ? 'your rivals’' : 'your group’s'} players.</EmptyState></div>
        ) : (
          <ul className="divide-y divide-line" data-testid="news-list">
            {items.map((x) => (
              <li key={x.elementId} className={`px-4 py-3 sm:px-5 ${x.ownedByMe ? 'bg-brand-soft/40' : ''}`} data-testid={`news-${x.elementId}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-x-2 font-bold">
                      <span className="truncate">{x.webName}</span>
                      <span className="text-xs font-semibold text-muted">{[x.team, x.position].filter(Boolean).join(' · ')}</span>
                      {x.ownedByMe && <Badge tone="info">yours</Badge>}
                    </p>
                    {x.flags.length > 0 && <div className="mt-1"><FlagChips flags={x.flags} /></div>}
                    {x.news && <p className="mt-1 text-sm">{x.news}</p>}
                    {x.newsAdded && <p className="mt-0.5 text-xs text-muted">{dateTime(x.newsAdded)}</p>}
                  </div>
                  <div className="flex shrink-0 -space-x-2" title={`Owned by ${x.ownedBy.map(nameOf).join(', ')}`} aria-label={`Owned by ${x.ownedBy.map(nameOf).join(', ')}`}>
                    {x.ownedBy.slice(0, 4).map((e) => <span key={e} className="rounded-full ring-2 ring-surface"><Avatar name={nameOf(e)} id={e} size={28} /></span>)}
                    {x.ownedBy.length > 4 && <span className="grid h-7 w-7 place-items-center rounded-full bg-surface-2 text-[10px] font-bold ring-2 ring-surface">+{x.ownedBy.length - 4}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="px-1 text-xs text-muted">Owners come from each member’s latest synced squad up to GW{gw}. 📈 price pressure means heavy net transfers in this gameweek: a signal, not a prediction.</p>
    </div>
  );
}
