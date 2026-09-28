import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '../lib/api.js';
import { announcement, dateTime, explain, managerName, points, rankLabel, shortHash, validNote } from '../lib/format.js';
import { Badge, Button, Card, Drawer, ErrorBox, Field, Notice, Spinner, Table, inputClass } from '../components/ui.jsx';

// Results page (v0.2 §3–§4, §6; v0.3 §7): standings with "=" ranks and
// tie-break explanations, the finalize gate's reasons, admin actions
// (sync / finalize / override / recompute), the History drawer with the
// chain badge, the trace link and the announcement text.

export default function Results({ group, season, gw, isAdmin }) {
  const qc = useQueryClient();
  const key = ['result', group.id, season, gw];
  const result = useQuery({ queryKey: key, queryFn: () => endpoints.result(group.id, gw, season) });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [panel, setPanel] = useState(null); // 'override' | 'recompute'
  const [copied, setCopied] = useState(false);
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['result', group.id] }),
    qc.invalidateQueries({ queryKey: ['actions', group.id] }),
    qc.invalidateQueries({ queryKey: ['events', season] }),
    qc.invalidateQueries({ queryKey: ['ownership', group.id] }),
    qc.invalidateQueries({ queryKey: ['chips', group.id] }),
  ]);
  const sync = useMutation({ mutationFn: () => endpoints.sync(group.id, season, gw), onSuccess: refresh });
  const finalize = useMutation({ mutationFn: () => endpoints.finalize(group.id, gw, season), onSuccess: refresh });

  if (result.isLoading) return <Spinner />;
  if (result.error) return <ErrorBox error={result.error} title="Result unavailable" />;
  const r = result.data.result;
  const decided = r.status === 'FINAL' || r.status === 'OVERRIDDEN';
  const text = announcement(r, group.name);
  const shared = r.winners.length > 1;
  const readOnly = !group.isActive;

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  };

  return (
    <div className="space-y-4">
      <Card
        title={<span className="flex flex-wrap items-center gap-2">GW{r.event} result <Badge status={r.status} testId="result-status">{r.status}</Badge>{r.eventState && <Badge tone="neutral">{r.eventState.replace('_', ' ')}</Badge>}</span>}
        actions={<Button variant="secondary" onClick={() => setHistoryOpen(true)} data-testid="open-history">History</Button>}
      >
        {r.winners.length > 0 ? (
          <p className="text-lg" data-testid="winners">
            {decided ? 'Winner' : 'Leading'}{shared ? 's' : ''}: <strong>{r.winners.map((id) => managerName(r.standings, id)).join(' · ')}</strong>
            {r.winningScore != null && <span className="text-slate-600"> — {r.winningScore} pts</span>}
            {shared && <> <Badge tone="info">shared</Badge></>}
          </p>
        ) : <p className="text-slate-600">No winner yet.</p>}
        {r.status === 'OVERRIDDEN' && r.computedWinners && (
          <p className="mt-1 text-sm text-slate-600">Declared by the admin. The rules computed: {r.computedWinners.map((id) => managerName(r.standings, id)).join(', ') || 'no winner'}.</p>
        )}
        {r.tieBreakApplied && <p className="mt-1 text-sm text-slate-600">Tie decided by: {explain(r.tieBreakApplied)}</p>}
        {r.warnings?.length > 0 && (
          <ul className="mt-3 space-y-1">{r.warnings.map((w, i) => <li key={i}><Notice>{explain(w.code)}</Notice></li>)}</ul>
        )}
        {r.blockedBy?.length > 0 && (
          <Notice testId="blocked-by">Blocked: {r.blockedBy.map((b) => `${managerName(r.standings, b.entryId)} — ${explain(b.reconciliationStatus)}`).join('; ')}</Notice>
        )}
        {decided && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {text && <Button variant="secondary" onClick={copy} data-testid="copy-announcement">{copied ? 'Copied' : 'Copy announcement'}</Button>}
            {r.currentSnapshotId && <Link className="text-sm text-indigo-700 underline" to={`/snapshots/${r.currentSnapshotId}`} data-testid="trace-link">Trace this result</Link>}
          </div>
        )}
        {text && <p className="mt-2 rounded bg-slate-50 p-2 text-sm text-slate-700" data-testid="announcement">{text}</p>}
      </Card>

      {isAdmin && (
        <Card title="Admin">
          {readOnly && <Notice>This group is archived: results are read-only. Unarchive it in Settings to make changes.</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={readOnly || sync.isPending} onClick={() => sync.mutate()} data-testid="sync">{sync.isPending ? 'Syncing…' : 'Sync from FPL'}</Button>
            {!decided && <Button disabled={readOnly || finalize.isPending} onClick={() => finalize.mutate()} data-testid="finalize">{finalize.isPending ? 'Finalizing…' : 'Finalize'}</Button>}
            <Button variant="secondary" disabled={readOnly} onClick={() => setPanel(panel === 'override' ? null : 'override')}>Override…</Button>
            {decided && <Button variant="secondary" disabled={readOnly} onClick={() => setPanel(panel === 'recompute' ? null : 'recompute')}>Recompute…</Button>}
          </div>
          {!decided && (
            <div className="mt-3 text-sm" data-testid="finalize-gate">
              {r.finalizeGate.allowed ? <p className="text-green-800">Ready to finalize (a fresh sync runs first).</p> : (
                <>
                  <p className="font-medium">Finalize is blocked right now:</p>
                  <ul className="list-disc pl-5 text-slate-700">{r.finalizeGate.reasons.map((x) => <li key={x}>{explain(x)}</li>)}</ul>
                </>
              )}
            </div>
          )}
          {sync.data && <Notice tone={sync.data.run.status === 'SUCCESS' ? 'good' : 'warn'} testId="sync-result">Sync {sync.data.run.status}{sync.data.run.failures.length ? `: ${sync.data.run.failures.map((f) => `${f.entryId ?? ''} ${f.code}`).join(', ')}` : ''}</Notice>}
          <div className="mt-2 space-y-2">
            <ErrorBox error={sync.error} title="Sync failed" />
            <ErrorBox error={finalize.error} title="Finalize refused" />
          </div>
          {panel === 'override' && <OverridePanel group={group} season={season} gw={gw} result={r} onDone={() => { setPanel(null); refresh(); }} />}
          {panel === 'recompute' && <RecomputePanel group={group} season={season} gw={gw} result={r} onDone={() => { setPanel(null); refresh(); }} />}
        </Card>
      )}

      <Card title="Standings">
        <Standings result={r} />
      </Card>

      <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} group={group} season={season} gw={gw} standings={r.standings} isAdmin={isAdmin} />
    </div>
  );
}

