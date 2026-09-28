import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { endpoints, shareLink } from '../lib/api.js';
import { explain, parseEntryIds, tieBreakChain } from '../lib/format.js';
import { useNames } from '../lib/useNames.js';
import { Badge, Button, Card, ErrorBox, Field, Notice, Table, inputClass } from '../components/ui.jsx';

// Group settings (admin; v0.2 §5, §10). Members are never removed: excluded or
// marked instead. Archiving makes the group read-only; nothing is deleted.
const RULE_OPTIONS = ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'HIGHER_CAPTAIN_POINTS', 'NO_CHIP_PLAYED'];

export default function Settings({ group, season, gw }) {
  const qc = useQueryClient();
  const name = useNames(group, season, gw ?? 1);
  const done = () => Promise.all([qc.invalidateQueries({ queryKey: ['group', group.id] }), qc.invalidateQueries({ queryKey: ['groups'] }), qc.invalidateQueries({ queryKey: ['result', group.id] })]);
  const ro = !group.isActive;

  const [form, setForm] = useState({ name: group.name, winnerRule: group.winnerRule, myEntryId: group.myEntryId ?? '', rules: group.tieBreakRules.filter((r) => r !== 'SHARED') });
  const save = useMutation({
    mutationFn: () => endpoints.updateGroup(group.id, { name: form.name.trim(), winnerRule: form.winnerRule, myEntryId: form.myEntryId === '' ? null : Number(form.myEntryId), tieBreakRules: tieBreakChain(form.rules) }),
    onSuccess: done,
  });
  const toManual = useMutation({ mutationFn: () => endpoints.updateGroup(group.id, { memberSource: 'MANUAL' }), onSuccess: done });
  const member = useMutation({ mutationFn: ({ entryId, isExcluded }) => endpoints.updateMember(group.id, entryId, { isExcluded }), onSuccess: done });
  const [addText, setAddText] = useState('');
  const add = useMutation({ mutationFn: () => endpoints.addMembers(group.id, parseEntryIds(addText).ids), onSuccess: () => { setAddText(''); return done(); } });
  const [token, setToken] = useState(null);
  const rotate = useMutation({ mutationFn: () => endpoints.rotateShare(group.id), onSuccess: (d) => { setToken(d.shareToken); return done(); } });
  const revoke = useMutation({ mutationFn: () => endpoints.revokeShare(group.id), onSuccess: () => { setToken(null); return done(); } });
  const archive = useMutation({ mutationFn: () => (group.isActive ? endpoints.archive(group.id) : endpoints.unarchive(group.id)), onSuccess: done });

  const move = (i, d) => setForm((f) => { const n = [...f.rules]; [n[i], n[i + d]] = [n[i + d], n[i]]; return { ...f, rules: n }; });
  const toggle = (r) => setForm((f) => ({ ...f, rules: f.rules.includes(r) ? f.rules.filter((x) => x !== r) : [...f.rules, r] }));
  const link = token ? shareLink(window.location.origin, token) : null;
  const parsedAdd = parseEntryIds(addText);

  return (
    <div className="space-y-4">
      {ro && <Notice>This group is archived: settings are read-only until you unarchive it.</Notice>}
      <Card title="Group">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field label="Name"><input className={inputClass} disabled={ro} value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Winner rule">
            <select className={inputClass} disabled={ro} value={form.winnerRule} onChange={(e) => setForm({ ...form, winnerRule: e.target.value })}>
              <option value="NET_POINTS">Net points (after hits)</option><option value="GROSS_POINTS">Gross points (before hits)</option>
            </select>
          </Field>
          <Field label="Me">
            <select className={inputClass} disabled={ro} value={form.myEntryId} onChange={(e) => setForm({ ...form, myEntryId: e.target.value })}>
              <option value="">—</option>
              {group.members.map((m) => <option key={m.entryId} value={m.entryId}>{name(m.entryId)}</option>)}
            </select>
          </Field>
          <fieldset className="text-sm">
            <legend className="font-medium">Tie-breaks, in order</legend>
            <ol className="mt-1 space-y-1">
              {form.rules.map((r, i) => (
                <li key={r} className="flex items-center gap-2"><span className="w-5 text-slate-500">{i + 1}.</span><span className="flex-1">{explain(r)}</span>
                  <Button variant="ghost" disabled={ro || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${r} up`}>↑</Button>
                  <Button variant="ghost" disabled={ro || i === form.rules.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${r} down`}>↓</Button>
                  <Button variant="ghost" disabled={ro} onClick={() => toggle(r)}>Remove</Button></li>
              ))}
              <li className="flex gap-2 text-slate-500"><span className="w-5">{form.rules.length + 1}.</span>Shared</li>
            </ol>
            <div className="mt-2 flex flex-wrap gap-2">{RULE_OPTIONS.filter((r) => !form.rules.includes(r)).map((r) => <Button key={r} variant="secondary" disabled={ro} onClick={() => toggle(r)}>+ {explain(r)}</Button>)}</div>
          </fieldset>
          <ErrorBox error={save.error} title="Could not save" />
          {save.isSuccess && <Notice tone="good">Saved.</Notice>}
          <Button type="submit" disabled={ro || save.isPending || !form.name.trim()}>Save</Button>
        </form>
      </Card>

      <Card title={`Members (${group.members.length})`}>
        <p className="mb-2 text-sm text-slate-600">
          {group.memberSource === 'MANUAL' ? 'Manual list.' : `From league ${group.fplLeagueId}; syncs add new league members and mark leavers.`} Members are never removed; exclude them instead.
        </p>
        <Table testId="members">
          <tbody className="divide-y divide-slate-100">
            {group.members.map((m) => (
              <tr key={m.entryId}>
                <td className="py-1.5 pr-2">{name(m.entryId)}</td>
                <td className="pr-2 text-xs">{m.leftLeague && <Badge tone="neutral">left league</Badge>} {m.addedManually && <Badge tone="neutral">manual</Badge>} {m.isExcluded && <Badge tone="warn">excluded</Badge>}</td>
                <td className="text-right"><Button variant="ghost" disabled={ro || member.isPending} onClick={() => member.mutate({ entryId: m.entryId, isExcluded: !m.isExcluded })}>{m.isExcluded ? 'Include' : 'Exclude'}</Button></td>
              </tr>
            ))}
          </tbody>
        </Table>
        <ErrorBox error={member.error} />
        <div className="mt-3 flex gap-2">
          <input aria-label="Entry IDs to add" placeholder="Add entry IDs" className={inputClass} disabled={ro} value={addText} onChange={(e) => setAddText(e.target.value)} />
          <Button variant="secondary" disabled={ro || parsedAdd.ids.length === 0 || parsedAdd.bad.length > 0 || add.isPending} onClick={() => add.mutate()}>Add</Button>
        </div>
        <ErrorBox error={add.error} title="Could not add members" />
        {group.memberSource === 'LEAGUE_STANDINGS' && (
          <div className="mt-3 text-sm">
            <p className="text-slate-600">If FPL starts requiring a login for this league's standings, switch to a manual list. The current members are kept.</p>
            <Button variant="secondary" className="mt-2" disabled={ro || toManual.isPending} onClick={() => { if (window.confirm('Switch this group to a manual member list? This cannot be switched back.')) toManual.mutate(); }}>Switch to manual members</Button>
            <ErrorBox error={toManual.error} />
          </div>
        )}
      </Card>

      <Card title="Share with viewers">
        <p className="text-sm text-slate-600">Anyone with the link can read this group's results, ownership and chips. Creating a new link revokes the old one.</p>
        {link && (
          <div className="mt-2 space-y-2">
            <input readOnly aria-label="Share link" className={`${inputClass} font-mono text-xs`} value={link} data-testid="share-link" onFocus={(e) => e.target.select()} />
            <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(link)}>Copy link</Button>
          </div>
        )}
        {!link && group.shareToken && <p className="mt-2 text-sm">A link is active. Create a new one to see it again (the old one stops working).</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" disabled={ro || rotate.isPending} onClick={() => rotate.mutate()} data-testid="rotate-share">{group.shareToken ? 'New link' : 'Create link'}</Button>
          {group.shareToken && <Button variant="danger" disabled={ro || revoke.isPending} onClick={() => revoke.mutate()}>Revoke</Button>}
        </div>
        <ErrorBox error={rotate.error ?? revoke.error} />
      </Card>

      <Card title={group.isActive ? 'Archive' : 'Unarchive'}>
        <p className="text-sm text-slate-600">{group.isActive ? 'Archiving stops syncs and decisions. Everything stays readable; nothing is deleted.' : 'Unarchive to sync and decide results again.'}</p>
        <Button variant={group.isActive ? 'danger' : 'primary'} className="mt-2" disabled={archive.isPending} onClick={() => { if (!group.isActive || window.confirm(`Archive “${group.name}”?`)) archive.mutate(); }}>{group.isActive ? 'Archive group' : 'Unarchive group'}</Button>
        <ErrorBox error={archive.error} />
      </Card>
    </div>
  );
}
