import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '../lib/api.js';
import { money } from '../lib/format.js';

// Injury & news flags (Step 18). The server decides which flags apply
// (server/src/analytics/news.js); this only labels them.

const TONE = {
  OUT: 'bg-rose-500/12 text-rose-700 ring-rose-500/25 dark:text-rose-300',
  DOUBT: 'bg-amber-500/12 text-amber-800 ring-amber-500/30 dark:text-amber-300',
  ROTATION: 'bg-sky-500/12 text-sky-800 ring-sky-500/25 dark:text-sky-300',
  PRICE_DROPPED: 'bg-rose-500/10 text-rose-700 ring-rose-500/20 dark:text-rose-300',
  PRICE_PRESSURE: 'bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300',
};

export function flagText(f) {
  switch (f.code) {
    case 'OUT': return `🔴 ${f.label}`;
    case 'DOUBT': return `🚨 Doubt${f.chance != null ? ` · ${f.chance}%` : ''}`;
    case 'ROTATION': return '🔄 Rotation risk';
    case 'PRICE_DROPPED': return `📉 Price ${money(-f.changeTenths).replace('£', '−£')} this GW`;
    case 'PRICE_PRESSURE': return `📈 Price pressure · +${Math.round(f.net / 1000)}k net`;
    default: return f.code;
  }
}

const TITLE = {
  OUT: 'FPL lists him as unable to play',
  DOUBT: 'FPL’s chance of playing in the next round',
  ROTATION: 'Under 60 minutes in 2 of his last 3 games',
  PRICE_DROPPED: 'His price has already fallen this gameweek',
  PRICE_PRESSURE: 'Heavy net transfers in this gameweek: a rise is more likely. A signal, not a prediction',
};

export function FlagChips({ flags }) {
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f.code} title={TITLE[f.code]} data-testid={`flag-${f.code}`} className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${TONE[f.code] ?? ''}`}>
          {flagText(f)}
        </span>
      ))}
    </span>
  );
}

/**
 * The group's news feed. An admin opening it asks the server to re-read FPL;
 * the server does so at most every 5 minutes, and this asks at most once per
 * 5 minutes per season too. Viewers read what is stored.
 */
export function useNews(group, season, gw, { isAdmin }) {
  const qc = useQueryClient();
  const refresh = useQuery({
    queryKey: ['players-refresh', season],
    queryFn: () => endpoints.refreshPlayers(season),
    enabled: Boolean(isAdmin),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const news = useQuery({ queryKey: ['news', group.id, season, gw], queryFn: () => endpoints.news(group.id, gw, season), staleTime: 60_000 });
  const refreshed = refresh.data?.refresh?.refreshed;
  const refreshedAt = refresh.dataUpdatedAt;
  useEffect(() => {
    if (refreshed) qc.invalidateQueries({ queryKey: ['news'] });
  }, [refreshed, refreshedAt, qc]);
  return { news, refresh };
}
