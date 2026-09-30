import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Crown, Trophy } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { isSeasonKey, namesList, seasonForDate, whatsappSummary } from '../lib/format.js';
import { Badge, Card, EmptyState, ErrorBox, Skeleton } from '../components/ui.jsx';
import { Podium } from '../components/Podium.jsx';
import { WhatsAppShare } from '../components/WhatsAppShare.jsx';

// Commissioner view (Step 16): every active group side by side, each with its
// overall podium, the GW winner and a ready-to-send WhatsApp summary.

function GroupBoard({ group, season, gw }) {
  const rivals = useQuery({ queryKey: ['rivals', group.id, season, gw], queryFn: () => endpoints.rivals(group.id, gw, season) });
  const result = useQuery({ queryKey: ['result', group.id, season, gw], queryFn: () => endpoints.result(group.id, gw, season) });
  const r = rivals.data?.rivals;
  const res = result.data?.result;
  const decided = res && (res.status === 'FINAL' || res.status === 'OVERRIDDEN');
  const text = r ? whatsappSummary({ groupName: group.name, season, result: res, rivals: r }) : null;
  return (
    <Card
      title={<Link to={`/groups/${group.id}/results?season=${season}&gw=${gw}`} className="hover:underline">{group.name}</Link>}
      subtitle={`${group.members.length} members`}
      actions={res && <Badge status={res.status}>{res.status}</Badge>}
    >
      {rivals.isLoading && <Skeleton rows={1} />}
      <ErrorBox error={rivals.error} />
      {r && (
        <div className="space-y-4" data-testid={`board-${group.slug}`}>
          <div className="rounded-2xl bg-[#f5b84a]/8 p-3 ring-1 ring-[#f5b84a]/25" data-testid={`gw-winner-${group.slug}`}>
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted">GW{gw} {decided ? 'winner' : 'leader (not final)'}</p>
            {res?.winners?.length ? (
              <p className="mt-1 flex items-center gap-2 font-bold"><Crown size={16} className="shrink-0 text-amber-500" /><span className="min-w-0">{namesList(res.standings, res.winners)}</span>{res.winningScore != null && <span className="ml-auto font-black tabular">{res.winningScore}</span>}</p>
            ) : r.gwTop.length ? (
              <p className="mt-1 font-bold">{r.gwTop.map((x) => x.teamName).join(' & ')} <span className="font-black tabular">{r.gwTop[0].score}</span></p>
            ) : <p className="mt-1 text-sm text-muted">No scores for this gameweek yet.</p>}
          </div>
          <Podium podium={r.podium} testId={`podium-${group.slug}`} />
          <WhatsAppShare text={text} testId={`whatsapp-${group.slug}`} />
        </div>
      )}
    </Card>
  );
}

export default function Leaderboards() {
  const [params, setParams] = useSearchParams();
  const season = isSeasonKey(params.get('season')) ? params.get('season') : seasonForDate();
  const groups = useQuery({ queryKey: ['groups', 'all'], queryFn: () => endpoints.groups(true) });
  const events = useQuery({ queryKey: ['events', season], queryFn: () => endpoints.events(season) });
  const gwParam = Number(params.get('gw'));
  const gw = Number.isInteger(gwParam) && gwParam >= 1 && gwParam <= 38 ? gwParam : events.data?.currentEvent ?? null;
  const setGw = (n) => setParams((p) => { const x = new URLSearchParams(p); x.set('gw', String(n)); return x; }, { replace: true });

  if (groups.isLoading || events.isLoading) return <Skeleton />;
  if (groups.error) return <ErrorBox error={groups.error} />;
  const active = groups.data.groups.filter((g) => g.isActive);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Leaderboards</h1>
          <p className="text-sm text-muted">All your leagues, podiums and weekly winners.</p>
        </div>
        {gw != null && (
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Previous gameweek" disabled={gw <= 1} onClick={() => setGw(gw - 1)} className="grid h-11 w-11 place-items-center rounded-full bg-white/7 ring-1 ring-white/10 disabled:opacity-30"><ChevronLeft size={18} /></button>
            <span className="min-w-20 text-center font-bold" data-testid="boards-gw">GW{gw}</span>
            <button type="button" aria-label="Next gameweek" disabled={gw >= 38} onClick={() => setGw(gw + 1)} className="grid h-11 w-11 place-items-center rounded-full bg-white/7 ring-1 ring-white/10 disabled:opacity-30"><ChevronRight size={18} /></button>
          </div>
        )}
      </div>
      {active.length === 0 ? <EmptyState icon={Trophy} title="No groups yet">Create a group to see its leaderboard.</EmptyState>
        : gw == null ? <p className="text-sm text-muted">No gameweek known for {season} yet. Sync a group first.</p>
          : <div className="grid gap-4 lg:grid-cols-2">{active.map((g) => <GroupBoard key={g.id} group={g} season={season} gw={gw} />)}</div>}
    </div>
  );
}
