import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Copy, Link as LinkIcon, Plus, Share2 } from 'lucide-react';
import { endpoints, shareLink } from '../lib/api.js';
import { parseEntryIds, tieBreakChain } from '../lib/format.js';
import { useNames } from '../lib/useNames.js';
import { Avatar, Badge, Button, Card, ErrorBox, Field, Notice, Segmented, inputClass } from '../components/ui.jsx';
import { RuleChain } from '../components/RuleChain.jsx';

// Group settings (admin; v0.2 §5, §10). Members are never removed: excluded or
// marked instead. Archiving makes the group read-only; nothing is deleted.
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

  const link = token ? shareLink(window.location.origin, token) : null;
  const parsedAdd = parseEntryIds(addText);

  return (
    <div className="space-y-4">
      {ro && <Notice>This group is archived: settings are read-only until you unarchive it.</Notice>}
      <Card title="Group">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field label="Name"><input className={inputClass} disabled={ro} value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <div>
            <p className="mb-2 text-sm font-semibold">Winner rule</p>
            <Segmented label="Winner rule" value={form.winnerRule} onChange={(v) => !ro && setForm({ ...form, winnerRule: v })} options={[['NET_POINTS', 'Net points'], ['GROSS_POINTS', 'Gross points']]} />
          </div>
          <Field label="Me">
            <select className={inputClass} disabled={ro} value={form.myEntryId} onChange={(e) => setForm({ ...form, myEntryId: e.target.value })}>
              <option value="">—</option>
              {group.members.map((m) => <option key={m.entryId} value={m.entryId}>{name(m.entryId)}</option>)}
            </select>
          </Field>
          <RuleChain rules={form.rules} onChange={(rules) => setForm({ ...form, rules })} disabled={ro} />
          <ErrorBox error={save.error} title="Could not save" />
          {save.isSuccess && <Notice tone="good">Saved.</Notice>}
          <Button type="submit" className="w-full sm:w-auto" disabled={ro || save.isPending || !form.name.trim()}>Save changes</Button>
        </form>
      </Card>

      <Card title={`Members (${group.members.length})`} subtitle={`${group.memberSource === 'MANUAL' ? 'Manual list.' : `From league ${group.fplLeagueId}; syncs add new members and mark leavers.`} Members are never removed; exclude them instead.`} padded={false}>
        <ul className="divide-y divide-line" data-testid="members">
          {group.members.map((m) => (
            <li key={m.entryId} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
              <Avatar name={name(m.entryId)} id={m.entryId} size={32} />
              <div className="min-w-0 flex-1">
                <p className={`truncate text-sm font-semibold ${m.isExcluded ? 'text-muted line-through' : ''}`}>{name(m.entryId)}</p>
                <p className="flex flex-wrap gap-1">{m.leftLeague && <Badge tone="neutral">left league</Badge>}{m.addedManually && <Badge tone="neutral">manual</Badge>}{m.isExcluded && <Badge tone="warn">excluded</Badge>}</p>
              </div>
              <Button variant="ghost" size="sm" disabled={ro || member.isPending} onClick={() => member.mutate({ entryId: m.entryId, isExcluded: !m.isExcluded })}>{m.isExcluded ? 'Include' : 'Exclude'}</Button>
            </li>
          ))}
        </ul>
        <div className="space-y-2 border-t border-line px-4 py-3 sm:px-5">
          <ErrorBox error={member.error} />
          <div className="flex gap-2">
            <input aria-label="Entry IDs to add" placeholder="Add entry IDs" className={inputClass} disabled={ro} value={addText} onChange={(e) => setAddText(e.target.value)} />
            <Button variant="secondary" icon={Plus} disabled={ro || parsedAdd.ids.length === 0 || parsedAdd.bad.length > 0 || add.isPending} onClick={() => add.mutate()}>Add</Button>
          </div>
          <ErrorBox error={add.error} title="Could not add members" />
          {group.memberSource === 'LEAGUE_STANDINGS' && (
            <div className="pt-2 text-sm">
              <p className="text-muted">If FPL starts requiring a login for this league's standings, switch to a manual list. The current members are kept.</p>
              <Button variant="secondary" size="sm" className="mt-2" disabled={ro || toManual.isPending} onClick={() => { if (window.confirm('Switch this group to a manual member list? This cannot be switched back.')) toManual.mutate(); }}>Switch to manual members</Button>
              <ErrorBox error={toManual.error} />
            </div>
          )}
        </div>
      </Card>

      <Card title="Share with viewers" subtitle="Anyone with the link can read this group's results, ownership and chips. A new link revokes the old one.">
        {link && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-xl bg-surface-2 p-2 ring-1 ring-line">
              <LinkIcon size={16} className="ml-1 shrink-0 text-muted" aria-hidden="true" />
              <input readOnly aria-label="Share link" className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none" value={link} data-testid="share-link" onFocus={(e) => e.target.select()} />
              <Button size="sm" variant="secondary" icon={Copy} onClick={() => navigator.clipboard?.writeText(link)}>Copy</Button>
            </div>
            {typeof navigator !== 'undefined' && navigator.share && (
              <Button size="sm" variant="ghost" icon={Share2} onClick={() => navigator.share({ title: group.name, url: link }).catch(() => {})}>Share…</Button>
            )}
          </div>
        )}
        {!link && group.shareToken && <p className="text-sm text-muted">A link is active. Create a new one to see it again (the old one stops working).</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" icon={LinkIcon} disabled={ro || rotate.isPending} onClick={() => rotate.mutate()} data-testid="rotate-share">{group.shareToken ? 'New link' : 'Create link'}</Button>
          {group.shareToken && <Button variant="danger" disabled={ro || revoke.isPending} onClick={() => revoke.mutate()}>Revoke</Button>}
        </div>
        <ErrorBox error={rotate.error ?? revoke.error} />
      </Card>

      <Card title={group.isActive ? 'Archive' : 'Unarchive'} subtitle={group.isActive ? 'Archiving stops syncs and decisions. Everything stays readable; nothing is deleted.' : 'Unarchive to sync and decide results again.'}>
        <Button variant={group.isActive ? 'danger' : 'primary'} icon={group.isActive ? Archive : ArchiveRestore} disabled={archive.isPending} onClick={() => { if (!group.isActive || window.confirm(`Archive “${group.name}”?`)) archive.mutate(); }}>{group.isActive ? 'Archive group' : 'Unarchive group'}</Button>
        <ErrorBox error={archive.error} />
      </Card>
    </div>
  );
}