function Standings({ result }) {
  const [explainFor, setExplainFor] = useState(null);
  const rows = [...result.standings].sort((a, b) => (a.resolvedPosition ?? 1e9) - (b.resolvedPosition ?? 1e9));
  return (
    <Table testId="standings">
      <thead className="text-xs uppercase text-slate-500">
        <tr><th className="py-2 pr-2">Rank</th><th className="pr-2">Manager</th><th className="pr-2 text-right">Score</th><th className="pr-2 text-right">Hits</th><th>Status</th></tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((s) => (
          <tr key={s.entryId} className={s.isMe ? 'bg-indigo-50/60' : ''} data-testid={`row-${s.entryId}`}>
            <td className="py-2 pr-2 font-mono">
              {rankLabel(s)}
              {s.positionDecidedBy && (
                <button type="button" className="ml-1 text-indigo-700" aria-label="Why this position" onClick={() => setExplainFor(explainFor === s.entryId ? null : s.entryId)}>ⓘ</button>
              )}
              {explainFor === s.entryId && <span className="block text-xs text-slate-600">{explain(s.positionDecidedBy)}</span>}
            </td>
            <td className="pr-2">
              <span className="font-medium">{s.teamName}</span> <span className="text-slate-500">{s.playerName}</span>
              {s.isWinner && <> <Badge tone="good">winner</Badge></>}{s.isMe && <> <Badge tone="info">me</Badge></>}
            </td>
            <td className="pr-2 text-right font-mono">{points(s.score)}</td>
            <td className="pr-2 text-right font-mono">{s.transferCost ? `-${s.transferCost}` : points(s.transferCost)}</td>
            <td className="text-xs">{s.ineligibleReason ? <Badge tone="neutral">{explain(s.ineligibleReason)}</Badge> : <Badge status={s.reconciliationStatus?.startsWith('RECONCILED') ? 'OK' : 'BLOCKED'}>{explain(s.reconciliationStatus)}</Badge>}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function OverridePanel({ group, season, gw, result, onDone }) {
  const eligible = result.standings.filter((s) => !s.ineligibleReason);
  const [winners, setWinners] = useState([]);
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => endpoints.override(group.id, gw, season, winners, note.trim()), onSuccess: onDone });
  const toggle = (id) => setWinners((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]));
  return (
    <form className="mt-4 space-y-3 border-t border-slate-100 pt-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }} data-testid="override-panel">
      <p className="text-sm text-slate-600">Declare the winner(s) yourself. The rule-based standings stay recorded next to your decision.</p>
      <fieldset className="space-y-1 text-sm">
        {eligible.map((s) => <label key={s.entryId} className="flex items-center gap-2"><input type="checkbox" checked={winners.includes(s.entryId)} onChange={() => toggle(s.entryId)} />{s.teamName} ({s.playerName})</label>)}
      </fieldset>
      <Field label="Note (required, 3–280 characters)"><textarea rows={2} maxLength={280} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <ErrorBox error={m.error} title="Override refused" />
      <Button type="submit" disabled={winners.length === 0 || !validNote(note) || m.isPending}>Declare winner{winners.length > 1 ? 's' : ''}</Button>
    </form>
  );
}

function RecomputePanel({ group, season, gw, result, onDone }) {
  const [note, setNote] = useState('');
  const preview = useMutation({ mutationFn: () => endpoints.recompute(group.id, gw, season, { dryRun: true }) });
  const commit = useMutation({ mutationFn: () => endpoints.recompute(group.id, gw, season, { dryRun: false, note: note.trim() || undefined }), onSuccess: onDone });
  const d = preview.data?.diff;
  const needsNote = d?.winnersChanged;
  const names = (ids) => ids.map((id) => managerName(result.standings, id)).join(', ') || 'none';
  return (
    <div className="mt-4 space-y-3 border-t border-slate-100 pt-4" data-testid="recompute-panel">
      <p className="text-sm text-slate-600">Re-run the rules on the current data. Preview first; nothing is written until you commit.</p>
      <Button variant="secondary" disabled={preview.isPending} onClick={() => preview.mutate()}>Preview</Button>
      <ErrorBox error={preview.error} title="Recompute refused" />
      {d && (
        <div className="space-y-2 text-sm">
          <p>Winners: {names(d.oldWinners)} → <strong>{names(d.newWinners)}</strong> {d.winnersChanged ? <Badge tone="warn">changes</Badge> : <Badge tone="good">unchanged</Badge>}</p>
          {d.changedEntryIds.length > 0 && <p>Changed rows: {names(d.changedEntryIds)}</p>}
          {needsNote && <Field label="Note (required because the winners change)"><textarea rows={2} maxLength={280} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
          <ErrorBox error={commit.error} title="Commit refused" />
          <Button disabled={commit.isPending || (needsNote && !validNote(note))} onClick={() => commit.mutate()}>Commit recompute</Button>
        </div>
      )}
    </div>
  );
}

function HistoryDrawer({ open, onClose, group, season, gw, standings, isAdmin }) {
  const actions = useQuery({ queryKey: ['actions', group.id, season, gw], queryFn: () => endpoints.actions(group.id, gw, season), enabled: open });
  const verify = useQuery({ queryKey: ['actions', group.id, season, gw, 'verify'], queryFn: () => endpoints.verifyChain(group.id, gw, season), enabled: open });
  const names = (ids) => (ids.length ? ids.map((id) => managerName(standings, id)).join(', ') : '—');
  const list = [...(actions.data?.actions ?? [])].sort((a, b) => b.seq - a.seq);
  return (
    <Drawer open={open} onClose={onClose} title={`History · GW${gw}`} testId="history-drawer">
      <div className="mb-3">
        {verify.error ? <Badge tone="bad">Chain check failed</Badge>
          : !verify.data ? <Badge tone="neutral">Checking chain…</Badge>
            : verify.data.valid ? <Badge tone="good" testId="chain-badge">Chain valid</Badge>
              : <Badge tone="bad" testId="chain-badge">Chain broken at #{verify.data.brokenAtSeq}: {verify.data.reason}</Badge>}
      </div>
      {actions.isLoading && <Spinner />}
      <ErrorBox error={actions.error} />
      {actions.data && list.length === 0 && <p className="text-sm text-slate-600">No decisions yet for this gameweek.</p>}
      <ol className="space-y-3">
        {list.map((a) => (
          <li key={a.id} className="rounded-md p-3 ring-1 ring-slate-200" data-testid={`action-${a.seq}`}>
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">#{a.seq} {a.action} <Badge status={a.prevStatus}>{a.prevStatus}</Badge>→<Badge status={a.newStatus}>{a.newStatus}</Badge></p>
            <p className="mt-1 text-sm">{names(a.prevWinnerEntryIds)} → <strong>{names(a.newWinnerEntryIds)}</strong></p>
            {a.note && <p className="mt-1 text-sm italic text-slate-700">“{a.note}”</p>}
            <p className="mt-1 text-xs text-slate-500">{dateTime(a.createdAt)} · {a.actor} · hash {shortHash(a.hash)}</p>
            <p className="mt-1 flex flex-wrap gap-3 text-xs">
              <Link className="text-indigo-700 underline" to={`/snapshots/${a.newSnapshotId}`}>Snapshot</Link>
              {a.syncRunId && (isAdmin ? <Link className="text-indigo-700 underline" to={`/status/runs/${a.syncRunId}`}>Sync run</Link> : <span className="text-slate-500">run {a.syncRunId.slice(-6)}</span>)}
            </p>
          </li>
        ))}
      </ol>
    </Drawer>
  );
}
