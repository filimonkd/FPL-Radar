import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '../lib/api.js';
import { Badge, Button, Card, ErrorBox, Spinner } from '../components/ui.jsx';

// Home (admin): active groups, and archived ones in a collapsed section with Unarchive (v0.2 §5).
export default function Home() {
  const qc = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const groups = useQuery({ queryKey: ['groups', 'all'], queryFn: () => endpoints.groups(true) });
  const unarchive = useMutation({
    mutationFn: (id) => endpoints.unarchive(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
  if (groups.isLoading) return <Spinner />;
  if (groups.error) return <ErrorBox error={groups.error} />;
  const active = groups.data.groups.filter((g) => g.isActive);
  const archived = groups.data.groups.filter((g) => !g.isActive);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Groups</h1>
        <Link to="/groups/new" className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500">New group</Link>
      </div>
      {active.length === 0 && <Card><p className="text-sm text-slate-600">No groups yet. Create one from an FPL classic league or a manual list of entry IDs.</p></Card>}
      <ul className="grid gap-3 sm:grid-cols-2" data-testid="group-list">
        {active.map((g) => (
          <li key={g.id}>
            <Link to={`/groups/${g.id}/results`} className="block rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200 hover:ring-indigo-300">
              <p className="font-medium">{g.name}</p>
              <p className="mt-1 flex flex-wrap gap-2 text-xs text-slate-600">
                <Badge tone="neutral">{g.memberSource === 'MANUAL' ? 'Manual' : `League ${g.fplLeagueId}`}</Badge>
                <Badge tone="neutral">{g.members.length} members</Badge>
                <Badge tone="info">{g.winnerRule === 'NET_POINTS' ? 'Net points' : 'Gross points'}</Badge>
              </p>
            </Link>
          </li>
        ))}
      </ul>
      {archived.length > 0 && (
        <Card title={`Archived (${archived.length})`} actions={<Button variant="ghost" onClick={() => setShowArchived((v) => !v)}>{showArchived ? 'Hide' : 'Show'}</Button>}>
          {showArchived && (
            <ul className="divide-y divide-slate-100">
              {archived.map((g) => (
                <li key={g.id} className="flex items-center justify-between py-2 text-sm">
                  <Link to={`/groups/${g.id}/results`} className="text-slate-700 underline">{g.name}</Link>
                  <Button variant="secondary" disabled={unarchive.isPending} onClick={() => unarchive.mutate(g.id)}>Unarchive</Button>
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
