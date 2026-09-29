import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Rocket, Sparkles } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { Avatar, Badge, Card, EmptyState, ErrorBox, Skeleton } from '../components/ui.jsx';

// Strategy lab (Step 16): the group's bandwagon buys, expected points of each
// latest XI (FPL ep_next) and the fixture difficulty of the next 3 GWs.

const fdrTone = (x) => (x == null ? 'neutral' : x <= 2.5 ? 'good' : x < 3.5 ? 'neutral' : 'bad');

export default function Strategy({ group, season, gw }) {
  const q = useQuery({ queryKey: ['rivals', group.id, season, gw], queryFn: () => endpoints.rivals(group.id, gw, season) });
  if (q.isLoading) return <Skeleton rows={5} />;
  if (q.error) return <ErrorBox error={q.error} title="Strategy unavailable" />;
  const r = q.data.rivals;
  const { bandwagon, xpts, fdr, fdrWindow } = r.strategy;
  const nameOf = (id) => r.leaderboard.find((x) => x.entryId === id)?.teamName ?? `#${id}`;
  const maxX = Math.max(1, ...xpts.map((m) => m.xPts ?? 0));

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><Rocket size={18} className="text-brand dark:text-violet-300" />Bandwagon</span>} subtitle={`Players your group bought in GW${r.event}`} padded={false}>
        {bandwagon.length === 0 ? <p className="px-4 pb-4 text-sm text-muted sm:px-5">No transfers in this gameweek yet.</p> : (
          <ul className="divide-y divide-line" data-testid="bandwagon">
            {bandwagon.map((b) => (
              <li key={b.elementId} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-lg font-black text-brand tabular dark:text-violet-300">{b.count}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold">{b.webName ?? `#${b.elementId}`}</p>
                  <p className="truncate text-xs text-muted">bought by {b.boughtBy.map(nameOf).join(', ')} · owned by {b.ownedBy}/{b.of}</p>
                </div>
                {b.iOwn === false && <Badge tone={b.count >= 2 ? 'bad' : 'warn'}>You don’t own</Badge>}
                {b.iOwn === true && <Badge tone="good">You own</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={<span className="flex items-center gap-2"><Sparkles size={18} className="text-brand dark:text-violet-300" />Expected points</span>} subtitle={`Next GW, from each latest known XI (FPL ep_next, captain ×2)`} padded={false}>
        {xpts.every((m) => m.xPts == null) ? <div className="px-4 pb-4 sm:px-5"><EmptyState title="No expected points yet">Needs a synced squad and FPL’s estimate (ep_next) for its players; re-sync after FPL publishes them.</EmptyState></div> : (
          <ol className="divide-y divide-line" data-testid="xpts">
            {xpts.map((m, i) => (
              <li key={m.entryId} className={`flex items-center gap-3 px-4 py-3 sm:px-5 ${m.isMe ? 'bg-brand-soft/60' : ''}`}>
                <span className="w-6 text-center font-black text-muted tabular">{m.xPts == null ? '–' : i + 1}</span>
                <Avatar name={m.teamName} id={m.entryId} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{m.teamName}{m.isMe && <> <Badge tone="info">me</Badge></>}</p>
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-2"><span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round(((m.xPts ?? 0) / maxX) * 100)}%` }} /></span>
                  {m.missing > 0 && <p className="mt-0.5 text-xs text-muted">{m.missing} player(s) without an FPL estimate</p>}
                </div>
                <span className="text-lg font-black tabular">{m.xPts ?? '–'}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title={<span className="flex items-center gap-2"><CalendarDays size={18} className="text-brand dark:text-violet-300" />Fixture difficulty</span>} subtitle={fdrWindow.length ? `GW${fdrWindow[0]}–${fdrWindow.at(-1)}, starting XI · lower is easier` : 'Season over'} padded={false}>
        <ol className="divide-y divide-line" data-testid="fdr">
          {fdr.map((m) => (
            <li key={m.entryId} className={`flex items-center gap-3 px-4 py-3 sm:px-5 ${m.isMe ? 'bg-brand-soft/60' : ''}`}>
              <Avatar name={m.teamName} id={m.entryId} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{m.teamName}{m.isMe && <> <Badge tone="info">me</Badge></>}</p>
                <p className="text-xs text-muted">{m.fixtures ? `${m.fixtures} fixtures` : 'No known fixtures'}</p>
              </div>
              <Badge tone={fdrTone(m.fdr)}>{m.fdr == null ? '–' : `FDR ${m.fdr}`}</Badge>
            </li>
          ))}
        </ol>
      </Card>
      <p className="px-1 text-xs text-muted">{r.rules.xPts} {r.rules.fdr}</p>
    </div>
  );
}
