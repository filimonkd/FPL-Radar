import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Database, Layers, Scale } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { bytes, dateTime, seasonForDate } from '../lib/format.js';
import { Badge, Card, ErrorBox, Notice, Skeleton } from '../components/ui.jsx';

// Status page (admin; v0.3 §9, §15 step 11): points semantics exactly as
// stored, chip-rule source, storage gauge, recent runs, smoke verdicts.
function Tile({ icon: Icon, title, children }) {
  return (
    <div className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
      <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted"><Icon size={14} aria-hidden="true" />{title}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

export default function Status() {
  const [season, setSeason] = useState(seasonForDate());
  const status = useQuery({ queryKey: ['status', season], queryFn: () => endpoints.status(season) });
  const [showChecks, setShowChecks] = useState(false);
  if (status.isLoading) return <Skeleton rows={5} />;
  if (status.error) return <ErrorBox error={status.error} title="Status unavailable" />;
  const s = status.data.status;
  const st = s.storage;
  const usedPct = st?.usedPct ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Status</h1>
          <p className="text-sm text-muted">Sync health, storage and FPL contract checks.</p>
        </div>
        <input aria-label="Season" className="min-h-10 w-24 rounded-xl bg-surface px-3 text-sm font-semibold ring-1 ring-line" value={season} onChange={(e) => setSeason(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile icon={Scale} title="Points semantics">
          {s.semantics ? (
            <>
              <Badge status={s.semantics.value} testId="semantics">{s.semantics.value}</Badge>
              <p className="mt-2 text-xs text-muted">{s.semantics.evidenceRows} evidence rows · {s.semantics.conflictRows} conflicting</p>
            </>
          ) : <p className="text-sm text-muted">No season data yet.</p>}
        </Tile>
        <Tile icon={Layers} title="Chip rules">
          {s.chipRules ? (
            <>
              <Badge tone={s.chipRules.source === 'FPL_BOOTSTRAP' ? 'good' : 'warn'}>{s.chipRules.source}</Badge>
              <p className="mt-2 text-xs text-muted">{s.chipRules.rules} rules · confirmed {dateTime(s.chipRules.lastConfirmedAt)}</p>
            </>
          ) : <p className="text-sm text-muted">Not synced.</p>}
        </Tile>
        <Tile icon={Database} title="Storage">
          {st ? (
            <>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPct} aria-label="Storage used">
                <div className={`h-full rounded-full ${st.warning ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.max(2, Math.min(100, usedPct))}%` }} />
              </div>
              <p className="mt-2 text-xs text-muted" data-testid="storage">{bytes(st.usedBytes)} of {bytes(st.quotaBytes)} ({usedPct}%)</p>
              {st.warning && <div className="mt-2"><Notice>Above 60% of the free-tier quota.</Notice></div>}
            </>
          ) : <p className="text-sm text-muted">Unavailable.</p>}
        </Tile>
      </div>

      <Card title="Recent sync runs" padded={false}>
        {s.runs.length === 0 && <p className="px-4 pb-4 text-sm text-muted sm:px-5">No runs yet.</p>}
        <ul className="divide-y divide-line" data-testid="runs">
          {s.runs.map((r) => (
            <li key={r.id}>
              <Link to={`/status/runs/${r.id}`} aria-label="Details" className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 sm:px-5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">{r.job}{r.event ? ` · GW${r.event}` : ''} <Badge status={r.status}>{r.status}</Badge></p>
                  <p className="truncate text-xs text-muted">{dateTime(r.startedAt)} · {r.trigger} · {r.requests} requests{r.failures.length ? ` · ${r.failures.length} failed` : ''}</p>
                </div>
                <ChevronRight size={18} className="text-muted" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="FPL smoke test" actions={s.smoke?.available && <button type="button" className="text-sm font-semibold text-brand underline" onClick={() => setShowChecks((v) => !v)}>{showChecks ? 'Hide checks' : 'Show checks'}</button>}>
        {!s.smoke?.available ? <p className="text-sm text-muted">No committed smoke report for {season}.</p> : (
          <>
            <p className="text-sm">{s.smoke.exit}</p>
            <p className="mt-2 flex flex-wrap gap-1.5">{Object.entries(s.smoke.counts).map(([k, n]) => <Badge key={k} status={k}>{k} {n}</Badge>)}</p>
            {showChecks && (
              <ul className="mt-3 divide-y divide-line text-sm">
                {s.smoke.checks.map((c) => <li key={c.id} className="flex items-start gap-2 py-2"><span className="w-8 shrink-0 font-mono text-xs text-muted">{c.id}</span><span className="flex-1 text-xs">{c.check}</span><Badge status={c.verdict}>{c.verdict}</Badge></li>)}
              </ul>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
