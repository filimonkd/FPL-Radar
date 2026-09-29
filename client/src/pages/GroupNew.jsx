import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Hash, Search, Trophy } from 'lucide-react';
import { endpoints } from '../lib/api.js';
import { parseEntryIds, tieBreakChain } from '../lib/format.js';
import { Badge, Button, Card, ErrorBox, Field, Notice, Segmented, inputClass } from '../components/ui.jsx';
import { RuleChain } from '../components/RuleChain.jsx';

// Group form (v0.2 §10): from a classic league (anonymous standings, access
// classified by the server) or a manual list of entry IDs. Never asks for FPL
// credentials: a league that needs a login must be created as MANUAL.
export default function GroupNew() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [source, setSource] = useState('LEAGUE_STANDINGS');
  const [leagueId, setLeagueId] = useState('');
  const [entryText, setEntryText] = useState('');
  const [winnerRule, setWinnerRule] = useState('NET_POINTS');
  const [rules, setRules] = useState(['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL']);
  const [myEntryId, setMyEntryId] = useState('');
  const [candidates, setCandidates] = useState([]); // [{ entryId, playerName, teamName }]

  const preview = useMutation({
    mutationFn: () => endpoints.leaguePreview(Number(leagueId)),
    onSuccess: (p) => setCandidates(p.access === 'OK' ? p.members : []),
  });
  const validate = useMutation({
    mutationFn: () => endpoints.validateEntries(parseEntryIds(entryText).ids),
    onSuccess: (v) => setCandidates(v.valid),
  });
  const create = useMutation({
    mutationFn: () => endpoints.createGroup({
      name: name.trim(),
      memberSource: source,
      ...(source === 'LEAGUE_STANDINGS' ? { fplLeagueId: Number(leagueId) } : { entryIds: parseEntryIds(entryText).ids }),
      winnerRule,
      tieBreakRules: tieBreakChain(rules),
      myEntryId: myEntryId ? Number(myEntryId) : null,
    }),
    onSuccess: ({ group }) => { qc.invalidateQueries({ queryKey: ['groups'] }); navigate(`/groups/${group.id}/results`); },
  });

  const parsed = parseEntryIds(entryText);
  const validLeague = /^[1-9]\d*$/.test(leagueId);
  const canCreate = name.trim() && (source === 'LEAGUE_STANDINGS' ? validLeague : parsed.ids.length > 0 && parsed.bad.length === 0);
  const p = preview.data;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link to="/" className="inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink"><ArrowLeft size={16} />Groups</Link>
      <h1 className="text-2xl font-extrabold tracking-tight">New group</h1>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Card>
          <Field label="Name"><input className={inputClass} value={name} maxLength={60} placeholder="e.g. Office league" onChange={(e) => setName(e.target.value)} required /></Field>
        </Card>

        <Card title="Members">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Members">
            {[['LEAGUE_STANDINGS', 'From an FPL classic league', Trophy], ['MANUAL', 'Manual entry IDs', Hash]].map(([v, l, Icon]) => (
              <label key={v} className={`flex cursor-pointer flex-col gap-2 rounded-xl p-3 text-sm font-semibold ring-1 transition ${source === v ? 'bg-brand-soft ring-2 ring-brand' : 'ring-line hover:ring-brand/40'}`}>
                <input type="radio" name="source" className="sr-only" checked={source === v} onChange={() => { setSource(v); setCandidates([]); }} />
                <Icon size={20} className="text-brand dark:text-violet-300" aria-hidden="true" />{l}
              </label>
            ))}
          </div>

          {source === 'LEAGUE_STANDINGS' ? (
            <div className="mt-4 space-y-3">
              <Field label="League ID" hint="The number in the league's FPL URL. Only the public standings are read; no FPL login is ever used.">
                <div className="flex gap-2">
                  <input inputMode="numeric" className={inputClass} value={leagueId} onChange={(e) => setLeagueId(e.target.value.trim())} />
                  <Button variant="secondary" icon={Search} disabled={!validLeague || preview.isPending} onClick={() => preview.mutate()}>Preview</Button>
                </div>
              </Field>
              <ErrorBox error={preview.error} title="Preview failed" />
              {p && (
                <Notice tone={p.access === 'OK' ? 'good' : 'warn'} testId="league-preview">
                  <p className="flex flex-wrap items-center gap-2"><Badge status={p.access === 'OK' ? 'OK' : 'BLOCKED'}>{p.access}</Badge><strong>{p.league?.name ?? `League ${p.fplLeagueId}`}</strong>{p.access === 'OK' ? ` · ${p.members.length} members` : ''}</p>
                  {p.access === 'AUTH_REQUIRED' && <p className="mt-1">FPL requires a login for this league's standings. Use “Manual entry IDs” instead.</p>}
                  {p.access === 'EMPTY' && <p className="mt-1">The league has no members yet.</p>}
                  {p.access === 'NOT_FOUND' && <p className="mt-1">FPL does not know this league.</p>}
                  {p.configuredGroupId && <p className="mt-1">This league is already configured in another group (it may be archived).</p>}
                </Notice>
              )}
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <Field label="Entry IDs" hint="FPL team IDs, separated by commas, spaces or new lines.">
                <textarea rows={3} className={inputClass} value={entryText} onChange={(e) => setEntryText(e.target.value)} />
              </Field>
              {parsed.bad.length > 0 && <Notice>Not entry IDs: {parsed.bad.join(', ')}</Notice>}
              <Button variant="secondary" icon={Search} disabled={parsed.ids.length === 0 || validate.isPending} onClick={() => validate.mutate()}>Check entries</Button>
              <ErrorBox error={validate.error} title="Check failed" />
              {validate.data?.invalid.length > 0 && <Notice>Unknown on FPL: {validate.data.invalid.join(', ')}</Notice>}
            </div>
          )}

          {candidates.length > 0 && (
            <div className="mt-4">
              <Field label="Me (optional)" hint="Highlights your team; your rivals are everyone else.">
                <select className={inputClass} value={myEntryId} onChange={(e) => setMyEntryId(e.target.value)}>
                  <option value="">—</option>
                  {candidates.map((c) => <option key={c.entryId} value={c.entryId}>{c.teamName} ({c.playerName})</option>)}
                </select>
              </Field>
            </div>
          )}
        </Card>

        <Card title="Rules">
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold">Winner rule</p>
              <p className="mb-2 text-xs text-muted">Net subtracts transfer-hit points; gross does not.</p>
              <Segmented label="Winner rule" value={winnerRule} onChange={setWinnerRule} options={[['NET_POINTS', 'Net points'], ['GROSS_POINTS', 'Gross points']]} />
            </div>
            <RuleChain rules={rules} onChange={setRules} />
          </div>
        </Card>

        <ErrorBox error={create.error} title="Could not create the group" />
        <Button type="submit" className="w-full" disabled={!canCreate || create.isPending}>{create.isPending ? 'Creating…' : 'Create group'}</Button>
      </form>
    </div>
  );
}
