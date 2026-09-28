import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api.js';
import { bytes, dateTime, explain, managerName, shortHash } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import { Badge, Card, ErrorBox, Spinner, Table } from '../components/ui.jsx';

// Trace path (v0.3 §8): snapshot → verification → source runs → the FPL
// requests (hashes) behind it → retained raw evidence. Read-only.
export default function SnapshotTrace() {
  const { snapshotId } = useParams();
  const { role } = useSession();
  const trace = useQuery({ queryKey: ['trace', snapshotId], queryFn: () => endpoints.trace(snapshotId) });
  const verify = useQuery({ queryKey: ['trace', snapshotId, 'verify'], queryFn: () => endpoints.verifySnapshot(snapshotId) });
  if (trace.isLoading) return <Spinner />;
  if (trace.error) return <ErrorBox error={trace.error} title="Trace unavailable" />;
  const { snapshot: s, sources, rawResponses } = trace.data;
  const v = verify.data;
  return (
    <div className="space-y-4" data-testid="trace">
      <Link className="text-sm text-indigo-700 underline" to={`/groups/${s.groupId}/results?season=${s.season}&gw=${s.event}`}>← Back to GW{s.event}</Link>
      <Card title={`Snapshot · GW${s.event} ${s.season}`}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Kind</dt><dd>{s.kind === 'RULE_BASED' ? 'Rule-based' : 'Admin override'}</dd>
          <dt className="text-slate-500">Declared</dt><dd>{s.declaredWinnerEntryIds.map((id) => managerName(s.standings, id)).join(', ') || '—'}</dd>
          <dt className="text-slate-500">Computed</dt><dd>{s.computedWinnerEntryIds.map((id) => managerName(s.standings, id)).join(', ') || '—'}</dd>
          <dt className="text-slate-500">Rules</dt><dd>{s.winnerRule} · {s.tieBreakRules.map(explain).join(' → ')}</dd>
          <dt className="text-slate-500">Computed at</dt><dd>{dateTime(s.computedAt)} · engine {s.engineVersion}</dd>
          <dt className="text-slate-500">Hashes</dt><dd className="font-mono text-xs">content {shortHash(s.contentHash)} · inputs {shortHash(s.inputsHash)}</dd>
        </dl>
        <div className="mt-3" data-testid="snapshot-verify">
          {verify.isLoading ? <Badge tone="neutral">Verifying…</Badge> : verify.error ? <ErrorBox error={verify.error} /> : (
            <div className="flex flex-wrap gap-2">
              <Badge tone={v.contentHashValid ? 'good' : 'bad'}>{v.contentHashValid ? 'Content hash valid' : 'Content hash INVALID'}</Badge>
              <Badge tone={v.reproducible ? 'good' : 'warn'}>{v.reproducible ? 'Reproduces from its inputs' : `Does not reproduce: ${v.mismatches.join(', ')}`}</Badge>
              {v.engineChanged && <Badge tone="warn">Engine changed since ({v.storedEngineVersion} → {v.currentEngineVersion})</Badge>}
            </div>
          )}
        </div>
      </Card>
      {sources.map((src) => (
        <Card key={src.syncRunId} title={<span className="flex items-center gap-2">Source run <Badge status={src.status}>{src.status}</Badge></span>} actions={role === 'admin' && <Link className="text-sm text-indigo-700 underline" to={`/status/runs/${src.syncRunId}`}>Open run</Link>}>
          <p className="text-sm text-slate-600">Started {dateTime(src.startedAt)} · {src.requestHashes.length} FPL responses behind this result{src.run?.expireAt ? '' : ' · retained permanently'}</p>
          <Table>
            <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-2">Request</th><th className="pr-2">HTTP</th><th className="pr-2">Size</th><th>Body hash</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {src.requests.map((q, i) => (
                <tr key={i}><td className="py-1 pr-2 font-mono text-xs">{q.path}</td><td className="pr-2">{q.httpStatus ?? '–'}</td><td className="pr-2">{bytes(q.bytes)}</td><td className="font-mono text-xs">{shortHash(q.bodySha256)}</td></tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ))}
      <Card title="Retained evidence">
        {rawResponses.length === 0 ? <p className="text-sm text-slate-600">No raw responses retained.</p> : (
          <ul className="space-y-1 text-sm">{rawResponses.map((r) => <li key={r.id} className="font-mono text-xs">{r.path} · {r.reason} · {bytes(r.bytesRaw)} → {bytes(r.bytesStored)} gz · {shortHash(r.bodySha256)}</li>)}</ul>
        )}
      </Card>
    </div>
  );
}
