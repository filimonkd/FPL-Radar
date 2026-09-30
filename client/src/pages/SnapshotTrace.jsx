import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ShieldAlert, ShieldCheck } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { bytes, dateTime, explain, managerName, shortHash } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import { Badge, Card, ErrorBox, Skeleton } from '../components/ui.jsx';

// Trace path (v0.3 §8): snapshot → verification → source runs → the FPL
// requests (hashes) behind it → retained raw evidence. Read-only.
export default function SnapshotTrace() {
  const { snapshotId } = useParams();
  const { role } = useSession();
  const trace = useQuery({ queryKey: ['trace', snapshotId], queryFn: () => endpoints.trace(snapshotId) });
  const verify = useQuery({ queryKey: ['trace', snapshotId, 'verify'], queryFn: () => endpoints.verifySnapshot(snapshotId) });
  if (trace.isLoading) return <Skeleton />;
  if (trace.error) return <ErrorBox error={trace.error} title="Trace unavailable" />;
  const { snapshot: s, sources, rawResponses } = trace.data;
  const v = verify.data;
  return (
    <div className="space-y-4" data-testid="trace">
      <Link className="inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink" to={`/groups/${s.groupId}/results?season=${s.season}&gw=${s.event}`}><ArrowLeft size={16} />Back to GW{s.event}</Link>
      <Card title={`Snapshot · GW${s.event} ${s.season}`}>
        <div className="mb-4" data-testid="snapshot-verify">
          {verify.isLoading ? <Badge tone="neutral">Verifying…</Badge> : verify.error ? <ErrorBox error={verify.error} /> : (
            <div className="flex flex-wrap gap-2">
              <Badge tone={v.contentHashValid ? 'good' : 'bad'} icon={v.contentHashValid ? ShieldCheck : ShieldAlert}>{v.contentHashValid ? 'Content hash valid' : 'Content hash INVALID'}</Badge>
              <Badge tone={v.reproducible ? 'good' : 'warn'}>{v.reproducible ? 'Reproduces from its inputs' : `Does not reproduce: ${v.mismatches.join(', ')}`}</Badge>
              {v.engineChanged && <Badge tone="warn">Engine changed since ({v.storedEngineVersion} → {v.currentEngineVersion})</Badge>}
            </div>
          )}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted">Kind</dt><dd>{s.kind === 'RULE_BASED' ? 'Rule-based' : 'Admin override'}</dd>
          <dt className="text-muted">Declared</dt><dd>{s.declaredWinnerEntryIds.map((id) => managerName(s.standings, id)).join(', ') || '—'}</dd>
          <dt className="text-muted">Computed</dt><dd>{s.computedWinnerEntryIds.map((id) => managerName(s.standings, id)).join(', ') || '—'}</dd>
          <dt className="text-muted">Rules</dt><dd>{s.winnerRule} · {s.tieBreakRules.map(explain).join(' → ')}</dd>
          <dt className="text-muted">Computed at</dt><dd>{dateTime(s.computedAt)} · engine {s.engineVersion}</dd>
          <dt className="text-muted">Hashes</dt><dd className="font-mono text-xs break-all">content {shortHash(s.contentHash)} · inputs {shortHash(s.inputsHash)}</dd>
        </dl>
      </Card>
      {sources.map((src) => (
        <Card key={src.syncRunId} title={<span className="flex items-center gap-2">Source run <Badge status={src.status}>{src.status}</Badge></span>} subtitle={`Started ${dateTime(src.startedAt)} · ${src.requestHashes.length} FPL responses${src.run?.expireAt ? '' : ' · retained permanently'}`} actions={role === 'admin' && <Link className="text-sm font-semibold text-brand underline" to={`/status/runs/${src.syncRunId}`}>Open run</Link>}>
          <ul className="divide-y divide-line text-sm">
            {src.requests.map((q, i) => (
              <li key={i} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{q.path}</span>
                <span className="text-xs text-muted">{q.httpStatus ?? '–'} · {bytes(q.bytes)}</span>
                <span className="hidden font-mono text-xs text-muted sm:inline">{shortHash(q.bodySha256)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <Card title="Retained evidence">
        {rawResponses.length === 0 ? <p className="text-sm text-muted">No raw responses retained.</p> : (
          <ul className="divide-y divide-line">{rawResponses.map((r) => <li key={r.id} className="py-1.5 font-mono text-xs break-all">{r.path} · {r.reason} · {bytes(r.bytesRaw)} → {bytes(r.bytesStored)} gz · {shortHash(r.bodySha256)}</li>)}</ul>
        )}
      </Card>
    </div>
  );
}
