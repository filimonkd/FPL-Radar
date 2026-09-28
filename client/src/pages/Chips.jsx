import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api.js';
import { explain } from '../lib/format.js';
import { useNames } from '../lib/useNames.js';
import { Badge, Card, ErrorBox, Notice, Spinner, Table } from '../components/ui.jsx';

// Chips page (v0.2 §8, Step 11 API): rule source badge, this GW's chip state
// per manager (never "no chip" from missing data), and availability per window.
const STATE_TEXT = {
  PLAYED: 'Played',
  NONE: 'No chip',
  ACTIVE_UNCONFIRMED: 'Active in squad, not yet in history',
  SOURCE_DISAGREEMENT: 'FPL sources disagree',
  UNKNOWN: 'Unknown',
};

export default function Chips({ group, season, gw }) {
  const chips = useQuery({ queryKey: ['chips', group.id, season, gw], queryFn: () => endpoints.chips(group.id, season, gw) });
  const name = useNames(group, season, gw);
  if (chips.isLoading) return <Spinner />;
  if (chips.error) return <ErrorBox error={chips.error} title="Chips unavailable" />;
  const c = chips.data.chips;
  const chipNames = [...new Set((c.rules?.rules ?? []).map((r) => r.chipName))];
  const label = (n) => c.rules?.rules.find((r) => r.chipName === n)?.label ?? n;

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2">Chips · GW{c.event} {c.rules && <Badge tone={c.rules.source === 'FPL_BOOTSTRAP' ? 'good' : 'warn'} testId="chip-source">{c.rules.source === 'FPL_BOOTSTRAP' ? 'Rules from FPL' : 'Fallback rules'}</Badge>}</span>}>
        {c.provisional && <Notice>Provisional: GW{c.event} is not data-checked yet.</Notice>}
        {c.warnings.map((w, i) => <Notice key={i}>{explain(w.code)}</Notice>)}
        {c.missingEntryIds.length > 0 && <Notice>Not synced: {c.missingEntryIds.map(name).join(', ')}</Notice>}
        <Table testId="chip-states">
          <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-2">Manager</th><th className="pr-2">This GW</th><th>Effect</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {c.gameweek.map((m) => (
              <tr key={m.entryId}>
                <td className="py-1.5 pr-2">{name(m.entryId)}{m.isExcluded && <> <Badge tone="neutral">excluded</Badge></>}</td>
                <td className="pr-2"><Badge status={m.state}>{STATE_TEXT[m.state] ?? m.state}</Badge> {m.declaredLabel ?? m.squadChipLabel ?? ''}{m.reason ? <span className="text-xs text-slate-500"> ({m.reason})</span> : null}</td>
                <td className="text-xs text-slate-600">{m.applied ? (m.applied.unknownChip ? 'Unknown chip: no effect applied' : m.applied.scoringEffect.replace('_', ' ').toLowerCase()) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card title="Availability">
        {!c.availability ? <p className="text-sm text-slate-600">Chip rules are unavailable, so availability is not shown (nothing is invented).</p> : (
          <Table testId="chip-availability">
            <thead className="text-xs uppercase text-slate-500">
              <tr><th className="py-2 pr-2">Manager</th>{chipNames.map((n) => <th key={n} className="pr-2">{label(n)}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {c.availability.managers.map((m) => (
                <tr key={m.entryId}>
                  <td className="py-1.5 pr-2">{name(m.entryId)}</td>
                  {chipNames.map((n) => {
                    const cur = m.chips.find((x) => x.chipName === n && x.current) ?? m.chips.find((x) => x.chipName === n);
                    return <td key={n} className="pr-2">{cur ? <Badge tone={cur.available ? 'good' : 'neutral'}>{cur.available ? 'available' : `used GW${cur.playedEvents?.join(', ') || '?'}`}</Badge> : '–'}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {c.availability?.managers.some((m) => m.unmapped.length) && <Notice>Unrecognised chips are listed by their FPL name and not counted against any window.</Notice>}
      </Card>
    </div>
  );
}
