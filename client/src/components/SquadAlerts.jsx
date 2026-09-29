import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { FlagChips } from './NewsFlags.jsx';

// "Your squad" alert strip on Results (Step 18): my own players who are out,
// doubtful, at rotation risk or already dropped in price. Silent when there is
// nothing to say, when "me" isn't set, or when the news can't be read.

export function SquadAlerts({ group, season, gw }) {
  const q = useQuery({ queryKey: ['news', group.id, season, gw], queryFn: () => endpoints.news(group.id, gw, season), staleTime: 60_000, enabled: group.myEntryId != null });
  const mine = q.data?.news?.mine ?? [];
  if (mine.length === 0) return null;
  const shown = mine.slice(0, 4);
  return (
    <section className="rounded-2xl bg-amber-500/10 p-3 ring-1 ring-amber-500/30 sm:p-4" data-testid="squad-alerts">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-bold text-amber-900 dark:text-amber-200"><ShieldAlert size={16} aria-hidden="true" />Your squad: {mine.length} alert{mine.length === 1 ? '' : 's'}</p>
        <Link to={`/groups/${group.id}/news?season=${season}&gw=${gw}`} className="text-sm font-semibold text-brand dark:text-violet-300">All news</Link>
      </div>
      <ul className="mt-2 space-y-1.5">
        {shown.map((x) => (
          <li key={x.elementId} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">{x.webName}</span>
            <FlagChips flags={x.flags} />
          </li>
        ))}
      </ul>
      {mine.length > shown.length && <p className="mt-1 text-xs text-muted">and {mine.length - shown.length} more</p>}
    </section>
  );
}
