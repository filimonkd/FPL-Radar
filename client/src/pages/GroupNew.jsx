import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '../lib/api.js';
import { parseEntryIds, tieBreakChain, explain } from '../lib/format.js';
import { Badge, Button, Card, ErrorBox, Field, Notice, inputClass } from '../components/ui.jsx';

// Group form (v0.2 §10): from a classic league (anonymous standings, access
// classified by the server) or a manual list of entry IDs. Never asks for FPL
// credentials: a league that needs a login must be created as MANUAL.
const RULE_OPTIONS = ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'HIGHER_CAPTAIN_POINTS', 'NO_CHIP_PLAYED'];

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
  const toggleRule = (r) => setRules((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));
  const move = (i, d) => setRules((cur) => { const n = [...cur]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n; });
  const canCreate = name.trim() && (source === 'LEAGUE_STANDINGS' ? /^[1-9]\d*$/.test(leagueId) : parsed.ids.length > 0 && parsed.bad.length === 0);
  const p = preview.data;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">New group</h1>
      <Card>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Name"><input className={inputClass} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required /></Field>

          <fieldset className="text-sm">
            <legend className="font-medium text-slate-800">Members</legend>
            <div className="mt-2 flex gap-4">
              {[['LEAGUE_STANDINGS', 'From an FPL classic league'], ['MANUAL', 'Manual entry IDs']].map(([v, l]) => (
                <label key={v} className="flex items-center gap-2"><input type="radio" name="source" checked={source === v} onChange={() => { setSource(v); setCandidates([]); }} />{l}</label>
              ))}
            </div>
          </fieldset>

          {source === 'LEAGUE_STANDINGS' ? (
            <div className="space-y-2">
              <Field label="League ID" hint="The number in the league's FPL URL. Only the public standings are read; no FPL login is ever used.">
                <div className="flex gap-2">
                  <input inputMode="numeric" className={inputClass} value={leagueId} onChange={(e) => setLeagueId(e.target.value.trim())} />
                  <Button variant="secondary" disabled={!/^[1-9]\d*$/.test(leagueId) || preview.isPending} onClick={() => preview.mutate()}>Preview</Button>
                </div>
              </Field>
              <ErrorBox error={preview.error} title="Preview failed" />
              {p && (
                <Notice tone={p.access === 'OK' ? 'good' : 'warn'} testId="league-preview">
                  <p><Badge status={p.access === 'OK' ? 'OK' : 'BLOCKED'}>{p.access}</Badge> {p.league?.name ?? `League ${p.fplLeagueId}`}{p.access === 'OK' ? ` · ${p.members.length} members` : ''}</p>
                  {p.access === 'AUTH_REQUIRED' && <p className="mt-1">FPL requires a login for this league's standings. Use “Manual entry IDs” instead.</p>}
                  {p.access === 'EMPTY' && <p className="mt-1">The league has no members yet.</p>}
                  {p.access === 'NOT_FOUND' && <p className="mt-1">FPL does not know this league.</p>}
                  {p.configuredGroupId && <p className="mt-1">This league is already configured in another group (it may be archived).</p>}
                </Notice>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Field label="Entry IDs" hint="FPL team IDs, separated by commas, spaces or new lines.">
                <textarea rows={3} className={inputClass} value={entryText} onChange={(e) => setEntryText(e.target.value)} />
              </Field>
              {parsed.bad.length > 0 && <Notice>Not entry IDs: {parsed.bad.join(', ')}</Notice>}
              <Button variant="secondary" disabled={parsed.ids.length === 0 || validate.isPending} onClick={() => validate.mutate()}>Check entries</Button>
              <ErrorBox error={validate.error} title="Check failed" />
              {validate.data?.invalid.length > 0 && <Notice>Unknown on FPL: {validate.data.invalid.join(', ')}</Notice>}
            </div>
          )}

          {candidates.length > 0 && (
            <Field label="Me (optional)" hint="Highlights your team in tables; your rivals are everyone else.">
              <select className={inputClass} value={myEntryId} onChange={(e) => setMyEntryId(e.target.value)}>
                <option value="">—</option>
                {candidates.map((c) => <option key={c.entryId} value={c.entryId}>{c.teamName} ({c.playerName})</option>)}
              </select>
            </Field>
          )}

          <Field label="Winner rule" hint="Net subtracts transfer-hit points; gross does not.">
            <select className={inputClass} value={winnerRule} onChange={(e) => setWinnerRule(e.target.value)}>
              <option value="NET_POINTS">Net points (after hits)</option>
              <option value="GROSS_POINTS">Gross points (before hits)</option>
            </select>
          </Field>

          <fieldset className="text-sm">
            <legend className="font-medium text-slate-800">Tie-breaks, in order</legend>
            <p className="text-xs text-slate-500">Only documented rules. A tie still unresolved at the end is shared.</p>
            <ol className="mt-2 space-y-1">
              {rules.map((r, i) => (
                <li key={r} className="flex items-center gap-2">
                  <span className="w-5 text-slate-500">{i + 1}.</span><span className="flex-1">{explain(r)}</span>
                  <Button variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${r} up`}>↑</Button>
                  <Button variant="ghost" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${r} down`}>↓</Button>
                  <Button variant="ghost" onClick={() => toggleRule(r)}>Remove</Button>
                </li>
              ))}
              <li className="flex items-center gap-2 text-slate-500"><span className="w-5">{rules.length + 1}.</span>Shared</li>
            </ol>
            <div className="mt-2 flex flex-wrap gap-2">
              {RULE_OPTIONS.filter((r) => !rules.includes(r)).map((r) => <Button key={r} variant="secondary" onClick={() => toggleRule(r)}>+ {explain(r)}</Button>)}
            </div>
          </fieldset>

          <ErrorBox error={create.error} title="Could not create the group" />
          <Button type="submit" disabled={!canCreate || create.isPending}>{create.isPending ? 'Creating…' : 'Create group'}</Button>
        </form>
      </Card>
    </div>
  );
}
