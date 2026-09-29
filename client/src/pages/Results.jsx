import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Crown, FileSearch, Gavel, History, Info, RefreshCw, RotateCcw, ShieldAlert, ShieldCheck, Trophy } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { announcement, dateTime, explain, managerName, namesList, points, rankLabel, shortHash, validNote, whatsappSummary } from '../lib/format.js';
import { Avatar, Badge, Button, Card, Drawer, ErrorBox, Field, Notice, Skeleton, inputClass } from '../components/ui.jsx';
import { Podium } from '../components/Podium.jsx';
import { WhatsAppShare } from '../components/WhatsAppShare.jsx';
import { SquadAlerts } from '../components/SquadAlerts.jsx';

// Results page (v0.2 §3–§4, §6; v0.3 §7): the decision up top, admin actions,
// standings as tappable cards ("=" ranks, tie-break explanations,
// reconciliation), the History sheet with the chain badge, the trace link and
// the announcement text.

export default function Results({ group, season, gw, isAdmin }) {
  const qc = useQueryClient();
  const key = ['result', group.id, season, gw];
  const result = useQuery({ queryKey: key, queryFn: () => endpoints.result(group.id, gw, season) });
  const rivals = useQuery({ queryKey: ['rivals', group.id, season, gw], queryFn: () => endpoints.rivals(group.id, gw, season) });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [panel, setPanel] = useState(null); // 'override' | 'recompute'
  const [copied, setCopied] = useState(false);
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['result', group.id] }),
    qc.invalidateQueries({ queryKey: ['actions', group.id] }),
    qc.invalidateQueries({ queryKey: ['events', season] }),
    qc.invalidateQueries({ queryKey: ['ownership', group.id] }),
    qc.invalidateQueries({ queryKey: ['chips', group.id] }),
    qc.invalidateQueries({ queryKey: ['rivals', group.id] }),
    qc.invalidateQueries({ queryKey: ['news', group.id] }),
  ]);
  const sync = useMutation({ mutationFn: () => endpoints.sync(group.id, season, gw), onSuccess: refresh });
  const finalize = useMutation({ mutationFn: () => endpoints.finalize(group.id, gw, season), onSuccess: refresh });

  if (result.isLoading) return <Skeleton rows={5} />;
  if (result.error) return <ErrorBox error={result.error} title="Result unavailable" />;
  const r = result.data.result;
  const decided = r.status === 'FINAL' || r.status === 'OVERRIDDEN';
  const text = announcement(r, group.name);
  const shared = r.winners.length > 1;
  const readOnly = !group.isActive;
  const winnerRows = r.winners.map((id) => r.standings.find((s) => s.entryId === id)).filter(Boolean);

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  };

  return (
    <div className="space-y-4">
      <SquadAlerts group={group} season={season} gw={gw} />
      {/* The decision */}
      <section className={`overflow-hidden rounded-2xl shadow-sm ring-1 ${decided ? 'bg-gradient-to-br from-[#4c1d95] to-[#7c3aed] text-white ring-transparent' : 'bg-surface ring-line'}`}>
        <div className="p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${decided ? 'bg-white/20 text-white' : ''}`} data-testid="result-status">
                {decided ? r.status : <Badge status={r.status}>{r.status}</Badge>}
              </span>
              <span className={`text-sm font-semibold ${decided ? 'text-white/80' : 'text-muted'}`}>Gameweek {r.event}</span>
            </div>
            <Button variant={decided ? 'subtle' : 'secondary'} size="sm" icon={History} onClick={() => setHistoryOpen(true)} data-testid="open-history" className={decided ? 'bg-white/15! text-white! hover:bg-white/25!' : ''}>History</Button>
          </div>

          {winnerRows.length > 0 ? (
            <div className="mt-4" data-testid="winners">
              <p className={`text-xs font-bold uppercase tracking-wider ${decided ? 'text-white/70' : 'text-muted'}`}>{decided ? `Winner${shared ? 's' : ''}` : `Leading${shared ? ' (tied)' : ''}`}{shared && ' · shared'}</p>
              <ul className="mt-2 space-y-2">
                {winnerRows.slice(0, winnerRows.length > 4 ? 3 : 4).map((w) => (
                  <li key={w.entryId} className="flex items-center gap-3">
                    <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${decided ? 'bg-amber-300 text-amber-900' : 'bg-brand-soft text-brand'}`}><Crown size={20} aria-hidden="true" /></span>
                    <span className="min-w-0">
                      <span className="block truncate text-lg font-extrabold">{w.teamName}</span>
                      <span className={`block truncate text-sm ${decided ? 'text-white/75' : 'text-muted'}`}>{w.playerName}</span>
                    </span>
                    {r.winningScore != null && <span className="ml-auto text-3xl font-black tabular">{r.winningScore}<span className="ml-0.5 text-sm font-semibold opacity-70">pts</span></span>}
                  </li>
                ))}
              </ul>
              {winnerRows.length > 4 && <p className={`mt-2 text-sm font-semibold ${decided ? 'text-white/80' : 'text-muted'}`}>+{winnerRows.length - 3} more share the win — see standings</p>}
              <p className="sr-only">{decided ? 'Winner' : 'Leading'}{shared ? 's' : ''}: {r.winners.map((id) => managerName(r.standings, id)).join(' · ')}{r.winningScore != null ? ` — ${r.winningScore} pts` : ''}</p>
            </div>
          ) : (
            <p className="mt-4 flex items-center gap-2 text-muted"><Trophy size={18} aria-hidden="true" />No winner yet.</p>
          )}

          {r.status === 'OVERRIDDEN' && r.computedWinners && (
            <p className="mt-3 text-sm text-white/80">Declared by the admin. The rules computed: {r.computedWinners.map((id) => managerName(r.standings, id)).join(', ') || 'no winner'}.</p>
          )}
          {r.tieBreakApplied && <p className={`mt-2 text-sm ${decided ? 'text-white/80' : 'text-muted'}`}>Tie decided by: {explain(r.tieBreakApplied)}</p>}

          {decided && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {text && <Button size="sm" variant="subtle" icon={copied ? Check : Copy} onClick={copy} data-testid="copy-announcement" className="bg-white! text-[#4c1d95]!">{copied ? 'Copied' : 'Copy announcement'}</Button>}
              {r.currentSnapshotId && (
                <Link className="inline-flex min-h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-white/90 ring-1 ring-white/30 hover:bg-white/10" to={`/snapshots/${r.currentSnapshotId}`} data-testid="trace-link"><FileSearch size={16} aria-hidden="true" />Trace this result</Link>
              )}
            </div>
          )}
          {text && <p className="mt-3 rounded-xl bg-black/15 p-3 text-sm text-white/90" data-testid="announcement">{text}</p>}
        </div>
      </section>

      {rivals.data?.rivals.podium.length > 0 && (
        <Card title="Overall standings" subtitle={`FPL season totals after GW${gw}`}>
          <Podium podium={rivals.data.rivals.podium} testId="podium" />
          <div className="mt-4 border-t border-line pt-4">
            <WhatsAppShare text={whatsappSummary({ groupName: group.name, season, result: r, rivals: rivals.data.rivals })} />
          </div>
        </Card>
      )}

      {(r.warnings?.length > 0 || r.blockedBy?.length > 0) && (
        <div className="space-y-2">
          {r.warnings.map((w, i) => <Notice key={i}>{explain(w.code)}</Notice>)}
          {r.blockedBy?.length > 0 && (
            <Notice testId="blocked-by">Blocked: {r.blockedBy.map((b) => `${managerName(r.standings, b.entryId)} — ${explain(b.reconciliationStatus)}`).join('; ')}</Notice>
          )}
        </div>
      )}

      {isAdmin && (
        <Card title="Admin" subtitle={readOnly ? 'This group is archived: results are read-only. Unarchive it in Settings.' : undefined}>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <Button variant="secondary" icon={RefreshCw} disabled={readOnly || sync.isPending} onClick={() => sync.mutate()} data-testid="sync">{sync.isPending ? 'Syncing…' : 'Sync'}</Button>
            {!decided && <Button icon={Gavel} disabled={readOnly || finalize.isPending} onClick={() => finalize.mutate()} data-testid="finalize">{finalize.isPending ? 'Finalizing…' : 'Finalize'}</Button>}
            <Button variant="secondary" disabled={readOnly} onClick={() => setPanel(panel === 'override' ? null : 'override')}>Override…</Button>
            {decided && <Button variant="secondary" icon={RotateCcw} disabled={readOnly} onClick={() => setPanel(panel === 'recompute' ? null : 'recompute')}>Recompute…</Button>}
          </div>
          {!decided && (
            <div className="mt-3 rounded-xl bg-surface-2 p-3 text-sm" data-testid="finalize-gate">
              {r.finalizeGate.allowed ? <p className="flex items-center gap-2 font-semibold text-emerald-700 dark:text-emerald-300"><ShieldCheck size={16} />Ready to finalize (a fresh sync runs first).</p> : (
                <>
                  <p className="font-semibold">Finalize is blocked right now:</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">{r.finalizeGate.reasons.map((x) => <li key={x}>{explain(x)}</li>)}</ul>
                </>
              )}
            </div>
          )}
          <div className="mt-3 space-y-2">
            {sync.data && (
              <Notice tone={sync.data.run.status === 'SUCCESS' ? 'good' : 'warn'} testId="sync-result">
                <p>Sync {sync.data.run.status}{sync.data.run.failures.length ? ` · ${sync.data.run.failures.length} failed` : ''}</p>
                {sync.data.run.failures.length > 0 && (
                  <ul className="mt-1 space-y-1" data-testid="sync-failures">
                    {sync.data.run.failures.map((f, i) => (
                      <li key={i} className="break-words">
                        <span className="font-semibold">{f.entryId != null ? managerName(r.standings, f.entryId) : 'Run'}</span> · {f.code}
                        {f.message && <span className="block font-mono text-xs opacity-80">{f.message}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <Link className="mt-1 inline-block text-xs font-semibold underline" to={`/status/runs/${sync.data.run.runId}`}>Run details</Link>
              </Notice>
            )}
            <ErrorBox error={sync.error} title="Sync failed" />
            <ErrorBox error={finalize.error} title="Finalize refused" />
          </div>
          {panel === 'override' && <OverridePanel group={group} season={season} gw={gw} result={r} onDone={() => { setPanel(null); refresh(); }} />}
          {panel === 'recompute' && <RecomputePanel group={group} season={season} gw={gw} result={r} onDone={() => { setPanel(null); refresh(); }} />}
        </Card>
      )}

      <Card title="Standings" padded={false}>
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
    <ol className="divide-y divide-line" data-testid="standings">
      {rows.map((s) => {
        const ok = s.reconciliationStatus?.startsWith('RECONCILED');
        return (
          <li key={s.entryId} className={`px-4 py-3 sm:px-5 ${s.isMe ? 'bg-brand-soft/60' : ''}`} data-testid={`row-${s.entryId}`}>
            <div className="flex items-center gap-3">
              <span className={`w-9 shrink-0 text-center text-lg font-black tabular ${s.isWinner ? 'text-amber-500' : 'text-muted'}`} data-testid={`rank-${s.entryId}`}>{rankLabel(s)}</span>
              <Avatar name={s.teamName} id={s.entryId} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate font-bold">
                  <span className="truncate">{s.teamName}</span>
                  {s.isWinner && <Crown size={14} className="shrink-0 text-amber-500" aria-label="winner" />}
                  {s.isMe && <Badge tone="info">me</Badge>}
                </p>
                <p className="truncate text-sm text-muted">{s.playerName}</p>
              </div>
              <div className="text-right">
                <p className="text-xl font-black tabular">{points(s.score)}</p>
                {s.transferCost ? <p className="text-xs font-semibold text-rose-600 dark:text-rose-300">−{s.transferCost} hits</p> : null}
              </div>
            </div>
            {(s.ineligibleReason || !ok || s.positionDecidedBy) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-12">
                {s.ineligibleReason ? <Badge tone="neutral">{explain(s.ineligibleReason)}</Badge>
                  : !ok && <Badge tone="bad" icon={ShieldAlert}>{explain(s.reconciliationStatus)}</Badge>}
                {s.positionDecidedBy && (
                  <button type="button" onClick={() => setExplainFor(explainFor === s.entryId ? null : s.entryId)} aria-label="Why this position" className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-brand ring-1 ring-line dark:text-violet-300">
                    <Info size={12} />tie-break
                  </button>
                )}
                {explainFor === s.entryId && <span className="w-full text-xs text-muted">{explain(s.positionDecidedBy)}</span>}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function OverridePanel({ group, season, gw, result, onDone }) {
  const eligible = result.standings.filter((s) => !s.ineligibleReason);
  const [winners, setWinners] = useState([]);
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => endpoints.override(group.id, gw, season, winners, note.trim()), onSuccess: onDone });
  const toggle = (id) => setWinners((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]));
  return (
    <form className="mt-4 space-y-3 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }} data-testid="override-panel">
      <p className="text-sm text-muted">Declare the winner(s) yourself. The rule-based standings stay recorded next to your decision.</p>
      <fieldset className="space-y-1.5">
        {eligible.map((s) => (
          <label key={s.entryId} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 ring-1 transition ${winners.includes(s.entryId) ? 'bg-brand-soft ring-brand/40' : 'ring-line'}`}>
            <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={winners.includes(s.entryId)} onChange={() => toggle(s.entryId)} />
            <span className="text-sm font-medium">{s.teamName} ({s.playerName})</span>
          </label>
        ))}
      </fieldset>
      <Field label="Note (required, 3–280 characters)"><textarea rows={2} maxLength={280} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <ErrorBox error={m.error} title="Override refused" />
      <Button type="submit" className="w-full sm:w-auto" disabled={winners.length === 0 || !validNote(note) || m.isPending}>Declare winner{winners.length > 1 ? 's' : ''}</Button>
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
    <div className="mt-4 space-y-3 border-t border-line pt-4" data-testid="recompute-panel">
      <p className="text-sm text-muted">Re-run the rules on the current data. Preview first; nothing is written until you commit.</p>
      <Button variant="secondary" disabled={preview.isPending} onClick={() => preview.mutate()}>Preview</Button>
      <ErrorBox error={preview.error} title="Recompute refused" />
      {d && (
        <div className="space-y-2 rounded-xl bg-surface-2 p-3 text-sm">
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
  const names = (ids) => namesList(standings, ids);
  const list = [...(actions.data?.actions ?? [])].sort((a, b) => b.seq - a.seq);
  return (
    <Drawer open={open} onClose={onClose} title={`History · GW${gw}`} testId="history-drawer">
      <div className="mb-4">
        {verify.error ? <Badge tone="bad">Chain check failed</Badge>
          : !verify.data ? <Badge tone="neutral">Checking chain…</Badge>
            : verify.data.valid ? <Badge tone="good" icon={ShieldCheck} testId="chain-badge">Chain valid</Badge>
              : <Badge tone="bad" icon={ShieldAlert} testId="chain-badge">Chain broken at #{verify.data.brokenAtSeq}: {verify.data.reason}</Badge>}
      </div>
      {actions.isLoading && <Skeleton rows={2} />}
      <ErrorBox error={actions.error} />
      {actions.data && list.length === 0 && <p className="text-sm text-muted">No decisions yet for this gameweek.</p>}
      <ol className="relative space-y-4 border-l-2 border-line pl-5">
        {list.map((a) => (
          <li key={a.id} className="relative" data-testid={`action-${a.seq}`}>
            <span className="absolute -left-[27px] top-1 grid h-4 w-4 place-items-center rounded-full bg-brand ring-4 ring-surface" aria-hidden="true" />
            <p className="flex flex-wrap items-center gap-2 text-sm font-bold">#{a.seq} {a.action} <Badge status={a.prevStatus}>{a.prevStatus}</Badge>→<Badge status={a.newStatus}>{a.newStatus}</Badge></p>
            <p className="mt-1 text-sm">{names(a.prevWinnerEntryIds)} → <strong>{names(a.newWinnerEntryIds)}</strong></p>
            {a.note && <p className="mt-1 rounded-lg bg-surface-2 px-3 py-2 text-sm italic">“{a.note}”</p>}
            <p className="mt-1 text-xs text-muted">{dateTime(a.createdAt)} · {a.actor} · hash {shortHash(a.hash)}</p>
            <p className="mt-1 flex flex-wrap gap-3 text-xs font-semibold">
              <Link className="text-brand underline dark:text-violet-300" to={`/snapshots/${a.newSnapshotId}`}>Snapshot</Link>
              {a.syncRunId && (isAdmin ? <Link className="text-brand underline dark:text-violet-300" to={`/status/runs/${a.syncRunId}`}>Sync run</Link> : <span className="text-muted">run {a.syncRunId.slice(-6)}</span>)}
            </p>
          </li>
        ))}
      </ol>
    </Drawer>
  );
}
