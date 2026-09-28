import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api.js';
import { bytes, dateTime, shortHash } from '../lib/format.js';
import { Badge, Card, ErrorBox, Spinner, Table } from '../components/ui.jsx';

// One sync run with its full request log (v0.3 §8): paths, status, sizes and
// body hashes only; response bodies are never shown here.
export default function RunDetail() {
  const { runId } = useParams();
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => endpoints.run(runId) });
  if (run.isLoading) return <Spinner />;
  if (run.error) return <ErrorBox error={run.error} title="Run unavailable" />;
  const r = run.data.run;
  return (
    <div className="space-y-4">
      <Link className="text-sm text-indigo-700 underline" to="/status">← Status</Link>
      <Card title={<span className="flex items-center gap-2">Run {r.job} <Badge status={r.status}>{r.status}</Badge></span>}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Trigger</dt><dd>{r.trigger}</dd>
          <dt className="text-slate-500">Season / GW</dt><dd>{r.season ?? '–'} / {r.event ?? '–'}</dd>
          <dt className="text-slate-500">Started</dt><dd>{dateTime(r.startedAt)}</dd>
          <dt className="text-slate-500">Finished</dt><dd>{dateTime(r.finishedAt)}</dd>
          <dt className="text-slate-500">Retention</dt><dd>{r.expireAt ? `expires ${dateTime(r.expireAt)}` : 'permanent'}</dd>
        </dl>
        {r.failures.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-red-800">{r.failures.map((f, i) => <li key={i}>{f.entryId ?? 'run'}: {f.code} — {f.message}</li>)}</ul>}
        {r.warnings.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-amber-900">{r.warnings.map((w, i) => <li key={i}>{w.code}</li>)}</ul>}
      </Card>
      <Card title={`Requests (${r.requests.length})`}>
        <Table testId="requests">
          <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-2">Path</th><th className="pr-2">HTTP</th><th className="pr-2">Schema</th><th className="pr-2 text-right">Size</th><th className="pr-2 text-right">ms</th><th>Hash</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {r.requests.map((q, i) => (
              <tr key={i}>
                <td className="py-1 pr-2 font-mono text-xs">{q.path}{q.fromCache && <span className="text-slate-500"> (cache)</span>}</td>
                <td className="pr-2">{q.httpStatus ?? '–'}</td>
                <td className="pr-2">{q.schemaOk == null ? '–' : q.schemaOk ? 'ok' : <Badge tone="bad">fail</Badge>}</td>
                <td className="pr-2 text-right">{bytes(q.bytes)}</td>
                <td className="pr-2 text-right">{q.durationMs}</td>
                <td className="font-mono text-xs">{shortHash(q.bodySha256)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
