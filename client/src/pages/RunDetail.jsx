import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { bytes, dateTime, shortHash } from '../lib/format.js';
import { Badge, Card, ErrorBox, Skeleton, Table, Th } from '../components/ui.jsx';

// One sync run with its full request log (v0.3 §8): paths, status, sizes and
// body hashes only; response bodies are never shown here.
export default function RunDetail() {
  const { runId } = useParams();
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => endpoints.run(runId) });
  if (run.isLoading) return <Skeleton />;
  if (run.error) return <ErrorBox error={run.error} title="Run unavailable" />;
  const r = run.data.run;
  return (
    <div className="space-y-4">
      <Link className="inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink" to="/status"><ArrowLeft size={16} />Status</Link>
      <Card title={<span className="flex flex-wrap items-center gap-2">Run {r.job} <Badge status={r.status}>{r.status}</Badge></span>}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted">Trigger</dt><dd>{r.trigger}</dd>
          <dt className="text-muted">Season / GW</dt><dd>{r.season ?? '–'} / {r.event ?? '–'}</dd>
          <dt className="text-muted">Started</dt><dd>{dateTime(r.startedAt)}</dd>
          <dt className="text-muted">Finished</dt><dd>{dateTime(r.finishedAt)}</dd>
          <dt className="text-muted">Retention</dt><dd>{r.expireAt ? `expires ${dateTime(r.expireAt)}` : 'permanent'}</dd>
        </dl>
        {r.failures.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-rose-700 dark:text-rose-300">{r.failures.map((f, i) => <li key={i}>{f.entryId ?? 'run'}: {f.code} — {f.message}</li>)}</ul>}
        {r.warnings.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-amber-800 dark:text-amber-300">{r.warnings.map((w, i) => <li key={i}>{w.code}</li>)}</ul>}
      </Card>
      <Card title={`Requests (${r.requests.length})`}>
        <Table testId="requests">
          <thead><tr><Th>Path</Th><Th>HTTP</Th><Th>Schema</Th><Th className="text-right">Size</Th><Th className="text-right">ms</Th><Th>Hash</Th></tr></thead>
          <tbody className="divide-y divide-line">
            {r.requests.map((q, i) => (
              <tr key={i}>
                <td className="py-1.5 pr-3 font-mono text-xs whitespace-nowrap">{q.path}{q.fromCache && <span className="text-muted"> (cache)</span>}</td>
                <td className="pr-3">{q.httpStatus ?? '–'}</td>
                <td className="pr-3">{q.schemaOk == null ? '–' : q.schemaOk ? 'ok' : <Badge tone="bad">fail</Badge>}</td>
                <td className="pr-3 text-right whitespace-nowrap">{bytes(q.bytes)}</td>
                <td className="pr-3 text-right">{q.durationMs}</td>
                <td className="font-mono text-xs">{shortHash(q.bodySha256)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
