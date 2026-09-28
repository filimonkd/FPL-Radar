import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api.js';
import { bytes, dateTime, seasonForDate } from '../lib/format.js';
import { Badge, Card, ErrorBox, Notice, Spinner, Table, inputClass } from '../components/ui.jsx';

// Status page (admin; v0.3 §9, §15 step 11): points semantics exactly as
// stored, chip-rule source, storage gauge, recent runs, smoke verdicts.
export default function Status() {
  const [season, setSeason] = useState(seasonForDate());
  const status = useQuery({ queryKey: ['status', season], queryFn: () => endpoints.status(season) });
  const [showChecks, setShowChecks] = useState(false);
  if (status.isLoading) return <Spinner />;
  if (status.error) return <ErrorBox error={status.error} title="Status unavailable" />;
  const s = status.data.status;
  const st = s.storage;
  const usedPct = st?.usedPct ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Status</h1>
        <input aria-label="Season" className={`${inputClass} w-28`} value={season} onChange={(e) => setSeason(e.target.value)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card title="Points semantics">
          {s.semantics ? (
            <>
              <Badge status={s.semantics.value} testId="semantics">{s.semantics.value}</Badge>
              <p className="mt-2 text-xs text-slate-600">{s.semantics.evidenceRows} evidence rows · {s.semantics.conflictRows} conflicting</p>
            </>
          ) : <p className="text-sm text-slate-600">No season data yet.</p>}
        </Card>
        <Card title="Chip rules">
          {s.chipRules ? (
            <>
              <Badge tone={s.chipRules.source === 'FPL_BOOTSTRAP' ? 'good' : 'warn'}>{s.chipRules.source}</Badge>
              <p className="mt-2 text-xs text-slate-600">{s.chipRules.rules} rules · confirmed {dateTime(s.chipRules.lastConfirmedAt)}</p>
            </>
          ) : <p className="text-sm text-slate-600">Not synced.</p>}
        </Card>
        <Card title="Storage">
          {st ? (
            <>
              <div className="h-2 w-full rounded bg-slate-100" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPct} aria-label="Storage used">
                <div className={`h-2 rounded ${st.warning ? 'bg-amber-500' : 'bg-green-600'}`} style={{ width: `${Math.min(100, usedPct)}%` }} />
              </div>
              <p className="mt-2 text-xs text-slate-600" data-testid="storage">{bytes(st.usedBytes)} of {bytes(st.quotaBytes)} ({usedPct}%)</p>
              {st.warning && <Notice>Above 60% of the free-tier quota.</Notice>}
            </>
          ) : <p className="text-sm text-slate-600">Unavailable.</p>}
        </Card>
      </div>

      <Card title="Recent sync runs">
        <Table testId="runs">
          <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-2">Started</th><th className="pr-2">Job</th><th className="pr-2">GW</th><th className="pr-2">Status</th><th className="pr-2 text-right">Requests</th><th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {s.runs.map((r) => (
              <tr key={r.id}>
                <td className="py-1.5 pr-2 whitespace-nowrap">{dateTime(r.startedAt)}</td>
                <td className="pr-2">{r.job} <span className="text-xs text-slate-500">{r.trigger}</span></td>
                <td className="pr-2">{r.event ?? '–'}</td>
                <td className="pr-2"><Badge status={r.status}>{r.status}</Badge>{r.failures.length > 0 && <span className="text-xs text-slate-500"> {r.failures.length} failed</span>}</td>
                <td className="pr-2 text-right font-mono">{r.requests}</td>
                <td><Link className="text-indigo-700 underline" to={`/status/runs/${r.id}`}>Details</Link></td>
              </tr>
            ))}
          </tbody>
        </Table>
        {s.runs.length === 0 && <p className="text-sm text-slate-600">No runs yet.</p>}
      </Card>

      <Card title="FPL smoke test" actions={s.smoke?.available && <button type="button" className="text-sm text-indigo-700 underline" onClick={() => setShowChecks((v) => !v)}>{showChecks ? 'Hide checks' : 'Show checks'}</button>}>
        {!s.smoke?.available ? <p className="text-sm text-slate-600">No committed smoke report for {season}.</p> : (
          <>
            <p className="text-sm">{s.smoke.exit}</p>
            <p className="mt-1 flex flex-wrap gap-2">{Object.entries(s.smoke.counts).map(([k, n]) => <Badge key={k} status={k}>{k} {n}</Badge>)}</p>
            {showChecks && (
              <Table>
                <tbody className="divide-y divide-slate-100">
                  {s.smoke.checks.map((c) => <tr key={c.id}><td className="py-1 pr-2 font-mono text-xs">{c.id}</td><td className="pr-2 text-xs">{c.check}</td><td><Badge status={c.verdict}>{c.verdict}</Badge></td></tr>)}
                </tbody>
              </Table>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
