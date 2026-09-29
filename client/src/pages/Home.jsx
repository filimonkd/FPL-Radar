import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ChevronRight, Plus, Trophy, Users } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { Badge, Button, Card, EmptyState, ErrorBox, Skeleton } from '../components/ui.jsx';

// Home (admin): active groups, and archived ones in a collapsed section with Unarchive (v0.2 §5).
export default function Home() {
  const qc = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const groups = useQuery({ queryKey: ['groups', 'all'], queryFn: () => endpoints.groups(true) });
  const unarchive = useMutation({
    mutationFn: (id) => endpoints.unarchive(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
  if (groups.isLoading) return <Skeleton />;
  if (groups.error) return <ErrorBox error={groups.error} />;
  const active = groups.data.groups.filter((g) => g.isActive);
  const archived = groups.data.groups.filter((g) => !g.isActive);
  const newGroup = (
    <Link to="/groups/new" className="inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl bg-brand px-4 text-sm font-semibold text-brand-ink shadow-sm hover:brightness-110">
      <Plus size={16} aria-hidden="true" />New group
    </Link>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Groups</h1>
          <p className="text-sm text-muted">Your mini-leagues and who won each gameweek.</p>
        </div>
        {active.length > 0 && newGroup}
      </div>
      {active.length === 0 ? (
        <EmptyState icon={Trophy} title="No groups yet" action={newGroup}>Create one from an FPL classic league or a list of entry IDs.</EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="group-list">
          {active.map((g) => (
            <li key={g.id}>
              <Link to={`/groups/${g.id}/results`} className="group flex items-center gap-3 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line transition hover:-translate-y-0.5 hover:ring-brand/40 hover:shadow-md">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand dark:text-violet-300"><Trophy size={20} aria-hidden="true" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{g.name}</span>
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    <Badge tone="neutral" icon={Users}>{g.members.length}</Badge>
                    <Badge tone="neutral">{g.memberSource === 'MANUAL' ? 'Manual' : `League ${g.fplLeagueId}`}</Badge>
                    <Badge tone="info">{g.winnerRule === 'NET_POINTS' ? 'Net' : 'Gross'}</Badge>
                  </span>
                </span>
                <ChevronRight size={18} className="shrink-0 text-muted transition group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <Card title={`Archived (${archived.length})`} actions={<Button variant="ghost" size="sm" icon={Archive} onClick={() => setShowArchived((v) => !v)}>{showArchived ? 'Hide' : 'Show'}</Button>}>
          {showArchived && (
            <ul className="divide-y divide-line">
              {archived.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <Link to={`/groups/${g.id}/results`} className="truncate font-medium text-muted underline">{g.name}</Link>
                  <Button variant="secondary" size="sm" disabled={unarchive.isPending} onClick={() => unarchive.mutate(g.id)}>Unarchive</Button>
                </li>
              ))}
            </ul>
          )}
          <ErrorBox error={unarchive.error} />
        </Card>
      )}
    </div>
  );
}
